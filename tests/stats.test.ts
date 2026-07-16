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
  db.prepare(
    'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(SWARM_ID, from, to, body, createdAt);
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
});
