import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_SWARM_ID, getDbAt } from '../src/db.js';
import { getFleetStats, formatFleetStats } from '../src/stats.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let dbPath: string;
const SWARM_ID = DEFAULT_SWARM_ID;

function insertMessage(
  from: string,
  to: string | null,
  body: string,
  createdAt: string = new Date().toISOString()
) {
  const result = db.prepare(
    'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(SWARM_ID, from, to, body, createdAt);
  return Number(result.lastInsertRowid);
}

describe('fleet stats', () => {
  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-stats-')), 'swarm.db');
    db = getDbAt(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test('empty window returns zeroes', () => {
    const stats = getFleetStats(db, SWARM_ID, 24, 5);
    assert.strictEqual(stats.totalMessages, 0);
    assert.strictEqual(stats.estimatedReads, 0);
    assert.strictEqual(stats.avgBodyChars, 0);
    assert.match(formatFleetStats(stats), /No traffic in window/);
  });

  test('splits direct vs broadcast and estimates reads by fanout', () => {
    insertMessage('alice', 'bob', 'contract agreed on ingest shape');
    insertMessage('alice', 'bob', 'PR open');
    insertMessage('carol', null, 'org update for everyone');

    // 4 active agents: broadcast fanout = 3 readers.
    const stats = getFleetStats(db, SWARM_ID, 24, 4);
    assert.strictEqual(stats.totalMessages, 3);
    assert.strictEqual(stats.directMessages, 2);
    assert.strictEqual(stats.broadcasts, 1);
    assert.strictEqual(stats.estimatedReads, 2 + 3);
  });

  test('counts ack-like messages and per-agent traffic', () => {
    insertMessage('bob', 'alice', 'ACK org structure — rules adopted');
    insertMessage('bob', 'alice', 'Acknowledged. Contract is locked.');
    insertMessage('bob', 'alice', 'MERGE-REQ #12 @abc — CI green');
    insertMessage('alice', 'bob', 'merged');

    const stats = getFleetStats(db, SWARM_ID, 24, 3);
    assert.strictEqual(stats.ackLikeMessages, 2);
    const bob = stats.perAgent.find((a) => a.agent === 'bob');
    assert.ok(bob);
    assert.strictEqual(bob.sent, 3);
    assert.strictEqual(bob.received, 1);
    assert.strictEqual(bob.acksSent, 2);
  });

  test('window excludes old messages', () => {
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    insertMessage('alice', 'bob', 'ancient history', old);
    insertMessage('alice', 'bob', 'fresh');

    const stats = getFleetStats(db, SWARM_ID, 24, 2);
    assert.strictEqual(stats.totalMessages, 1);
  });

  test('top pairs ranks direct traffic only', () => {
    for (let i = 0; i < 3; i++) insertMessage('alice', 'bob', `m${i}`);
    insertMessage('bob', 'carol', 'one-off');
    insertMessage('dave', null, 'broadcast does not form a pair');

    const stats = getFleetStats(db, SWARM_ID, 24, 4);
    assert.strictEqual(stats.topPairs[0].from, 'alice');
    assert.strictEqual(stats.topPairs[0].to, 'bob');
    assert.strictEqual(stats.topPairs[0].count, 3);
    assert.strictEqual(stats.topPairs.length, 2);
  });

  test('pair aggregation uses a printable separator instead of splitting NULs in names', () => {
    insertMessage('nul\0sender', 'bob', 'one');
    const stats = getFleetStats(db, SWARM_ID, 24, 2);
    assert.deepStrictEqual(stats.topPairs[0], { from: 'nul\0sender', to: 'bob', count: 1 });
  });

  test('reports per-recipient unacked count and maximum age from delivery state', () => {
    const now = Date.now();
    const oldId = insertMessage('alice', 'bob', 'old pending', new Date(now - 70 * 60_000).toISOString());
    const newId = insertMessage('alice', 'bob', 'new injected', new Date(now - 5 * 60_000).toISOString());
    const ackedId = insertMessage('alice', 'bob', 'already acked', new Date(now - 90 * 60_000).toISOString());
    const supersededId = insertMessage('alice', 'bob', 'superseded', new Date(now - 120 * 60_000).toISOString());
    db.prepare('UPDATE messages SET superseded_by = ? WHERE id = ?').run(newId, supersededId);
    const insertDelivery = db.prepare(`
      INSERT INTO message_deliveries (
        message_id, swarm_id, recipient, status, first_injected_at, inject_count, acked_at
      ) VALUES (?, ?, 'Bob', ?, ?, ?, ?)
    `);
    insertDelivery.run(oldId, SWARM_ID, 'pending', null, 0, null);
    insertDelivery.run(newId, SWARM_ID, 'injected', new Date(now - 5 * 60_000).toISOString(), 1, null);
    insertDelivery.run(ackedId, SWARM_ID, 'acked', null, 0, new Date(now).toISOString());
    insertDelivery.run(supersededId, SWARM_ID, 'pending', null, 0, null);

    const stats = getFleetStats(db, SWARM_ID, 24, ['Bob'], now);
    assert.deepStrictEqual(stats.unackedDeliveries, [{ agent: 'Bob', count: 2, maxAgeMinutes: 70 }]);
    assert.match(formatFleetStats(stats), /Unacked deliveries \(count \/ max age\):/);
    assert.match(formatFleetStats(stats), /Bob\s+2 unacked \| max age 70min/);
  });
});

describe('stall telemetry', () => {
  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-stats-')), 'swarm.db');
    db = getDbAt(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test('flags a silent agent with unanswered inbound; ignores active agents', () => {
    const now = Date.now();
    const old = new Date(now - 90 * 60_000).toISOString();   // bob last sent 90min ago
    const fresh = new Date(now - 5 * 60_000).toISOString();
    insertMessage('bob', 'alice', 'last thing bob ever said', old);
    insertMessage('alice', 'bob', 'are you there?', fresh);
    insertMessage('alice', 'bob', 'hello?', fresh);
    insertMessage('alice', 'carol', 'carol is fine', fresh);
    insertMessage('carol', 'alice', 'yes I am', fresh);

    const stats = getFleetStats(db, SWARM_ID, 24, ['alice', 'bob', 'carol'], now);
    assert.strictEqual(stats.possibleStalls.length, 1);
    assert.strictEqual(stats.possibleStalls[0].agent, 'bob');
    assert.strictEqual(stats.possibleStalls[0].inboundSinceLastSend, 2);
    assert.ok(stats.possibleStalls[0].minutesSinceLastSend >= 89);
    assert.match(formatFleetStats(stats), /POSSIBLE STALLS/);
  });

  test('flags a registered agent that never sent but has inbound', () => {
    const now = Date.now();
    insertMessage('alice', 'ghost', 'assignment for ghost', new Date(now - 60 * 60_000).toISOString());
    const stats = getFleetStats(db, SWARM_ID, 24, ['alice', 'ghost'], now);
    const ghost = stats.possibleStalls.find((s) => s.agent === 'ghost');
    assert.ok(ghost);
    assert.strictEqual(ghost.minutesSinceLastSend, Infinity);
    assert.strictEqual(ghost.inboundSinceLastSend, 1);
  });

  test('numeric activeAgents arg keeps fanout math and skips stall telemetry', () => {
    insertMessage('a', null, 'broadcast');
    const stats = getFleetStats(db, SWARM_ID, 24, 4);
    assert.strictEqual(stats.estimatedReads, 3);
    assert.deepStrictEqual(stats.possibleStalls, []);
  });
});
