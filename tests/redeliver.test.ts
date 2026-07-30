import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SwarmDb } from '../src/db.js';
import { getDbAt } from '../src/db.js';
import { redeliverPending, hasPendingRedeliveries, REDELIVER_WINDOW_MS } from '../src/redeliver.js';

// Unit tests for the redelivery sweep. Delivery is stubbed — these tests must
// NEVER push at a real cmux surface (the live swarm may be mid-session).

const SWARM = 'default';
let dir: string;
let db: SwarmDb;

function addAgent(name: string, type: 'cmux' | 'headless' | 'a2a' = 'cmux'): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agents (id, swarm_id, name, agent_type, surface_id, workspace_id, ppid, joined_at, last_heartbeat)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`agent-${name}`, SWARM, name, type, `surf-${name}`, `ws-${name}`, 0, now, now);
}

function addMessage(opts: {
  from: string; to: string | null; delivered?: number; ageMs?: number; body?: string;
}): number {
  const createdAt = new Date(Date.now() - (opts.ageMs ?? 0)).toISOString();
  const result = db.prepare(
    'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(SWARM, opts.from, opts.to, opts.body ?? 'hello', opts.delivered ?? 0, createdAt);
  return Number(result.lastInsertRowid);
}

function setCursor(agent: string, lastReadId: number): void {
  db.prepare('INSERT OR REPLACE INTO inbox_cursors (swarm_id, agent_name, last_read_id) VALUES (?, ?, ?)')
    .run(SWARM, agent, lastReadId);
}

function deliveredFlag(id: number): number {
  return (db.prepare('SELECT delivered FROM messages WHERE id = ?').get(id) as { delivered: number }).delivered;
}

const deliverOk = async () => ({ delivered: true });
const deliverFail = async () => ({ delivered: false, error: 'surface gone' });

describe('redeliverPending', () => {
  beforeEach(() => {
    if (db) db.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'swarm-redeliver-'));
    db = getDbAt(join(dir, 'swarm.db'));
    addAgent('Alice');
    addAgent('Bob');
  });

  after(() => {
    if (db) db.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('re-pushes a fresh, unseen, push-failed direct message and marks it delivered', async () => {
    const id = addMessage({ from: 'Alice', to: 'Bob' });
    const pushed: string[] = [];
    const result = await redeliverPending(db, {
      deliver: async (_agent, text) => { pushed.push(text); return { delivered: true }; },
    });
    assert.deepStrictEqual(result, { eligible: 1, redelivered: 1, attempted: 1 });
    assert.strictEqual(deliveredFlag(id), 1);
    assert.match(pushed[0], /^\[SWARM from Alice\]: hello$/);
  });

  test('skips messages the recipient cursor has already passed (already seen via hook)', async () => {
    const id = addMessage({ from: 'Alice', to: 'Bob' });
    setCursor('Bob', id); // Bob's hook consumed it — re-pushing would duplicate
    const result = await redeliverPending(db, { deliver: deliverOk });
    assert.strictEqual(result.eligible, 0);
    assert.strictEqual(deliveredFlag(id), 0); // untouched
  });

  test('skips stale messages older than the redelivery window', async () => {
    addMessage({ from: 'Alice', to: 'Bob', ageMs: REDELIVER_WINDOW_MS + 60_000 });
    const result = await redeliverPending(db, { deliver: deliverOk });
    assert.strictEqual(result.eligible, 0);
  });

  test('skips broadcast rows and already-delivered messages', async () => {
    addMessage({ from: 'Alice', to: null });                 // broadcast
    addMessage({ from: 'Alice', to: 'Bob', delivered: 1 });  // push already succeeded
    const result = await redeliverPending(db, { deliver: deliverOk });
    assert.strictEqual(result.eligible, 0);
  });

  test('retries queued a2a recipients (endpoint may have been briefly down)', async () => {
    addAgent('Remote', 'a2a');
    const id = addMessage({ from: 'Alice', to: 'Remote' }); // a2a push failed -> queued
    const result = await redeliverPending(db, { deliver: deliverOk });
    assert.deepStrictEqual(result, { eligible: 1, redelivered: 1, attempted: 1 });
    assert.strictEqual(deliveredFlag(id), 1);
  });

  test('never legacy-redelivers a resolved required request after its durable outbox is gone', async () => {
    const requestId = addMessage({ from: 'Alice', to: 'Bob', body: 'Need answer' });
    const replyId = addMessage({ from: 'Bob', to: 'Alice', body: 'Answer' });
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO required_message_responses (
        swarm_id, request_message_id, sender_agent_id, sender_name,
        recipient_agent_id, recipient_name, required_by, status, created_at,
        resolved_at, reply_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'resolved', ?, ?, ?)
    `).run(
      SWARM,
      requestId,
      'agent-Alice',
      'Alice',
      'agent-Bob',
      'Bob',
      new Date(Date.now() + 60_000).toISOString(),
      now,
      now,
      replyId
    );

    const pushed: string[] = [];
    assert.strictEqual(hasPendingRedeliveries(db), true, 'the ordinary reply remains eligible');
    const result = await redeliverPending(db, {
      deliver: async (_agent, text) => {
        pushed.push(text);
        return { delivered: true };
      },
    });

    assert.deepStrictEqual(result, { eligible: 1, redelivered: 1, attempted: 1 });
    assert.deepStrictEqual(pushed, ['[SWARM from Bob]: Answer']);
    assert.strictEqual(deliveredFlag(requestId), 0, 'required request stays outside the legacy path');
    assert.strictEqual(deliveredFlag(replyId), 1);
    assert.strictEqual(hasPendingRedeliveries(db), false);
  });

  test('cursor guard matches case-insensitively', async () => {
    const id = addMessage({ from: 'Alice', to: 'Bob' });
    setCursor('bob', id); // cursor stored with different casing must still count as seen
    const result = await redeliverPending(db, { deliver: deliverOk });
    assert.strictEqual(result.eligible, 0);
  });

  test('reverts the claim when the push fails, so the next sweep can retry', async () => {
    const id = addMessage({ from: 'Alice', to: 'Bob' });
    const r1 = await redeliverPending(db, { deliver: deliverFail });
    assert.deepStrictEqual(r1, { eligible: 1, redelivered: 0, attempted: 1 });
    assert.strictEqual(deliveredFlag(id), 0); // reverted — still queued

    const r2 = await redeliverPending(db, { deliver: deliverOk });
    assert.strictEqual(r2.redelivered, 1);
    assert.strictEqual(deliveredFlag(id), 1);
  });

  test('reverts the claim when the deliver fn throws', async () => {
    const id = addMessage({ from: 'Alice', to: 'Bob' });
    const result = await redeliverPending(db, {
      deliver: async () => { throw new Error('boom'); },
    });
    assert.strictEqual(result.redelivered, 0);
    assert.strictEqual(deliveredFlag(id), 0);
  });

  test('dry run reports eligibility without pushing or mutating anything', async () => {
    const id = addMessage({ from: 'Alice', to: 'Bob' });
    let pushes = 0;
    const result = await redeliverPending(db, {
      dryRun: true,
      deliver: async () => { pushes++; return { delivered: true }; },
    });
    assert.strictEqual(result.eligible, 1);
    assert.strictEqual(result.attempted, 0);
    assert.strictEqual(pushes, 0);
    assert.strictEqual(deliveredFlag(id), 0);
  });

  test('a concurrent claim wins — the second sweep skips without double-delivering', async () => {
    const id = addMessage({ from: 'Alice', to: 'Bob' });
    const result = await redeliverPending(db, {
      // Simulate a racing worker that claims the row before our push starts.
      deliver: async () => {
        db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?').run(id);
        return { delivered: true };
      },
    });
    // Our sweep claimed it first (claim is the atomic gate), so it delivers once.
    assert.strictEqual(result.redelivered, 1);

    // And a follow-up sweep finds nothing — no second push.
    const r2 = await redeliverPending(db, { deliver: deliverOk });
    assert.strictEqual(r2.eligible, 0);
  });

  test('hasPendingRedeliveries mirrors eligibility', async () => {
    assert.strictEqual(hasPendingRedeliveries(db), false);
    const id = addMessage({ from: 'Alice', to: 'Bob' });
    assert.strictEqual(hasPendingRedeliveries(db), true);
    setCursor('Bob', id);
    assert.strictEqual(hasPendingRedeliveries(db), false);
  });
});
