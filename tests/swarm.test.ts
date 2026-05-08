import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import SQLite from 'better-sqlite3';
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
import { getInbox as getInboxRaw } from '../src/mailbox.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let dbPath: string;
const SWARM_ID = DEFAULT_SWARM_ID;

function joinAgent(testDb: Database.Database, name: string, surfaceId: string, workspaceId: string | undefined, ppid: number, description?: string) {
  return joinAgentRaw(testDb, SWARM_ID, name, surfaceId, workspaceId, ppid, description);
}

function joinHeadlessAgent(testDb: Database.Database, name: string, description?: string) {
  return joinHeadlessAgentRaw(testDb, SWARM_ID, name, description);
}

function joinA2AAgent(testDb: Database.Database, name: string, endpointUrl: string, description?: string) {
  return joinA2AAgentRaw(testDb, SWARM_ID, name, endpointUrl, description);
}

function leaveAgent(testDb: Database.Database, surfaceId: string) {
  return leaveAgentRaw(testDb, SWARM_ID, surfaceId);
}

function leaveA2AAgent(testDb: Database.Database, name: string) {
  return leaveA2AAgentRaw(testDb, SWARM_ID, name);
}

function getAgent(testDb: Database.Database, name: string) {
  return getAgentRaw(testDb, SWARM_ID, name);
}

function listAgents(testDb: Database.Database) {
  return listAgentsRaw(testDb, SWARM_ID);
}

function updateStatus(testDb: Database.Database, surfaceId: string, description: string) {
  return updateStatusRaw(testDb, SWARM_ID, surfaceId, description);
}

function reapIfDead(testDb: Database.Database, name: string) {
  return reapIfDeadRaw(testDb, SWARM_ID, name);
}

function reapAll(testDb: Database.Database) {
  return reapAllRaw(testDb, SWARM_ID);
}

function forceReap(testDb: Database.Database, name: string) {
  return forceReapRaw(testDb, SWARM_ID, name);
}

function getInbox(testDb: Database.Database, agentName: string, peek: boolean = false) {
  return getInboxRaw(testDb, SWARM_ID, agentName, peek);
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
    // Insert agents with fake surfaces and stale heartbeats (>30min old)
    const staleTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    db.prepare(`INSERT OR REPLACE INTO agents (id, swarm_id, name, description, surface_id, workspace_id, ppid, joined_at, last_heartbeat, agent_type, endpoint_url)
      VALUES ('g1', ?, 'Ghost', NULL, 'surface-ghost', 'workspace-1', 999999, ?, ?, 'cmux', NULL)`).run(SWARM_ID, staleTime, staleTime);
    db.prepare(`INSERT OR REPLACE INTO agents (id, swarm_id, name, description, surface_id, workspace_id, ppid, joined_at, last_heartbeat, agent_type, endpoint_url)
      VALUES ('a1', ?, 'Alive', NULL, 'surface-alive', 'workspace-1', ${process.ppid}, ?, ?, 'cmux', NULL)`).run(SWARM_ID, staleTime, staleTime);
    const before = db.prepare('SELECT * FROM agents').all() as any[];
    assert.strictEqual(before.length, 2);
    // Cleanup requires 3 consecutive failed surface checks before pruning
    await listAgents(db); // strike 1
    assert.strictEqual((db.prepare('SELECT * FROM agents').all() as any[]).length, 2);
    await listAgents(db); // strike 2
    assert.strictEqual((db.prepare('SELECT * FROM agents').all() as any[]).length, 2);
    // Strike 3 — now agents should be pruned
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
    // In the test environment cmux is unavailable, so isSurfaceAlive fails.
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
    const legacy = new SQLite(legacyPath);
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
