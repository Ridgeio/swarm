import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { withImmediateTransaction, type SwarmDb } from './db.js';
import { requireActiveAgent, requireSwarmAuthority } from './authority.js';

interface StandDownTarget {
  id: string;
  name: string;
  agent_type: string;
  ppid: number;
  process_fingerprint: string | null;
}

export interface ProcessIdentity {
  pid: number;
  ppid: number;
  startedAt: string;
  command: string;
  fingerprint: string;
}

export interface ProcessTreeController {
  snapshot(): ProcessIdentity[];
  signal(pid: number, signal: NodeJS.Signals): void;
  wait(milliseconds: number): Promise<void>;
  currentPid: number;
}

export interface StandDownResult {
  targetAgentId: string;
  targetName: string;
  rootPid: number;
  treeSha256: string;
  terminatedPids: number[];
  verifiedAt: string;
}

function processFingerprint(pid: number, startedAt: string, command: string): string {
  // PPID is deliberately excluded: an exact child can be reparented while it
  // exits. PID + kernel start time + command protects against PID reuse while
  // remaining stable through that reparenting.
  return createHash('sha256')
    .update(JSON.stringify([pid, startedAt, command]))
    .digest('hex');
}

export function parseProcessSnapshot(output: string): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    const startedAt = match[3].replace(/\s+/g, ' ').trim();
    const command = match[4].trim();
    identities.push({
      pid,
      ppid,
      startedAt,
      command,
      fingerprint: processFingerprint(pid, startedAt, command),
    });
  }
  return identities;
}

export function processSnapshot(): ProcessIdentity[] {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,command='], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseProcessSnapshot(output);
  } catch {
    return [];
  }
}

export function captureProcessFingerprint(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  return processSnapshot().find(identity => identity.pid === pid)?.fingerprint ?? null;
}

const DEFAULT_CONTROLLER: ProcessTreeController = {
  snapshot: processSnapshot,
  signal: (pid, signal) => process.kill(pid, signal),
  wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  currentPid: process.pid,
};

function exactDescendants(snapshot: ProcessIdentity[], rootPid: number): ProcessIdentity[] {
  const byParent = new Map<number, ProcessIdentity[]>();
  for (const identity of snapshot) {
    const children = byParent.get(identity.ppid) ?? [];
    children.push(identity);
    byParent.set(identity.ppid, children);
  }
  const result: ProcessIdentity[] = [];
  const visit = (pid: number): void => {
    for (const child of byParent.get(pid) ?? []) {
      result.push(child);
      visit(child.pid);
    }
  };
  visit(rootPid);
  return result;
}

function treeDigest(identities: ProcessIdentity[]): string {
  return createHash('sha256')
    .update(JSON.stringify(
      [...identities]
        .sort((left, right) => left.pid - right.pid)
        .map(identity => ({
          pid: identity.pid,
          ppid: identity.ppid,
          fingerprint: identity.fingerprint,
        }))
    ))
    .digest('hex');
}

function liveExact(
  controller: ProcessTreeController,
  expected: Map<number, ProcessIdentity>
): ProcessIdentity[] {
  const current = new Map(controller.snapshot().map(identity => [identity.pid, identity]));
  return [...expected.values()].filter(identity =>
    current.get(identity.pid)?.fingerprint === identity.fingerprint
  );
}

async function waitForExactExit(
  controller: ProcessTreeController,
  expected: Map<number, ProcessIdentity>,
  attempts: number
): Promise<ProcessIdentity[]> {
  let remaining = liveExact(controller, expected);
  for (let attempt = 0; attempt < attempts && remaining.length > 0; attempt += 1) {
    await controller.wait(50);
    remaining = liveExact(controller, expected);
  }
  return remaining;
}

function signalIfExact(
  controller: ProcessTreeController,
  identity: ProcessIdentity,
  signal: NodeJS.Signals
): void {
  const current = controller.snapshot().find(candidate => candidate.pid === identity.pid);
  if (!current || current.fingerprint !== identity.fingerprint) return;
  try {
    controller.signal(identity.pid, signal);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw error;
  }
}

