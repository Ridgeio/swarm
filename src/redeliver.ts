import type { SwarmDb } from './db.js';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { deliverToAgent } from './transport-router.js';
import { getAgent } from './registry.js';
import { swarmTagFor, type Message } from './mailbox.js';

// A queued (push-failed) message is only worth re-pushing while the conversation
// that produced it is still live. Past this window the work has moved on — the
// message stays inbox-readable (cursor-based) but is never re-pushed, so a sweep
// can't resurface stale context into a busy agent's prompt.
export const REDELIVER_WINDOW_MS = 30 * 60 * 1000;

export interface RedeliverResult {
  eligible: number;
  redelivered: number;
  attempted: number;
}

type DeliverFn = typeof deliverToAgent;

interface RedeliverOptions {
  dryRun?: boolean;
  deliver?: DeliverFn; // injectable for tests — never push at real surfaces from a test
}

/**
 * Re-push messages whose original push failed ("queued for inbox") but that the
 * recipient has provably NOT seen yet. Eligibility is deliberately strict:
 *   - delivered = 0 (the push failed; inbox pickup was the fallback)
 *   - direct messages only (broadcast rows share one global delivered bit,
 *     so per-recipient redelivery state doesn't exist for them)
 *   - recipient's inbox cursor has NOT passed the message (cursor-passed means
 *     the hook/inbox already surfaced it — re-pushing would duplicate)
 *   - younger than REDELIVER_WINDOW_MS (never resurface resolved work)
 *
 * A2A recipients are eligible too: a failed a2a push is reported to the sender
 * as queued (mailbox.ts), so the retry here is the delivery path — it covers
 * a remote endpoint that was briefly down (service restart, network blip).
 *
 * Concurrency-safe: each message is claimed with an atomic
 * `UPDATE ... WHERE delivered = 0` before pushing and reverted on push failure,
 * so overlapping sweeps (hook + worker) can't double-deliver.
 */
export async function redeliverPending(
  db: SwarmDb,
  options: RedeliverOptions = {}
): Promise<RedeliverResult> {
  const deliver = options.deliver ?? deliverToAgent;
  const cutoff = new Date(Date.now() - REDELIVER_WINDOW_MS).toISOString();

  const eligible = db.prepare(`
    SELECT m.* FROM messages m
    JOIN agents a
      ON a.swarm_id = m.swarm_id AND a.name = m.to_agent COLLATE NOCASE
    LEFT JOIN inbox_cursors c
      ON c.swarm_id = m.swarm_id AND c.agent_name = m.to_agent COLLATE NOCASE
    WHERE m.delivered = 0
      AND m.to_agent IS NOT NULL
      AND m.id > COALESCE(c.last_read_id, 0)
      AND m.created_at > ?
    ORDER BY m.id ASC
  `).all(cutoff) as unknown as Message[];

  const result: RedeliverResult = { eligible: eligible.length, redelivered: 0, attempted: 0 };
  if (options.dryRun) return result;

  const claim = db.prepare('UPDATE messages SET delivered = 1 WHERE id = ? AND delivered = 0');
  const revert = db.prepare('UPDATE messages SET delivered = 0 WHERE id = ?');

  for (const msg of eligible) {
    // Atomic claim — a concurrent sweep that got here first wins, we skip.
    if (Number(claim.run(msg.id).changes) === 0) continue;

    const target = getAgent(db, msg.swarm_id, msg.to_agent!);
    if (!target) {
      // Recipient left between the SELECT and now — leave it claimed (nothing to push at).
      continue;
    }

    result.attempted++;
    const formatted = `[SWARM from ${msg.from_agent}${swarmTagFor(db, target, msg.swarm_id)}]: ${msg.body}`;
    try {
      const delivery = await deliver(target, formatted);
      if (delivery.delivered) {
        result.redelivered++;
      } else {
        revert.run(msg.id); // stays queued for the next sweep (until it ages out)
      }
    } catch {
      revert.run(msg.id);
    }
  }

  return result;
}

// --- Detached retry worker -------------------------------------------------
//
// The sweep only runs when *some* swarm CLI invocation happens — but the exact
// failure mode observed in the field is a fully idle swarm: a push fails, every
// agent is waiting on that message, and nobody invokes anything for an hour.
// So on a push failure the sender's CLI spawns ONE short-lived detached worker
// that retries on a backoff schedule and exits as soon as the queue drains
// (or after the last delay, when remaining messages are near the age-out window).

// Tight early retries catch the recipient's first idle window fast (once a busy
// surface stops throwing broken pipe, the push lands); the long tail keeps trying
// for a recipient that stays busy or goes idle without taking another turn. Total
// span ~17 min. Active recipients recover sooner via their own inbox hook; this
// worker is the safety net for the idle case that the hook can't cover.
const WORKER_DELAYS_SEC = [0, 3, 7, 15, 30, 60, 120, 240, 480];
const WORKER_LOCK = path.join(os.homedir(), '.swarm', 'locks', 'redeliver-worker.lock');
const WORKER_LOCK_STALE_MS = 10 * 60 * 1000;

function tryAcquireWorkerLock(): boolean {
  fs.mkdirSync(path.dirname(WORKER_LOCK), { recursive: true });
  try {
    fs.mkdirSync(WORKER_LOCK);
  } catch {
    try {
      const stat = fs.statSync(WORKER_LOCK);
      if (Date.now() - stat.mtimeMs <= WORKER_LOCK_STALE_MS) return false; // live worker
      fs.rmSync(WORKER_LOCK, { recursive: true, force: true });
      fs.mkdirSync(WORKER_LOCK);
    } catch {
      return false;
    }
  }
  try { fs.writeFileSync(path.join(WORKER_LOCK, 'pid'), String(process.pid)); } catch {}
  return true;
}

function releaseWorkerLock(): void {
  try { fs.rmSync(WORKER_LOCK, { recursive: true, force: true }); } catch {}
}

export async function runRedeliverWorker(db: SwarmDb): Promise<void> {
  if (!tryAcquireWorkerLock()) return; // another worker is already on it
  try {
    for (const delaySec of WORKER_DELAYS_SEC) {
      if (delaySec > 0) await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
      try { fs.utimesSync(WORKER_LOCK, new Date(), new Date()); } catch {}
      const { eligible } = await redeliverPending(db);
      if (eligible === 0) return; // drained (or everything aged out)
    }
  } finally {
    releaseWorkerLock();
  }
}

/** Fire-and-forget a detached retry worker (no-op if spawn fails). */
export function spawnRedeliverWorker(): void {
  try {
    const child = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1], 'redeliver', '--worker'],
      { detached: true, stdio: 'ignore', env: process.env }
    );
    child.unref();
  } catch {}
}

/** Cheap check used by hook-context/inbox: anything worth redelivering? */
export function hasPendingRedeliveries(db: SwarmDb): boolean {
  const cutoff = new Date(Date.now() - REDELIVER_WINDOW_MS).toISOString();
  const row = db.prepare(`
    SELECT m.id FROM messages m
    JOIN agents a
      ON a.swarm_id = m.swarm_id AND a.name = m.to_agent COLLATE NOCASE
    LEFT JOIN inbox_cursors c
      ON c.swarm_id = m.swarm_id AND c.agent_name = m.to_agent COLLATE NOCASE
    WHERE m.delivered = 0
      AND m.to_agent IS NOT NULL
      AND m.id > COALESCE(c.last_read_id, 0)
      AND m.created_at > ?
    LIMIT 1
  `).get(cutoff);
  return row !== undefined;
}
