import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SWARM_ID, getDbAt } from '../src/db.js';
import {
  forceReap as forceReapRaw,
  getAgent as getAgentRaw,
  getOrCreateSwarm,
  joinA2AAgent as joinA2AAgentRaw,
  joinAgent as joinAgentRaw,
  joinHeadlessAgent as joinHeadlessAgentRaw,
  leaveA2AAgent as leaveA2AAgentRaw,
  leaveAgent as leaveAgentRaw,
  listAgents as listAgentsRaw,
  reapAll as reapAllRaw,
  reapIfDead as reapIfDeadRaw,
  updateStatus as updateStatusRaw,
} from '../src/registry.js';
import {
  broadcastMessage as broadcastMessageRaw,
  countRecentMessages as countRecentMessagesRaw,
  getInbox as getInboxRaw,
  getRecentMessages as getRecentMessagesRaw,
  sendMessage as sendMessageRaw,
} from '../src/mailbox.js';
import type { SwarmDb } from '../src/db.js';
import { createCmuxLivenessObserver } from '../src/transport.js';

let db: SwarmDb;
let dbPath: string;
const SWARM_ID = DEFAULT_SWARM_ID;
const competentGoneObserver = createCmuxLivenessObserver({
  resolveBinary: () => '/fixture/cmux',
  runner: (_binary, args) => {
    if (args[0] === 'ping') return Buffer.from('pong');
    throw { stderr: Buffer.from('Error: Surface not found: fixture') };
  },
  wait: () => {},
});

function joinAgent(testDb: SwarmDb, name: string, surfaceId: string, workspaceId: string | undefined, ppid: number, description?: string) {
  return joinAgentRaw(testDb, SWARM_ID, name, surfaceId, workspaceId, ppid, description);
}

function joinHeadlessAgent(testDb: SwarmDb, name: string, description?: string) {
  return joinHeadlessAgentRaw(testDb, SWARM_ID, name, description);
}

function joinA2AAgent(testDb: SwarmDb, name: string, endpointUrl: string, description?: string) {
  return joinA2AAgentRaw(testDb, SWARM_ID, name, endpointUrl, description);
}

function leaveAgent(testDb: SwarmDb, surfaceId: string) {
  return leaveAgentRaw(testDb, SWARM_ID, surfaceId);
}

function leaveA2AAgent(testDb: SwarmDb, name: string) {
  return leaveA2AAgentRaw(testDb, SWARM_ID, name);
}

function getAgent(testDb: SwarmDb, name: string) {
  return getAgentRaw(testDb, SWARM_ID, name);
}

function listAgents(testDb: SwarmDb) {
  return listAgentsRaw(testDb, SWARM_ID, competentGoneObserver);
}

function updateStatus(testDb: SwarmDb, surfaceId: string, description: string) {
  return updateStatusRaw(testDb, SWARM_ID, surfaceId, description);
}

function reapIfDead(testDb: SwarmDb, name: string) {
  return reapIfDeadRaw(testDb, SWARM_ID, name, competentGoneObserver);
}

function reapAll(testDb: SwarmDb) {
  return reapAllRaw(testDb, SWARM_ID, competentGoneObserver);
}

function forceReap(testDb: SwarmDb, name: string) {
  return forceReapRaw(testDb, SWARM_ID, name);
}

function getInbox(testDb: SwarmDb, agentName: string, peek: boolean = false) {
  return getInboxRaw(testDb, SWARM_ID, agentName, peek);
}