export async function terminateExactProcessTree(
  rootPid: number,
  expectedRootFingerprint: string,
  controller: ProcessTreeController = DEFAULT_CONTROLLER
): Promise<{ treeSha256: string; terminatedPids: number[] }> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1) {
    throw new Error(`Refused stand-down root PID ${rootPid}; expected an exact non-system process.`);
  }
  if (!/^[0-9a-f]{64}$/.test(expectedRootFingerprint)) {
    throw new Error('Refused stand-down without an exact captured root-process fingerprint. Rejoin the target first.');
  }
  const snapshot = controller.snapshot();
  const root = snapshot.find(identity => identity.pid === rootPid);
  if (!root || root.fingerprint !== expectedRootFingerprint) {
    throw new Error(
      `Refused stand-down: PID ${rootPid} is absent or no longer matches its captured process identity.`
    );
  }
  const tree = [root, ...exactDescendants(snapshot, rootPid)];
  if (tree.some(identity => identity.pid === controller.currentPid)) {
    throw new Error(
      'Refused stand-down from inside the target process tree. Run it from an unrelated Owner/Lead session.'
    );
  }
  const expected = new Map(tree.map(identity => [identity.pid, identity]));
  const digest = treeDigest(tree);
  // Descendants first, root last. Every signal is preceded by the immutable
  // PID/start-time/command comparison, so a reused PID or unrelated process is
  // never signalled merely because its numeric PID matches the snapshot.
  for (const identity of [...tree].reverse()) signalIfExact(controller, identity, 'SIGTERM');
  let remaining = await waitForExactExit(controller, expected, 20);
  for (const identity of remaining) signalIfExact(controller, identity, 'SIGKILL');
  remaining = await waitForExactExit(controller, expected, 20);
  if (remaining.length > 0) {
    throw new Error(
      `Stand-down verification failed; exact processes still live: ${remaining.map(identity => identity.pid).join(', ')}.`
    );
  }
  return { treeSha256: digest, terminatedPids: tree.map(identity => identity.pid).sort((a, b) => a - b) };
}

export async function standDownAgent(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  targetName: string,
  controller: ProcessTreeController = DEFAULT_CONTROLLER,
  now: Date = new Date()
): Promise<StandDownResult> {
  const issuer = requireSwarmAuthority(db, swarmId, actor, 'stand down exact process tree');
  const target = requireActiveAgent(
    db,
    swarmId,
    targetName,
    'stand down exact process tree'
  ) as StandDownTarget;
  if (target.agent_type === 'a2a') {
    throw new Error('A2A registrations have no local process tree; use swarm unregister-a2a instead.');
  }
  if (!target.process_fingerprint) {
    throw new Error(
      `Agent ${target.name} has no captured process fingerprint; it cannot be claimed as verified stand-down. Rejoin it first.`
    );
  }
  const terminated = await terminateExactProcessTree(
    target.ppid,
    target.process_fingerprint,
    controller
  );
  const verifiedAt = now.toISOString();
  return withImmediateTransaction(db, () => {
    const currentIssuer = requireSwarmAuthority(db, swarmId, actor, 'record verified stand-down');
    if (currentIssuer.agent.id !== issuer.agent.id) {
      throw new Error('Stand-down issuer registration changed before verification could be recorded.');
    }
    const current = db.prepare(`
      SELECT id FROM agents WHERE swarm_id = ? AND name = ? COLLATE NOCASE
    `).get(swarmId, target.name) as { id: string } | undefined;
    if (!current || current.id !== target.id) {
      throw new Error('Target registration changed before verified stand-down could be recorded.');
    }
    db.prepare(`
      INSERT INTO stand_down_events (
        swarm_id, target_agent_id, target_name, requested_by_agent_id,
        root_pid, root_fingerprint, tree_sha256, terminated_pids, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      swarmId,
      target.id,
      target.name,
      issuer.agent.id,
      target.ppid,
      target.process_fingerprint,
      terminated.treeSha256,
      JSON.stringify(terminated.terminatedPids),
      verifiedAt
    );
    db.prepare('DELETE FROM agents WHERE swarm_id = ? AND id = ?').run(swarmId, target.id);
    return {
      targetAgentId: target.id,
      targetName: target.name,
      rootPid: target.ppid,
      treeSha256: terminated.treeSha256,
      terminatedPids: terminated.terminatedPids,
      verifiedAt,
    };
  }) as StandDownResult;
}
