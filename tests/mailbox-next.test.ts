import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SwarmDb } from '../src/db.js';
import { DEFAULT_SWARM_ID, getDbAt } from '../src/db.js';
import {
  acknowledgeMessages,
  broadcastMessage,
  getInbox,
  getRecentMessages,
  HOOK_INJECT_BACKOFF_MINUTES,
  HOOK_INJECT_COLLAPSE_COUNT,
  recordHookInjections,
  sendMessage,
  waitForInbox,
} from '../src/mailbox.js';
import {
  getOrCreateSwarm,
  joinA2AAgent,
  joinAgent,
  joinHeadlessAgent,
  leaveHeadlessAgent,
} from '../src/registry.js';

const SWARM_ID = DEFAULT_SWARM_ID;
let db: SwarmDb;
let tempDir: string;

function insertMessage(
  from: string,
  to: string | null,
  body: string,
  createdAt: string = new Date().toISOString(),
  kind: string | null = null,
  swarmId: string = SWARM_ID
): number {
  const result = db.prepare(`
    INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at, kind)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(swarmId, from, to, body, createdAt, kind);
  return Number(result.lastInsertRowid);
}

function cursor(name: string): number {
  const row = db.prepare(`
    SELECT last_read_id FROM inbox_cursors
    WHERE swarm_id = ? AND agent_name = ? COLLATE NOCASE
  `).get(SWARM_ID, name) as { last_read_id: number };
  return row.last_read_id;
}

describe('SWARM-NEXT mailbox delivery and supersession', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-next-mailbox-'));
    db = getDbAt(path.join(tempDir, 'swarm.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('all join modes fence historical broadcasts while recent replay remains available', () => {
    const historicalId = insertMessage('Lead', null, 'historical doctrine');

    joinAgent(db, SWARM_ID, 'Cmux', 'surface-cmux', 'workspace', process.ppid);
    joinHeadlessAgent(db, SWARM_ID, 'Headless');
    joinA2AAgent(db, SWARM_ID, 'Remote', 'http://localhost:18789');

    for (const name of ['Cmux', 'Headless', 'Remote']) {
      assert.strictEqual(cursor(name), historicalId);
      assert.deepStrictEqual(getInbox(db, SWARM_ID, name, true), []);
      assert.deepStrictEqual(getRecentMessages(db, SWARM_ID, name).map(message => message.id), [historicalId]);
    }
  });

  test('rejoining an existing name retains its cursor and exposes messages missed while away', () => {
    const historicalId = insertMessage('Lead', null, 'before first join');
    joinHeadlessAgent(db, SWARM_ID, 'Returner');
    assert.strictEqual(cursor('Returner'), historicalId);

    leaveHeadlessAgent(db, SWARM_ID, 'Returner');
    const missedId = insertMessage('Lead', null, 'missed while away');
    joinHeadlessAgent(db, SWARM_ID, 'returner');

    assert.strictEqual(cursor('Returner'), historicalId);
    assert.deepStrictEqual(getInbox(db, SWARM_ID, 'Returner', true).map(message => message.id), [missedId]);
  });

  test('same-name replacement does not inherit a durable broadcast delivery bound to the prior registration', async () => {
    joinHeadlessAgent(db, SWARM_ID, 'Alice');
    const prior = joinHeadlessAgent(db, SWARM_ID, 'Bob');
    const sent = await broadcastMessage(db, SWARM_ID, 'Alice', 'exact audience');
    assert.ok(sent.messageId);

    assert.strictEqual(leaveHeadlessAgent(db, SWARM_ID, 'Bob'), true);
    const replacement = joinHeadlessAgent(db, SWARM_ID, 'Bob');
    assert.notStrictEqual(replacement.id, prior.id);
    assert.deepStrictEqual(getInbox(db, SWARM_ID, 'Bob', true), []);
    assert.throws(
      () => acknowledgeMessages(db, SWARM_ID, 'Bob', [sent.messageId!]),
      /not addressed to you/
    );
  });

  test('only the owner may supersede and a replacement hides its target for every recipient', async () => {
    for (const name of ['Alice', 'Bob', 'Carol']) joinHeadlessAgent(db, SWARM_ID, name);
    const original = await broadcastMessage(db, SWARM_ID, 'Alice', 'old order');
    assert.ok(original.messageId);

    assert.deepStrictEqual(getInbox(db, SWARM_ID, 'Bob', true).map(message => message.body), ['old order']);
    assert.deepStrictEqual(getInbox(db, SWARM_ID, 'Carol', true).map(message => message.body), ['old order']);

    const replacement = await sendMessage(
      db, SWARM_ID, 'aLiCe', 'Bob', 'replacement order', undefined, null, original.messageId
    );
    assert.ok(replacement.messageId);
    assert.deepStrictEqual(getInbox(db, SWARM_ID, 'Bob', true).map(message => message.body), ['replacement order']);
    assert.deepStrictEqual(getInbox(db, SWARM_ID, 'Carol', true), []);

    const before = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    await assert.rejects(
      sendMessage(db, SWARM_ID, 'Carol', 'Bob', 'unauthorized replacement', undefined, null, original.messageId),
      /you can only supersede your own messages/
    );
    const after = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    assert.strictEqual(after, before, 'a refused supersession must not insert a new message');

    const other = getOrCreateSwarm(db, 'other');
    joinHeadlessAgent(db, other.id, 'Alice');
    joinHeadlessAgent(db, other.id, 'Bob');
    await assert.rejects(
      sendMessage(db, other.id, 'Alice', 'Bob', 'cross-swarm replacement', undefined, null, original.messageId),
      /you can only supersede your own messages/
    );
  });

  test('supersession chains keep only the last message live and preserve forward tombstones', async () => {
    joinHeadlessAgent(db, SWARM_ID, 'Alice');
    joinHeadlessAgent(db, SWARM_ID, 'Bob');
    const first = await broadcastMessage(db, SWARM_ID, 'Alice', 'A');
    const second = await broadcastMessage(db, SWARM_ID, 'Alice', 'B', undefined, null, first.messageId);
    const third = await broadcastMessage(db, SWARM_ID, 'Alice', 'C', undefined, null, second.messageId);

    assert.deepStrictEqual(getInbox(db, SWARM_ID, 'Bob', true).map(message => message.body), ['C']);
    const history = getRecentMessages(db, SWARM_ID, 'Bob');
    assert.deepStrictEqual(history.map(message => message.body), ['A', 'B', 'C']);
    assert.deepStrictEqual(
      history.map(message => message.superseded_by),
      [second.messageId, third.messageId, null]
    );
  });

  test('hook-style peek survives turn loss and the third injection collapses without acknowledgement', () => {
    joinHeadlessAgent(db, SWARM_ID, 'Bob');
    const id = insertMessage('Alice', 'Bob', 'do not lose this');

    const firstPeek = getInbox(db, SWARM_ID, 'Bob', true);
    const first = recordHookInjections(db, SWARM_ID, 'Bob', firstPeek);
    assert.strictEqual(first[0].collapsed, false);
    assert.strictEqual(first[0].delivery.inject_count, 1);
    assert.strictEqual(cursor('Bob'), 0, 'hook peek must not advance the legacy cursor');

    const second = recordHookInjections(db, SWARM_ID, 'Bob', getInbox(db, SWARM_ID, 'Bob', true));
    assert.strictEqual(second[0].collapsed, false);
    const third = recordHookInjections(db, SWARM_ID, 'Bob', getInbox(db, SWARM_ID, 'Bob', true));
    assert.strictEqual(third[0].message.id, id);
    assert.strictEqual(third[0].delivery.inject_count, HOOK_INJECT_COLLAPSE_COUNT);
    assert.strictEqual(third[0].collapsed, true);
    assert.strictEqual(cursor('Bob'), 0);
  });

  test('a message injected longer than the fixed backoff collapses even below the count threshold', () => {
    joinHeadlessAgent(db, SWARM_ID, 'Bob');
    const id = insertMessage('Alice', 'Bob', 'aged injection');
    getInbox(db, SWARM_ID, 'Bob', true);
    const now = Date.now();
    db.prepare(`
      UPDATE message_deliveries
      SET status = 'injected', first_injected_at = ?, inject_count = 1
      WHERE message_id = ? AND recipient = ? COLLATE NOCASE
    `).run(new Date(now - (HOOK_INJECT_BACKOFF_MINUTES + 1) * 60_000).toISOString(), id, 'Bob');

    const entries = recordHookInjections(db, SWARM_ID, 'Bob', getInbox(db, SWARM_ID, 'Bob', true), now);
    assert.strictEqual(entries[0].collapsed, true);
    assert.ok(entries[0].unackedMinutes >= HOOK_INJECT_BACKOFF_MINUTES + 1);
  });

  test('ack is idempotent, advances the legacy watermark, and preserves lower pending deliveries', () => {
    joinHeadlessAgent(db, SWARM_ID, 'Bob');
    const low = insertMessage('Alice', 'Bob', 'low');
    const high = insertMessage('Alice', 'Bob', 'high');
    getInbox(db, SWARM_ID, 'Bob', true);

    acknowledgeMessages(db, SWARM_ID, 'Bob', [high], 1_000);
    acknowledgeMessages(db, SWARM_ID, 'bob', [high], 2_000);
    const highDelivery = db.prepare(`
      SELECT * FROM message_deliveries WHERE message_id = ? AND recipient = ? COLLATE NOCASE
    `).get(high, 'Bob') as any;
    assert.strictEqual(highDelivery.status, 'acked');
    assert.strictEqual(highDelivery.acked_at, new Date(1_000).toISOString());
    assert.strictEqual(cursor('Bob'), high);
    assert.deepStrictEqual(getInbox(db, SWARM_ID, 'Bob', true).map(message => message.id), [low]);

    acknowledgeMessages(db, SWARM_ID, 'Bob', [low]);
    assert.strictEqual(cursor('Bob'), high, 'acknowledging a lower ID must never move the cursor backwards');
    assert.deepStrictEqual(getInbox(db, SWARM_ID, 'Bob', true), []);
  });

  test('plain inbox acknowledges exactly what it returns, ordered by id with a max-id watermark', () => {
    joinHeadlessAgent(db, SWARM_ID, 'Bob');
    const newerTimestamp = new Date(Date.now() + 60_000).toISOString();
    const olderTimestamp = new Date(Date.now() - 60_000).toISOString();
    const firstId = insertMessage('Alice', 'Bob', 'first id', newerTimestamp);
    const secondId = insertMessage('Alice', 'Bob', 'second id', olderTimestamp);

    const printed = getInbox(db, SWARM_ID, 'Bob');
    assert.deepStrictEqual(printed.map(message => message.id), [firstId, secondId]);
    assert.strictEqual(cursor('Bob'), Math.max(firstId, secondId));
    const deliveries = db.prepare(`
      SELECT message_id, status FROM message_deliveries
      WHERE recipient = ? COLLATE NOCASE ORDER BY message_id
    `).all('Bob') as Array<{ message_id: number; status: string }>;
    assert.deepStrictEqual(deliveries.map(delivery => ({ ...delivery })), [
      { message_id: firstId, status: 'acked' },
      { message_id: secondId, status: 'acked' },
    ]);
    assert.deepStrictEqual(getInbox(db, SWARM_ID, 'Bob'), []);
  });

  test('inbox wait polls with an injected clock until a message arrives and reports timeout distinctly', async () => {
    joinHeadlessAgent(db, SWARM_ID, 'Bob');
    let now = 0;
    const arrivals: number[] = [];
    const sleeps: number[] = [];
    const arrived = await waitForInbox(db, SWARM_ID, 'Bob', {
      timeoutSeconds: 10,
      now: () => now,
      sleep: async milliseconds => {
        sleeps.push(milliseconds);
        now += milliseconds;
        if (now === 4_000) arrivals.push(insertMessage('Alice', 'Bob', 'arrived while waiting'));
      },
    });
    assert.strictEqual(arrived.timedOut, false);
    assert.deepStrictEqual(arrived.messages.map(message => message.id), arrivals);
    assert.deepStrictEqual(sleeps, [2_000, 2_000]);
    assert.strictEqual(cursor('Bob'), arrivals[0], 'the normal wait path acknowledges what it returns');
    assert.strictEqual(
      (db.prepare('SELECT status FROM message_deliveries WHERE message_id = ?').get(arrivals[0]) as any).status,
      'acked'
    );

    now = 0;
    sleeps.length = 0;
    const timedOut = await waitForInbox(db, SWARM_ID, 'Bob', {
      timeoutSeconds: 5,
      now: () => now,
      sleep: async milliseconds => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    assert.deepStrictEqual(timedOut, { messages: [], timedOut: true });
    assert.deepStrictEqual(sleeps, [2_000, 2_000, 1_000]);
  });

  test('peek, recent, and kind-filtered reads never acknowledge messages', () => {
    joinHeadlessAgent(db, SWARM_ID, 'Bob');
    const gate = insertMessage('Alice', 'Bob', 'gate', new Date().toISOString(), 'gate');
    const status = insertMessage('Alice', 'Bob', 'status', new Date().toISOString(), 'status');

    assert.deepStrictEqual(getInbox(db, SWARM_ID, 'Bob', false, 'gate').map(message => message.id), [gate]);
    assert.strictEqual(cursor('Bob'), 0);
    assert.strictEqual(
      (db.prepare('SELECT status FROM message_deliveries WHERE message_id = ?').get(gate) as any).status,
      'pending'
    );

    getInbox(db, SWARM_ID, 'Bob', true);
    getRecentMessages(db, SWARM_ID, 'Bob');
    const acked = db.prepare(`
      SELECT COUNT(*) AS n FROM message_deliveries
      WHERE recipient = ? COLLATE NOCASE AND status = 'acked'
    `).get('Bob') as { n: number };
    assert.strictEqual(acked.n, 0);
    assert.strictEqual(cursor('Bob'), 0);
    assert.deepStrictEqual(acknowledgeMessages(db, SWARM_ID, 'Bob', [gate, status]), [gate, status]);
  });

  test('new durable-outbox messages eagerly bind delivery rows while legacy rows still use the cursor', async () => {
    const historical = insertMessage('Alice', null, 'pre-join history');
    joinHeadlessAgent(db, SWARM_ID, 'Bob');
    joinHeadlessAgent(db, SWARM_ID, 'Alice');
    const sent = await sendMessage(db, SWARM_ID, 'Alice', 'Bob', 'post-join message');
    assert.ok(sent.messageId);
    assert.strictEqual((db.prepare('SELECT COUNT(*) AS n FROM message_deliveries').get() as { n: number }).n, 1);

    const visible = getInbox(db, SWARM_ID, 'Bob', true);
    assert.deepStrictEqual(visible.map(message => message.id), [sent.messageId]);
    assert.strictEqual((db.prepare('SELECT COUNT(*) AS n FROM message_deliveries').get() as { n: number }).n, 1);
    assert.strictEqual(cursor('Bob'), historical);

    const history = getRecentMessages(db, SWARM_ID, 'Bob');
    assert.deepStrictEqual(history.map(message => message.id), [historical, sent.messageId]);
    assert.strictEqual(
      (db.prepare('SELECT COUNT(*) AS n FROM message_deliveries WHERE message_id = ?').get(historical) as { n: number }).n,
      0,
      'archaeology must not turn fenced history into pending live delivery'
    );
  });
});