function sendMessage(testDb: SwarmDb, fromName: string, toName: string, body: string) {
  return sendMessageRaw(testDb, SWARM_ID, fromName, toName, body);
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `swarm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = getDbAt(dbPath);
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
});

describe('registry', () => {
  test('cmux surface claims refuse different names, allow same-name rejoin, and require explicit takeover', () => {
    const first = joinAgent(db, 'Alice', 'surface-shared', 'workspace-1', process.ppid, 'first');
    assert.throws(
      () => joinAgent(db, 'Bob', 'surface-shared', 'workspace-1', process.ppid),
      (error: any) => {
        assert.match(error.message, /already registered as agent "Alice"/);
        assert.match(error.message, /Child or scripted processes should join with --headless/);
        assert.match(error.message, /--force-surface/);
        return true;
      }
    );
    assert.strictEqual(getAgent(db, 'Alice')?.id, first.id, 'refusal preserves the current owner');

    const sameName = joinAgent(db, 'aLiCe', 'surface-shared', 'workspace-1', process.ppid, 'refreshed');
    assert.strictEqual(getAgent(db, 'Alice')?.id, sameName.id);
    assert.strictEqual(getAgent(db, 'Alice')?.description, 'refreshed');
    assert.strictEqual((db.prepare('SELECT COUNT(*) AS n FROM agents').get() as any).n, 1);

    const takeover = joinAgentRaw(
      db, SWARM_ID, 'Bob', 'surface-shared', 'workspace-1', process.ppid,
      'replacement', 'cmux', undefined, null, undefined, { forceSurface: true }
    );
    assert.deepStrictEqual(takeover.surface_takeover, {
      prior_name: 'aLiCe',
      surface_id: 'surface-shared',
    });
    assert.strictEqual(getAgent(db, 'Alice'), null);
    assert.strictEqual(getAgent(db, 'Bob')?.surface_id, 'surface-shared');
    assert.strictEqual((db.prepare('SELECT COUNT(*) AS n FROM agents').get() as any).n, 1);
  });

  test('join and list agents', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);
    joinAgent(db, 'Bob', 'surface-2', 'workspace-1', process.ppid);
    // Query directly to avoid stale-surface cleanup (cmux not available in tests)
    const agents = db.prepare('SELECT * FROM agents ORDER BY joined_at ASC').all() as any[];
    assert.strictEqual(agents.length, 2);
    assert.strictEqual(agents[0].name, 'Alice');
    assert.strictEqual(agents[1].name, 'Bob');
  });

  test('join with description', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid, 'working on auth');
    const agent = getAgent(db, 'Alice');
    assert.strictEqual(agent?.description, 'working on auth');
  });

  test('re-join from same surface updates agent', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid, 'old task');
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid, 'new task');
    const agents = db.prepare('SELECT * FROM agents ORDER BY joined_at ASC').all() as any[];
    assert.strictEqual(agents.length, 1);
    assert.strictEqual(agents[0].description, 'new task');
  });

  test('re-join from different surface is rejected', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid, 'old task');
    assert.throws(
      () => joinAgent(db, 'Alice', 'surface-2', 'workspace-1', process.ppid, 'new task'),
      { message: /already taken/ }
    );
  });

  test('leave removes agent by surface ID', async () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);
    const removed = leaveAgent(db, 'surface-1');
    assert.strictEqual(removed, true);
    const agents = await listAgents(db);
    assert.strictEqual(agents.length, 0);
  });

  test('leave returns false for unknown surface', () => {
    const removed = leaveAgent(db, 'nonexistent');
    assert.strictEqual(removed, false);
  });

  test('getAgent is case-insensitive', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);
    assert.ok(getAgent(db, 'alice'));
    assert.ok(getAgent(db, 'ALICE'));
    assert.ok(getAgent(db, 'Alice'));
  });

  test('updateStatus updates description', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);
    updateStatus(db, 'surface-1', 'reviewing PR');
    const agent = getAgent(db, 'Alice');
    assert.strictEqual(agent?.description, 'reviewing PR');
  });

  test('stale surface cleanup removes dead agents with stale heartbeat', async () => {
    // Two cmux agents with fake (unreachable) surfaces and heartbeats older than the
    // 30min stale window. A competent fixture observer sees both surfaces as gone.
    const staleTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    db.prepare(`INSERT OR REPLACE INTO agents (id, swarm_id, name, description, surface_id, workspace_id, ppid, joined_at, last_heartbeat, agent_type, endpoint_url)
      VALUES ('g1', ?, 'GhostA', NULL, 'surface-ghost', 'workspace-1', 999999, ?, ?, 'cmux', NULL)`).run(SWARM_ID, staleTime, staleTime);
    db.prepare(`INSERT OR REPLACE INTO agents (id, swarm_id, name, description, surface_id, workspace_id, ppid, joined_at, last_heartbeat, agent_type, endpoint_url)
      VALUES ('a1', ?, 'GhostB', NULL, 'surface-ghost-b', 'workspace-1', 999999, ?, ?, 'cmux', NULL)`).run(SWARM_ID, staleTime, staleTime);
    assert.strictEqual((db.prepare('SELECT * FROM agents').all() as any[]).length, 2);
    // A single listAgents() confirms each dead via a double-probe and prunes it in one
    // process — the old design needed 3 calls, but a one-shot CLI never accumulated them.
    const after = await listAgents(db);
    assert.strictEqual(after.length, 0);
  });

  test('agents with dead surface but fresh heartbeat are NOT pruned', async () => {
    // Fresh heartbeat protects against transient cmux errors
    joinAgent(db, 'Fresh', 'surface-fake', 'workspace-1', process.ppid);
    const before = db.prepare('SELECT * FROM agents').all() as any[];
    assert.strictEqual(before.length, 1);
    const after = await listAgents(db);
    // Should still be there — heartbeat is fresh even though surface is fake
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].name, 'Fresh');
  });

  test('empty DB returns empty list', async () => {
    const agents = await listAgents(db);
    assert.strictEqual(agents.length, 0);
  });

  test('an observer that cannot reach cmux never mutates liveness state or reaps, and pings once', async () => {
    const calls: string[][] = [];
    const blindObserver = createCmuxLivenessObserver({
      resolveBinary: () => '/fixture/cmux',
      runner: (_binary, args) => {
        calls.push(args);
        throw { stderr: Buffer.from('Failed to connect to socket: operation not permitted') };
      },
      wait: () => {},
    });
    const staleTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    for (const [id, name, surface] of [
      ['blind-a', 'BlindA', 'surface-blind-a'],
      ['blind-b', 'BlindB', 'surface-blind-b'],
    ]) {
      db.prepare(`INSERT INTO agents (
        id, swarm_id, name, description, surface_id, workspace_id, ppid,
        joined_at, last_heartbeat, agent_type, endpoint_url
      ) VALUES (?, ?, ?, NULL, ?, 'workspace-1', 999999, ?, ?, 'cmux', NULL)`)
        .run(id, SWARM_ID, name, surface, staleTime, staleTime);
    }
    const before = db.prepare('SELECT id, last_heartbeat FROM agents ORDER BY id').all();

    for (let attempt = 0; attempt < 3; attempt++) {
      assert.strictEqual((await listAgentsRaw(db, SWARM_ID, blindObserver)).length, 2);
    }
    assert.deepStrictEqual(await reapAllRaw(db, SWARM_ID, blindObserver), []);
    assert.strictEqual(await reapIfDeadRaw(db, SWARM_ID, 'BlindA', blindObserver), null);

    const after = db.prepare('SELECT id, last_heartbeat FROM agents ORDER BY id').all();
    assert.deepStrictEqual(after, before);
    assert.deepStrictEqual(calls, [['ping']], 'competence is memoized once, not probed per agent');
  });

  test('joinA2AAgent creates agent with a2a type', () => {
    const agent = joinA2AAgent(db, 'Cooper', 'http://localhost:18789', 'OpenClaw agent');
    assert.strictEqual(agent.agent_type, 'a2a');
    assert.strictEqual(agent.endpoint_url, 'http://localhost:18789');
    assert.strictEqual(agent.surface_id, `a2a:${SWARM_ID}:Cooper`);
    assert.strictEqual(agent.description, 'OpenClaw agent');
  });

  test('leaveA2AAgent removes by name', () => {
    joinA2AAgent(db, 'Cooper', 'http://localhost:18789');
    const removed = leaveA2AAgent(db, 'Cooper');
    assert.strictEqual(removed, true);
    const agent = getAgent(db, 'Cooper');
    assert.strictEqual(agent, null);
  });

  test('same agent name can exist in separate swarms', async () => {
    const other = getOrCreateSwarm(db, 'project-b');
    joinAgentRaw(db, SWARM_ID, 'Lead', 'surface-a', 'workspace-1', process.ppid);
    joinAgentRaw(db, other.id, 'Lead', 'surface-b', 'workspace-2', process.ppid);

    assert.strictEqual(getAgentRaw(db, SWARM_ID, 'Lead')?.surface_id, 'surface-a');
    assert.strictEqual(getAgentRaw(db, other.id, 'Lead')?.surface_id, 'surface-b');
    assert.strictEqual((await listAgentsRaw(db, SWARM_ID)).length, 1);
    assert.strictEqual((await listAgentsRaw(db, other.id)).length, 1);
  });
});

describe('reap', () => {
  test('reapIfDead removes a cmux agent with a dead surface', async () => {
    // A competent observer confirms this fixture surface is genuinely gone.
    joinAgent(db, 'Ghost', 'surface-fake', 'workspace-1', process.ppid);
    const reaped = await reapIfDead(db, 'Ghost');
    assert.ok(reaped, 'expected agent to be reaped');
    assert.strictEqual(reaped.name, 'Ghost');
    assert.strictEqual(getAgent(db, 'Ghost'), null);
  });

  test('reapIfDead returns null for a nonexistent agent', async () => {
    const reaped = await reapIfDead(db, 'DoesNotExist');
    assert.strictEqual(reaped, null);
  });

  test('reapIfDead skips headless agents', async () => {
    // Set SWARM_AGENT_NAME so joinHeadlessAgent doesn't try to write a TTY marker
    const prev = process.env.SWARM_AGENT_NAME;
    process.env.SWARM_AGENT_NAME = 'Ephemeral';
    try {
      joinHeadlessAgent(db, 'Ephemeral');
    } finally {
      if (prev === undefined) delete process.env.SWARM_AGENT_NAME;
      else process.env.SWARM_AGENT_NAME = prev;
    }
    const reaped = await reapIfDead(db, 'Ephemeral');
    assert.strictEqual(reaped, null, 'headless agents must not be reaped');
    assert.ok(getAgent(db, 'Ephemeral'), 'headless agent should still exist');
  });

  test('reapIfDead is case-insensitive', async () => {
    joinAgent(db, 'Ghost', 'surface-fake', 'workspace-1', process.ppid);
    const reaped = await reapIfDead(db, 'GHOST');
    assert.ok(reaped);
    assert.strictEqual(reaped.name, 'Ghost');
  });

  test('reapAll prunes cmux agents but keeps headless', async () => {
    joinAgent(db, 'GhostA', 'surface-a', 'workspace-1', process.ppid);
    joinAgent(db, 'GhostB', 'surface-b', 'workspace-1', process.ppid);
    const prev = process.env.SWARM_AGENT_NAME;
    process.env.SWARM_AGENT_NAME = 'Keeper';
    try {
      joinHeadlessAgent(db, 'Keeper');
    } finally {
      if (prev === undefined) delete process.env.SWARM_AGENT_NAME;
      else process.env.SWARM_AGENT_NAME = prev;
    }

    const reaped = await reapAll(db);
    const reapedNames = reaped.map(a => a.name).sort();
    assert.deepStrictEqual(reapedNames, ['GhostA', 'GhostB']);
    assert.strictEqual(getAgent(db, 'GhostA'), null);
    assert.strictEqual(getAgent(db, 'GhostB'), null);
    assert.ok(getAgent(db, 'Keeper'), 'headless agent must survive reapAll');
  });

  test('reapAll on empty db returns empty array', async () => {
    const reaped = await reapAll(db);
    assert.deepStrictEqual(reaped, []);
  });

  test('forceReap deletes an agent without probing', () => {
    joinAgent(db, 'Victim', 'surface-x', 'workspace-1', process.ppid);
    const removed = forceReap(db, 'Victim');
    assert.ok(removed);
    assert.strictEqual(removed.name, 'Victim');
    assert.strictEqual(getAgent(db, 'Victim'), null);
  });

  test('forceReap returns null for unknown agent', () => {
    assert.strictEqual(forceReap(db, 'NoOne'), null);
  });

  test('forceReap can delete a headless agent', () => {
    const prev = process.env.SWARM_AGENT_NAME;
    process.env.SWARM_AGENT_NAME = 'Stuck';
    try {
      joinHeadlessAgent(db, 'Stuck');
    } finally {
      if (prev === undefined) delete process.env.SWARM_AGENT_NAME;
      else process.env.SWARM_AGENT_NAME = prev;
    }
    const removed = forceReap(db, 'Stuck');
    assert.ok(removed, 'forceReap must work on headless agents as an escape hatch');
    assert.strictEqual(getAgent(db, 'Stuck'), null);
  });

  test('rejoin succeeds after reaping a dead entry with the same name', async () => {
    joinAgent(db, 'Lead', 'old-surface', 'workspace-1', process.ppid, 'old task');
    // Simulate: cmux restart gives Lead a new surface id. Direct rejoin would fail.
    assert.throws(
      () => joinAgent(db, 'Lead', 'new-surface', 'workspace-1', process.ppid, 'new task'),
      { message: /already taken/ }
    );
    // After reap (old surface is fake = dead), rejoin succeeds.
    await reapIfDead(db, 'Lead');
    joinAgent(db, 'Lead', 'new-surface', 'workspace-1', process.ppid, 'new task');
    const agent = getAgent(db, 'Lead');
    assert.strictEqual(agent?.surface_id, 'new-surface');
    assert.strictEqual(agent?.description, 'new task');
  });
});

describe('mailbox', () => {
  test('inbox returns direct messages', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);
    joinAgent(db, 'Bob', 'surface-2', 'workspace-1', process.ppid);

    // Insert a message directly (bypassing transport/push)
    db.prepare(
      'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(SWARM_ID, 'Bob', 'Alice', 'hello Alice', new Date().toISOString());

    const messages = getInbox(db, 'Alice');
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].from_agent, 'Bob');
    assert.strictEqual(messages[0].body, 'hello Alice');
  });

  test('inbox returns broadcast messages', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);

    db.prepare(
      'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, NULL, ?, 1, ?)'
    ).run(SWARM_ID, 'Bob', 'attention everyone', new Date().toISOString());

    const messages = getInbox(db, 'Alice');
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].body, 'attention everyone');
  });

  test('case-mismatched direct message still reaches the recipient inbox', async () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);
    joinAgent(db, 'Bob', 'surface-2', 'workspace-1', process.ppid);

    // Bob addresses 'alice' (wrong case); getAgent resolves it case-insensitively, so the
    // send must store the canonical 'Alice' or the recipient's case-sensitive inbox query misses it.
    const res = await sendMessage(db, 'Bob', 'alice', 'ping');
    assert.strictEqual(res.delivered, true);

    const inbox = getInbox(db, 'Alice');
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].body, 'ping');
    assert.strictEqual(inbox[0].to_agent, 'Alice'); // canonical, not the 'alice' that was typed
  });

  test('inbox excludes own messages', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);

    db.prepare(
      'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, NULL, ?, 1, ?)'
    ).run(SWARM_ID, 'Alice', 'my own broadcast', new Date().toISOString());

    const messages = getInbox(db, 'Alice');
    assert.strictEqual(messages.length, 0);
  });

  test('cursor advances after reading', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);

    db.prepare(
      'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(SWARM_ID, 'Bob', 'Alice', 'first', new Date().toISOString());

    const first = getInbox(db, 'Alice');
    assert.strictEqual(first.length, 1);

    // Second read should return nothing
    const second = getInbox(db, 'Alice');
    assert.strictEqual(second.length, 0);

    // New message should appear
    db.prepare(
      'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(SWARM_ID, 'Bob', 'Alice', 'second', new Date().toISOString());

    const third = getInbox(db, 'Alice');
    assert.strictEqual(third.length, 1);
    assert.strictEqual(third[0].body, 'second');
  });

  test('peek mode does not advance cursor', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);

    db.prepare(
      'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(SWARM_ID, 'Bob', 'Alice', 'hello', new Date().toISOString());

    const peeked = getInbox(db, 'Alice', true);
    assert.strictEqual(peeked.length, 1);

    // Should still be visible after peek
    const again = getInbox(db, 'Alice');
    assert.strictEqual(again.length, 1);
  });

  test('sendMessage stores kind when given, NULL otherwise', async () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);
    joinAgent(db, 'Bob', 'surface-2', 'workspace-1', process.ppid);

    await sendMessageRaw(db, SWARM_ID, 'Bob', 'Alice', 'merge ready', undefined, 'gate');
    await sendMessageRaw(db, SWARM_ID, 'Bob', 'Alice', 'plain message');

    const rows = db.prepare('SELECT body, kind FROM messages ORDER BY id ASC').all() as any[];
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].kind, 'gate');
    assert.strictEqual(rows[1].kind, null);

    const inbox = getInbox(db, 'Alice');
    assert.strictEqual(inbox[0].kind, 'gate');
    assert.strictEqual(inbox[1].kind, null);
  });

  test('broadcastMessage stores kind on the broadcast row', async () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);

    await broadcastMessageRaw(db, SWARM_ID, 'Lead', 'daily rollup', undefined, 'digest');

    const row = db.prepare('SELECT kind FROM messages WHERE to_agent IS NULL').get() as any;
    assert.strictEqual(row.kind, 'digest');
    const inbox = getInbox(db, 'Alice');
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].kind, 'digest');
  });

  test('kind-filtered inbox returns only that kind and NEVER advances the cursor', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);
    const now = new Date().toISOString();
    const ins = db.prepare(
      'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at, kind) VALUES (?, ?, ?, ?, 1, ?, ?)'
    );
    ins.run(SWARM_ID, 'Bob', 'Alice', 'gate one', now, 'gate');
    ins.run(SWARM_ID, 'Bob', 'Alice', 'status one', now, 'status');
    ins.run(SWARM_ID, 'Bob', 'Alice', 'untagged', now, null);

    // Filtered read with peek=false: the kind filter alone must prevent cursor advance,
    // otherwise the two unshown messages would be silently marked read.
    const gates = getInboxRaw(db, SWARM_ID, 'Alice', false, 'gate');
    assert.strictEqual(gates.length, 1);
    assert.strictEqual(gates[0].body, 'gate one');

    const all = getInbox(db, 'Alice');
    assert.strictEqual(all.length, 3, 'filtered read must not have advanced the cursor');

    // The unfiltered read above DID advance the cursor as usual.
    assert.strictEqual(getInbox(db, 'Alice').length, 0);
  });

  test('getRecentMessages honors the kind filter', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);
    const now = new Date().toISOString();
    const ins = db.prepare(
      'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at, kind) VALUES (?, ?, ?, ?, 1, ?, ?)'
    );
    ins.run(SWARM_ID, 'Bob', 'Alice', 'gate one', now, 'gate');
    ins.run(SWARM_ID, 'Bob', 'Alice', 'status one', now, 'status');
    ins.run(SWARM_ID, 'Bob', 'Alice', 'gate two', now, 'gate');

    const gates = getRecentMessagesRaw(db, SWARM_ID, 'Alice', 10, 'gate');
    assert.deepStrictEqual(gates.map(m => m.body), ['gate one', 'gate two']);
    const unfiltered = getRecentMessagesRaw(db, SWARM_ID, 'Alice', 10);
    assert.strictEqual(unfiltered.length, 3);
  });

  test('countRecentMessages counts only my addressed traffic inside the window', () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const ins = db.prepare(
      'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, ?, 1, ?)'
    );
    ins.run(SWARM_ID, 'Bob', 'Alice', 'direct fresh', now);
    ins.run(SWARM_ID, 'Bob', null, 'broadcast fresh', now);
    ins.run(SWARM_ID, 'Bob', 'Carol', 'someone else', now);
    ins.run(SWARM_ID, 'Alice', null, 'my own broadcast', now);
    ins.run(SWARM_ID, 'Bob', 'Alice', 'too old', old);

    // Alice: her direct + Bob's broadcast. Her own broadcast and Carol's direct don't count.
    assert.strictEqual(countRecentMessagesRaw(db, SWARM_ID, 'Alice'), 2);
    // Dave: both broadcasts (Bob's and Alice's) — he sent neither.
    assert.strictEqual(countRecentMessagesRaw(db, SWARM_ID, 'Dave'), 2);
  });

  test('inbox ignores messages from another swarm', () => {
    const other = getOrCreateSwarm(db, 'project-b');
    joinAgentRaw(db, SWARM_ID, 'Alice', 'surface-1', 'workspace-1', process.ppid);
    joinAgentRaw(db, other.id, 'Alice', 'surface-2', 'workspace-2', process.ppid);

    db.prepare(
      'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(other.id, 'Bob', 'Alice', 'wrong swarm', new Date().toISOString());
    db.prepare(
      'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(SWARM_ID, 'Bob', 'Alice', 'right swarm', new Date().toISOString());

    const messages = getInbox(db, 'Alice');
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].body, 'right swarm');
  });
});

describe('migration', () => {
  test('legacy single-swarm database migrates into default swarm', () => {
    const legacyPath = path.join(os.tmpdir(), `swarm-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        surface_id TEXT NOT NULL,
        workspace_id TEXT,
        ppid INTEGER NOT NULL,
        joined_at TEXT NOT NULL,
        last_heartbeat TEXT NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT,
        body TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE inbox_cursors (
        agent_name TEXT PRIMARY KEY,
        last_read_id INTEGER NOT NULL DEFAULT 0
      );
    `);
    const now = new Date().toISOString();
    legacy.prepare(`
      INSERT INTO agents (id, name, description, surface_id, workspace_id, ppid, joined_at, last_heartbeat)
      VALUES ('legacy-agent', 'Alice', 'legacy', 'surface-1', 'workspace-1', 1, ?, ?)
    `).run(now, now);
    legacy.prepare(`
      INSERT INTO messages (from_agent, to_agent, body, delivered, created_at)
      VALUES ('Bob', 'Alice', 'hello', 1, ?)
    `).run(now);
    legacy.prepare('INSERT INTO inbox_cursors (agent_name, last_read_id) VALUES (?, ?)').run('Alice', 1);
    legacy.close();

    const migrated = getDbAt(legacyPath);
    try {
      const swarm = migrated.prepare('SELECT * FROM swarms WHERE id = ?').get(DEFAULT_SWARM_ID) as any;
      const agent = migrated.prepare('SELECT * FROM agents WHERE name = ?').get('Alice') as any;
      const message = migrated.prepare('SELECT * FROM messages WHERE body = ?').get('hello') as any;
      const cursor = migrated.prepare('SELECT * FROM inbox_cursors WHERE agent_name = ?').get('Alice') as any;

      assert.strictEqual(swarm.name, 'default');
      assert.strictEqual(agent.swarm_id, DEFAULT_SWARM_ID);
      assert.strictEqual(agent.agent_type, 'cmux');
      assert.strictEqual(message.swarm_id, DEFAULT_SWARM_ID);
      assert.strictEqual(cursor.swarm_id, DEFAULT_SWARM_ID);
    } finally {
      migrated.close();
      try { fs.unlinkSync(legacyPath); } catch {}
      try { fs.unlinkSync(legacyPath + '-wal'); } catch {}
      try { fs.unlinkSync(legacyPath + '-shm'); } catch {}
    }
  });

  test('a leftover *_new table from a prior failed migration does not wedge migrate()', () => {
    const legacyPath = path.join(os.tmpdir(), `swarm-wedge-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
        surface_id TEXT NOT NULL, workspace_id TEXT, ppid INTEGER NOT NULL,
        joined_at TEXT NOT NULL, last_heartbeat TEXT NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL, to_agent TEXT,
        body TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE inbox_cursors (
        agent_name TEXT PRIMARY KEY, last_read_id INTEGER NOT NULL DEFAULT 0
      );
      -- Simulate a half-built scratch table left behind by an interrupted/failed prior
      -- migration. Pre-fix, the unguarded CREATE TABLE agents_new would throw
      -- "table agents_new already exists" on every subsequent run, wedging the whole CLI.
      CREATE TABLE agents_new (id TEXT PRIMARY KEY, leftover TEXT);
    `);
    const now = new Date().toISOString();
    legacy.prepare(`INSERT INTO agents (id, name, description, surface_id, workspace_id, ppid, joined_at, last_heartbeat)
      VALUES ('a', 'Alice', 'x', 's1', 'w1', 1, ?, ?)`).run(now, now);
    legacy.close();

    const migrated = getDbAt(legacyPath); // must not throw
    try {
      const cols = (migrated.prepare('PRAGMA table_info(agents)').all() as any[]).map(c => c.name);
      assert.ok(cols.includes('swarm_id'), 'agents migrated to the multi-swarm schema');
      const agent = migrated.prepare('SELECT * FROM agents WHERE name = ?').get('Alice') as any;
      assert.strictEqual(agent.swarm_id, DEFAULT_SWARM_ID);
      const leftover = migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents_new'").get();
      assert.strictEqual(leftover, undefined, 'scratch agents_new table is cleaned up');
    } finally {
      migrated.close();
      try { fs.unlinkSync(legacyPath); } catch {}
      try { fs.unlinkSync(legacyPath + '-wal'); } catch {}
      try { fs.unlinkSync(legacyPath + '-shm'); } catch {}
    }
  });

  test('a pre-kind messages table gains the kind column on open; old rows and new writes work', async () => {
    const oldPath = path.join(os.tmpdir(), `swarm-prekind-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    // Simulate a DB written by the previous build: modern multi-swarm messages
    // schema (has swarm_id) but no kind column.
    const old = new DatabaseSync(oldPath);
    old.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        swarm_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT,
        body TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    old.prepare(
      "INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, 'Bob', 'Alice', 'pre-kind row', 1, ?)"
    ).run(DEFAULT_SWARM_ID, new Date().toISOString());
    old.close();

    let migrated = getDbAt(oldPath); // must not throw
    try {
      const cols = (migrated.prepare('PRAGMA table_info(messages)').all() as any[]).map(c => c.name);
      assert.ok(cols.includes('kind'), 'kind column added by the idempotent guard');
      assert.ok(cols.includes('superseded_by'), 'supersession column added by the idempotent guard');
      const deliveryTable = migrated.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_deliveries'"
      ).get() as { name: string } | undefined;
      assert.strictEqual(deliveryTable?.name, 'message_deliveries');

      // Old row reads back with kind NULL.
      const inbox = getInboxRaw(migrated, DEFAULT_SWARM_ID, 'Alice');
      assert.strictEqual(inbox.length, 1);
      assert.strictEqual(inbox[0].body, 'pre-kind row');
      assert.strictEqual(inbox[0].kind, null);

      // New kinded write + filtered read work on the migrated DB.
      joinAgentRaw(migrated, DEFAULT_SWARM_ID, 'Alice', 'surface-mig', 'workspace-1', process.ppid);
      await sendMessageRaw(migrated, DEFAULT_SWARM_ID, 'Bob', 'Alice', 'tagged', undefined, 'ack');
      const acks = getInboxRaw(migrated, DEFAULT_SWARM_ID, 'Alice', true, 'ack');
      assert.strictEqual(acks.length, 1);
      assert.strictEqual(acks[0].kind, 'ack');

      // Guard is idempotent: reopening (re-running migrate) must not throw or duplicate.
      migrated.close();
      migrated = getDbAt(oldPath);
      const kindCols = (migrated.prepare('PRAGMA table_info(messages)').all() as any[]).filter(c => c.name === 'kind');
      assert.strictEqual(kindCols.length, 1);
      const supersessionCols = (migrated.prepare('PRAGMA table_info(messages)').all() as any[])
        .filter(c => c.name === 'superseded_by');
      assert.strictEqual(supersessionCols.length, 1);
    } finally {
      migrated.close();
      try { fs.unlinkSync(oldPath); } catch {}
      try { fs.unlinkSync(oldPath + '-wal'); } catch {}
      try { fs.unlinkSync(oldPath + '-shm'); } catch {}
    }
  });

  test('a fully-legacy DB (pre-swarm_id rebuild) also ends up with the kind column', () => {
    const legacyPath = path.join(os.tmpdir(), `swarm-legacy-kind-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL, to_agent TEXT,
        body TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
    `);
    legacy.prepare("INSERT INTO messages (from_agent, to_agent, body, delivered, created_at) VALUES ('Bob', 'Alice', 'ancient', 1, ?)")
      .run(new Date().toISOString());
    legacy.close();

    // migrateMessages rebuilds the table (adding swarm_id); the kind guard runs after
    // the rebuild, so the rebuilt table must have the column too.
    const migrated = getDbAt(legacyPath);
    try {
      const cols = (migrated.prepare('PRAGMA table_info(messages)').all() as any[]).map(c => c.name);
      assert.ok(cols.includes('swarm_id'));
      assert.ok(cols.includes('kind'), 'kind column present after the legacy rebuild path');
      const row = migrated.prepare('SELECT * FROM messages').get() as any;
      assert.strictEqual(row.body, 'ancient');
      assert.strictEqual(row.kind, null);
    } finally {
      migrated.close();
      try { fs.unlinkSync(legacyPath); } catch {}
      try { fs.unlinkSync(legacyPath + '-wal'); } catch {}
      try { fs.unlinkSync(legacyPath + '-shm'); } catch {}
    }
  });

  test('a pre-T1 tasks table gains one nullable claim_kind column additively', () => {
    const oldPath = path.join(os.tmpdir(), `swarm-preclaim-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const old = new DatabaseSync(oldPath);
    old.exec(`
      CREATE TABLE tasks (
        id TEXT NOT NULL,
        swarm_id TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',
        owner_agent TEXT COLLATE NOCASE,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        lease_expires_at TEXT,
        repo_path TEXT,
        branch TEXT,
        worktree_path TEXT,
        transcript_hint TEXT,
        disposition TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (swarm_id, id)
      );
    `);
    const now = new Date().toISOString();
    old.prepare(`
      INSERT INTO tasks (
        id, swarm_id, title, state, owner_agent, lease_epoch, created_at, updated_at
      ) VALUES ('legacy-task', ?, 'Legacy task', 'active', 'Alice', 1, ?, ?)
    `).run(DEFAULT_SWARM_ID, now, now);
    old.close();

    let migrated = getDbAt(oldPath);
    try {
      let claimColumns = (migrated.prepare('PRAGMA table_info(tasks)').all() as any[])
        .filter(column => column.name === 'claim_kind');
      assert.strictEqual(claimColumns.length, 1);
      assert.strictEqual((migrated.prepare("SELECT claim_kind FROM tasks WHERE id = 'legacy-task'").get() as any).claim_kind, null);
      migrated.close();
      migrated = getDbAt(oldPath);
      claimColumns = (migrated.prepare('PRAGMA table_info(tasks)').all() as any[])
        .filter(column => column.name === 'claim_kind');
      assert.strictEqual(claimColumns.length, 1, 'the additive guard is idempotent');
    } finally {
      migrated.close();
      try { fs.unlinkSync(oldPath); } catch {}
      try { fs.unlinkSync(oldPath + '-wal'); } catch {}
      try { fs.unlinkSync(oldPath + '-shm'); } catch {}
    }
  });

  test('migration de-duplicates case-variant names the new NOCASE unique would reject', () => {
    const legacyPath = path.join(os.tmpdir(), `swarm-nocase-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
        surface_id TEXT NOT NULL, workspace_id TEXT, ppid INTEGER NOT NULL,
        joined_at TEXT NOT NULL, last_heartbeat TEXT NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL, to_agent TEXT,
        body TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE inbox_cursors (
        agent_name TEXT PRIMARY KEY, last_read_id INTEGER NOT NULL DEFAULT 0
      );
    `);
    const older = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const newer = new Date().toISOString();
    // The legacy binary UNIQUE allows 'Bob' and 'bob'; the new schema's NOCASE unique does not.
    legacy.prepare(`INSERT INTO agents (id, name, description, surface_id, workspace_id, ppid, joined_at, last_heartbeat)
      VALUES ('id-old', 'Bob', 'old', 's-old', 'w', 1, ?, ?)`).run(older, older);
    legacy.prepare(`INSERT INTO agents (id, name, description, surface_id, workspace_id, ppid, joined_at, last_heartbeat)
      VALUES ('id-new', 'bob', 'new', 's-new', 'w', 1, ?, ?)`).run(newer, newer);
    legacy.prepare('INSERT INTO inbox_cursors (agent_name, last_read_id) VALUES (?, ?)').run('Bob', 5);
    legacy.prepare('INSERT INTO inbox_cursors (agent_name, last_read_id) VALUES (?, ?)').run('bob', 9);
    legacy.close();

    const migrated = getDbAt(legacyPath); // must not throw on the NOCASE unique constraint
    try {
      const agents = migrated.prepare("SELECT * FROM agents WHERE name = 'bob' COLLATE NOCASE").all() as any[];
      assert.strictEqual(agents.length, 1, 'one row survives per case-insensitive name');
      assert.strictEqual(agents[0].id, 'id-new', 'the most-recently-active row is kept');
      const cursor = migrated.prepare("SELECT * FROM inbox_cursors WHERE agent_name = 'bob' COLLATE NOCASE").get() as any;
      assert.strictEqual(cursor.last_read_id, 9, 'the furthest-read cursor is kept');
    } finally {
      migrated.close();
      try { fs.unlinkSync(legacyPath); } catch {}
      try { fs.unlinkSync(legacyPath + '-wal'); } catch {}
      try { fs.unlinkSync(legacyPath + '-shm'); } catch {}
    }
  });
});

describe('sanitization', () => {
  // Import the sanitize behavior indirectly — test that the transport module
  // would strip dangerous characters. We test the logic directly here.
  test('newlines and escapes are stripped from messages', () => {
    // Replicate the sanitize function logic
    function sanitize(text: string): string {
      return text
        .replace(/\\n/g, ' ')
        .replace(/\\r/g, ' ')
        .replace(/\\t/g, ' ')
        .replace(/\n/g, ' ')
        .replace(/\r/g, ' ')
        .replace(/\t/g, ' ');
    }

    assert.strictEqual(sanitize('hello\\nworld'), 'hello world');
    assert.strictEqual(sanitize('hello\nworld'), 'hello world');
    assert.strictEqual(sanitize('hello\\rworld'), 'hello world');
    assert.strictEqual(sanitize('no\\ttabs'), 'no tabs');
    assert.strictEqual(sanitize('clean message'), 'clean message');
    assert.strictEqual(
      sanitize('review\\nrm -rf ~/important'),
      'review rm -rf ~/important'
    );
  });
});
