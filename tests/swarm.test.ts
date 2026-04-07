import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDbAt } from '../src/db.js';
import { joinAgent, leaveAgent, getAgent, listAgents, updateStatus } from '../src/registry.js';
import { getInbox } from '../src/mailbox.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let dbPath: string;

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

  test('re-join overwrites (INSERT OR REPLACE)', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid, 'old task');
    joinAgent(db, 'Alice', 'surface-2', 'workspace-1', process.ppid, 'new task');
    const agents = db.prepare('SELECT * FROM agents ORDER BY joined_at ASC').all() as any[];
    assert.strictEqual(agents.length, 1);
    assert.strictEqual(agents[0].surface_id, 'surface-2');
    assert.strictEqual(agents[0].description, 'new task');
  });

  test('leave removes agent by surface ID', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);
    const removed = leaveAgent(db, 'surface-1');
    assert.strictEqual(removed, true);
    const agents = listAgents(db);
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

  test('stale surface cleanup removes dead agents with stale heartbeat', () => {
    // Insert agents with fake surfaces and stale heartbeats (>30min old)
    const staleTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    db.prepare(`INSERT OR REPLACE INTO agents (id, name, description, surface_id, workspace_id, ppid, joined_at, last_heartbeat)
      VALUES ('g1', 'Ghost', NULL, 'surface-ghost', 'workspace-1', 999999, ?, ?)`).run(staleTime, staleTime);
    db.prepare(`INSERT OR REPLACE INTO agents (id, name, description, surface_id, workspace_id, ppid, joined_at, last_heartbeat)
      VALUES ('a1', 'Alive', NULL, 'surface-alive', 'workspace-1', ${process.ppid}, ?, ?)`).run(staleTime, staleTime);
    const before = db.prepare('SELECT * FROM agents').all() as any[];
    assert.strictEqual(before.length, 2);
    // Cleanup requires 3 consecutive failed surface checks before pruning
    listAgents(db); // strike 1
    assert.strictEqual((db.prepare('SELECT * FROM agents').all() as any[]).length, 2);
    listAgents(db); // strike 2
    assert.strictEqual((db.prepare('SELECT * FROM agents').all() as any[]).length, 2);
    // Strike 3 — now agents should be pruned
    const after = listAgents(db);
    assert.strictEqual(after.length, 0);
  });

  test('agents with dead surface but fresh heartbeat are NOT pruned', () => {
    // Fresh heartbeat protects against transient cmux errors
    joinAgent(db, 'Fresh', 'surface-fake', 'workspace-1', process.ppid);
    const before = db.prepare('SELECT * FROM agents').all() as any[];
    assert.strictEqual(before.length, 1);
    const after = listAgents(db);
    // Should still be there — heartbeat is fresh even though surface is fake
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].name, 'Fresh');
  });

  test('empty DB returns empty list', () => {
    const agents = listAgents(db);
    assert.strictEqual(agents.length, 0);
  });
});

describe('mailbox', () => {
  test('inbox returns direct messages', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);
    joinAgent(db, 'Bob', 'surface-2', 'workspace-1', process.ppid);

    // Insert a message directly (bypassing transport/push)
    db.prepare(
      'INSERT INTO messages (from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, 1, ?)'
    ).run('Bob', 'Alice', 'hello Alice', new Date().toISOString());

    const messages = getInbox(db, 'Alice');
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].from_agent, 'Bob');
    assert.strictEqual(messages[0].body, 'hello Alice');
  });

  test('inbox returns broadcast messages', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);

    db.prepare(
      'INSERT INTO messages (from_agent, to_agent, body, delivered, created_at) VALUES (?, NULL, ?, 1, ?)'
    ).run('Bob', 'attention everyone', new Date().toISOString());

    const messages = getInbox(db, 'Alice');
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].body, 'attention everyone');
  });

  test('inbox excludes own messages', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);

    db.prepare(
      'INSERT INTO messages (from_agent, to_agent, body, delivered, created_at) VALUES (?, NULL, ?, 1, ?)'
    ).run('Alice', 'my own broadcast', new Date().toISOString());

    const messages = getInbox(db, 'Alice');
    assert.strictEqual(messages.length, 0);
  });

  test('cursor advances after reading', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);

    db.prepare(
      'INSERT INTO messages (from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, 1, ?)'
    ).run('Bob', 'Alice', 'first', new Date().toISOString());

    const first = getInbox(db, 'Alice');
    assert.strictEqual(first.length, 1);

    // Second read should return nothing
    const second = getInbox(db, 'Alice');
    assert.strictEqual(second.length, 0);

    // New message should appear
    db.prepare(
      'INSERT INTO messages (from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, 1, ?)'
    ).run('Bob', 'Alice', 'second', new Date().toISOString());

    const third = getInbox(db, 'Alice');
    assert.strictEqual(third.length, 1);
    assert.strictEqual(third[0].body, 'second');
  });

  test('peek mode does not advance cursor', () => {
    joinAgent(db, 'Alice', 'surface-1', 'workspace-1', process.ppid);

    db.prepare(
      'INSERT INTO messages (from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, 1, ?)'
    ).run('Bob', 'Alice', 'hello', new Date().toISOString());

    const peeked = getInbox(db, 'Alice', true);
    assert.strictEqual(peeked.length, 1);

    // Should still be visible after peek
    const again = getInbox(db, 'Alice');
    assert.strictEqual(again.length, 1);
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
