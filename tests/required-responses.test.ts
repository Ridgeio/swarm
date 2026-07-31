import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SWARM_ID,
  getDbAt,
  withImmediateTransaction,
  type SwarmDb,
} from '../src/db.js';
import {
  acknowledgeMessages,
  enqueueDirectMessage,
  flushMessageOutbox,
  getInbox,
  getRequiredResponse,
  sendMessage,
  sweepRequiredResponses,
} from '../src/mailbox.js';
import {
  joinHeadlessAgent,
  joinA2AAgent,
  leaveHeadlessAgent,
  type Agent,
} from '../src/registry.js';

const INDEX = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const SWARM_ID = DEFAULT_SWARM_ID;

function registration(db: SwarmDb, name: string): Agent {
  return db.prepare(
    'SELECT * FROM agents WHERE swarm_id = ? AND name = ? COLLATE NOCASE'
  ).get(SWARM_ID, name) as unknown as Agent;
}

function enqueueRequired(
  db: SwarmDb,
  from: string,
  to: string,
  createdAt: number,
  requiredBy: number
): number {
  const source = registration(db, from);
  const target = registration(db, to);
  return withImmediateTransaction(db, () => enqueueDirectMessage(
    db,
    SWARM_ID,
    source.name,
    target.name,
    'Need a substantive answer.',
    {
      createdAt: new Date(createdAt).toISOString(),
      fromAgentId: source.id,
      recipientAgentId: target.id,
      requiredBy: new Date(requiredBy).toISOString(),
    }
  ));
}

describe('durable required replies', () => {
  let root: string;
  let db: SwarmDb;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-required-response-'));
    db = getDbAt(path.join(root, 'swarm.db'));
    joinHeadlessAgent(db, SWARM_ID, 'Lead');
    joinHeadlessAgent(db, SWARM_ID, 'Alice');
    joinHeadlessAgent(db, SWARM_ID, 'Bob');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('display is non-acking; exact transport ack and exact directed reply are separate atomic acts', async () => {
    const now = Date.now();
    const requestId = enqueueRequired(db, 'Alice', 'Bob', now, now + 10 * 60_000);

    assert.deepStrictEqual(getInbox(db, SWARM_ID, 'Bob').map(message => message.id), [requestId]);
    assert.strictEqual(getRequiredResponse(db, SWARM_ID, requestId)?.status, 'pending');
    assert.strictEqual(
      (db.prepare('SELECT status FROM message_deliveries WHERE message_id = ?').get(requestId) as { status: string }).status,
      'pending'
    );
    assert.strictEqual(
      (db.prepare('SELECT COUNT(*) AS n FROM message_outbox WHERE message_id = ?').get(requestId) as { n: number }).n,
      1,
      'display must not cancel a queued push'
    );
    assert.deepStrictEqual(acknowledgeMessages(db, SWARM_ID, 'Bob', [requestId]), [requestId]);
    assert.strictEqual(
      (db.prepare('SELECT status FROM message_deliveries WHERE message_id = ?').get(requestId) as { status: string }).status,
      'acked'
    );
    assert.strictEqual(
      (db.prepare('SELECT COUNT(*) AS n FROM message_outbox WHERE message_id = ?').get(requestId) as { n: number }).n,
      0,
      'an inbox acknowledgement must cancel a queued push so it cannot duplicate-deliver'
    );

    const beforeWrongRequester = (
      db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    ).n;
    await assert.rejects(
      sendMessage(
        db,
        SWARM_ID,
        'Bob',
        'Lead',
        'This must not resolve Alice’s request.',
        undefined,
        null,
        undefined,
        { replyTo: requestId }
      ),
      /exact original requester/
    );
    assert.strictEqual(
      (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
      beforeWrongRequester
    );

    const reply = await sendMessage(
      db,
      SWARM_ID,
      'Bob',
      'Alice',
      'The answer is complete.',
      undefined,
      null,
      undefined,
      { replyTo: requestId }
    );
    assert.ok(reply.messageId);
    assert.match(reply.message, /resolves required message/);
    const resolved = getRequiredResponse(db, SWARM_ID, requestId);
    assert.strictEqual(resolved?.status, 'resolved');
    assert.strictEqual(resolved?.reply_message_id, reply.messageId);
    assert.strictEqual(resolved?.resolved_at, (
      db.prepare('SELECT created_at FROM messages WHERE id = ?').get(reply.messageId!) as { created_at: string }
    ).created_at);
  });

  test('transport push carries the durable request ID, deadline, and exact reply command', async () => {
    joinA2AAgent(db, SWARM_ID, 'Remote', 'https://remote.invalid/a2a');
    const now = Date.now();
    const requiredBy = now + 10 * 60_000;
    const requestId = enqueueRequired(db, 'Alice', 'Remote', now, requiredBy);
    let pushed = '';

    const result = await flushMessageOutbox(db, [requestId], async (agent, formatted) => {
      assert.strictEqual(agent.agent_type, 'a2a');
      pushed = formatted;
      return { delivered: true };
    });

    assert.deepStrictEqual(result, { pushed: 1, queued: 0 });
    assert.strictEqual(
      pushed,
      `[SWARM from Alice]: Need a substantive answer.\n` +
      `[REPLY REQUIRED: request #${requestId}; due ${new Date(requiredBy).toISOString()}; ` +
      `resolve with: swarm send Alice "<answer>" --reply-to ${requestId}]`
    );
  });

  test('same-name replacement cannot inherit the obligation or resolve it; sweep dead-letters it once', async () => {
    const now = Date.now();
    const requestId = enqueueRequired(db, 'Alice', 'Bob', now, now + 60 * 60_000);
    const originalBob = registration(db, 'Bob');
    assert.strictEqual(leaveHeadlessAgent(db, SWARM_ID, 'Bob'), true);
    const replacementBob = joinHeadlessAgent(db, SWARM_ID, 'Bob');
    assert.notStrictEqual(replacementBob.id, originalBob.id);
    assert.deepStrictEqual(getInbox(db, SWARM_ID, 'Bob', true), []);

    const before = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    await assert.rejects(
      sendMessage(
        db,
        SWARM_ID,
        'Bob',
        'Alice',
        'I am not the original recipient.',
        undefined,
        null,
        undefined,
        { replyTo: requestId }
      ),
      /exact original requester/
    );
    assert.strictEqual(
      (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
      before,
      'a refused same-name reply must be side-effect free'
    );

    const swept = sweepRequiredResponses(db, SWARM_ID, now + 1);
    assert.deepStrictEqual(swept.expired.map(row => row.request_message_id), [requestId]);
    assert.match(swept.expired[0].expiry_reason ?? '', /recipient registration is inactive/);
    assert.deepStrictEqual(sweepRequiredResponses(db, SWARM_ID, now + 2), { expired: [] });

    const notificationRows = db.prepare(`
      SELECT n.audience, a.name
      FROM required_response_expiry_notifications n
      JOIN messages m ON m.id = n.message_id
      JOIN agents a ON a.id = n.recipient_agent_id
      WHERE n.request_id = ?
      ORDER BY n.audience, a.name
    `).all(swept.expired[0].id) as Array<{ audience: string; name: string }>;
    assert.deepStrictEqual(notificationRows.map(row => ({ ...row })), [
      { audience: 'authority', name: 'Lead' },
      { audience: 'sender', name: 'Alice' },
    ]);
  });

  test('late replies and wall-clock rollback fail closed, and message deletion preserves audit identity', () => {
    const now = Date.now();
    const requestId = enqueueRequired(db, 'Alice', 'Bob', now, now + 1_000);
    const alice = registration(db, 'Alice');
    const bob = registration(db, 'Bob');

    assert.throws(
      () => withImmediateTransaction(db, () => enqueueDirectMessage(
        db,
        SWARM_ID,
        bob.name,
        alice.name,
        'Too late.',
        {
          createdAt: new Date(now + 1_001).toISOString(),
          fromAgentId: bob.id,
          recipientAgentId: alice.id,
          replyTo: requestId,
        }
      )),
      /deadline .* has passed/
    );
    assert.strictEqual(getRequiredResponse(db, SWARM_ID, requestId)?.status, 'pending');
    sweepRequiredResponses(db, SWARM_ID, now + 1_001);

    enqueueRequired(db, 'Alice', 'Bob', now + 2_000, now + 4_000);
    assert.throws(
      () => sweepRequiredResponses(db, SWARM_ID, now + 1_500),
      /wall clock moved backwards/
    );

    db.prepare('DELETE FROM message_deliveries WHERE swarm_id = ?').run(SWARM_ID);
    db.prepare('DELETE FROM messages WHERE swarm_id = ?').run(SWARM_ID);
    const audit = db.prepare(`
      SELECT sender_agent_id, recipient_agent_id, request_message_id, reply_message_id
      FROM required_message_responses
      WHERE id = ?
    `).get(1) as {
      sender_agent_id: string;
      recipient_agent_id: string;
      request_message_id: number | null;
      reply_message_id: number | null;
    };
    assert.strictEqual(audit.sender_agent_id, alice.id);
    assert.strictEqual(audit.recipient_agent_id, bob.id);
    assert.strictEqual(audit.request_message_id, null);
    assert.strictEqual(audit.reply_message_id, null);
  });
});

interface CliResult {
  stdout: string;
  stderr: string;
  status: number;
}

function cliToken(home: string, name: string): string {
  const db = new DatabaseSync(path.join(home, '.swarm', 'swarm.db'), { readOnly: true });
  try {
    return (db.prepare('SELECT session_token FROM agents WHERE name = ? COLLATE NOCASE')
      .get(name) as { session_token: string | null } | undefined)?.session_token ?? '';
  } finally {
    db.close();
  }
}

function clearHeadlessMarker(home: string): void {
  const swarmDir = path.join(home, '.swarm');
  if (!fs.existsSync(swarmDir)) return;
  for (const name of fs.readdirSync(swarmDir)) {
    if (name.startsWith('headless-')) fs.rmSync(path.join(swarmDir, name), { force: true });
  }
}

function runCli(home: string, args: string[], agent?: string): CliResult {
  const dbPath = path.join(home, '.swarm', 'swarm.db');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    SWARM_ID: '',
    SWARM_NAME: '',
    SWARM_AGENT_NAME: agent ?? '',
    SWARM_SESSION_TOKEN: agent && fs.existsSync(dbPath) ? cliToken(home, agent) : '',
    CMUX_SURFACE_ID: '',
    CMUX_WORKSPACE_ID: '',
    TERM_PROGRAM: '',
    SWARM_TEST_DISABLE_BACKGROUND: '1',
  };
  const result = spawnSync('node', ['--import', 'tsx', INDEX, ...args], {
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

test('CLI prints persistent reply instructions and rejects malformed coordination before writing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-required-cli-'));
  try {
    assert.strictEqual(runCli(home, ['join', 'Alice', '--headless'], 'Alice').status, 0);
    clearHeadlessMarker(home);
    assert.strictEqual(runCli(home, ['join', 'Bob', '--headless'], 'Bob').status, 0);

    const malformed = runCli(home, ['send', 'Bob', 'question', '--require-reply', 'soon'], 'Alice');
    assert.notStrictEqual(malformed.status, 0);
    assert.match(malformed.stderr, /Invalid --require-reply/);
    const dbPath = path.join(home, '.swarm', 'swarm.db');
    let inspect = new DatabaseSync(dbPath, { readOnly: true });
    assert.strictEqual((inspect.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n, 0);
    inspect.close();

    for (const typoArgs of [
      ['send', 'Bob', 'question', '--require-replly', '15m'],
      ['send', 'Bob', 'question', '--requre-reply', '15m'],
      ['send', 'Bob', 'answer', '--replly-to', '1'],
      ['send', 'Bob', 'question', '--Require-reply', '15m'],
      ['send', 'Bob', 'question', '--supersdes', '1'],
    ]) {
      const typo = runCli(home, typoArgs, 'Alice');
      assert.notStrictEqual(typo.status, 0);
      assert.match(typo.stderr, /Unknown send coordination option/);
    }
    inspect = new DatabaseSync(dbPath, { readOnly: true });
    const typoCounts = inspect.prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM required_message_responses) AS required_responses
    `).get() as { messages: number; required_responses: number };
    assert.deepStrictEqual({ ...typoCounts }, { messages: 0, required_responses: 0 });
    inspect.close();

    for (const forbidden of [
      ['broadcast', 'question', '--require-reply', '15m'],
      ['broadcast', 'answer', '--reply-to', '1'],
      ['broadcast', 'question', '--require-replly', '15m'],
    ]) {
      const rejected = runCli(home, forbidden, 'Alice');
      assert.notStrictEqual(rejected.status, 0);
      assert.match(rejected.stderr, /cannot be broadcast|Unknown broadcast coordination option/);
    }
    inspect = new DatabaseSync(dbPath, { readOnly: true });
    assert.strictEqual(
      (inspect.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
      0,
      'forbidden broadcast coordination flags must fail before any message write'
    );
    assert.strictEqual(
      (inspect.prepare('SELECT COUNT(*) AS n FROM required_message_responses').get() as { n: number }).n,
      0,
      'forbidden broadcast coordination flags must fail before any required-response write'
    );
    inspect.close();

    const quotedLiteral = runCli(
      home,
      ['send', 'Bob', '--require-replly is invalid syntax'],
      'Alice'
    );
    assert.strictEqual(quotedLiteral.status, 0, quotedLiteral.stderr || quotedLiteral.stdout);
    const delimitedLiteral = runCli(
      home,
      ['send', 'Bob', '--', '--requre-reply', 'is', 'literal text'],
      'Alice'
    );
    assert.strictEqual(delimitedLiteral.status, 0, delimitedLiteral.stderr || delimitedLiteral.stdout);
    const repeatedLiteral = runCli(
      home,
      ['send', 'Bob', '--', '--reply-to', 'one', '--reply-to', 'two'],
      'Alice'
    );
    assert.strictEqual(repeatedLiteral.status, 0, repeatedLiteral.stderr || repeatedLiteral.stdout);
    inspect = new DatabaseSync(dbPath, { readOnly: true });
    assert.deepStrictEqual(
      (inspect.prepare('SELECT body FROM messages ORDER BY id').all() as Array<{ body: string }>)
        .map(row => row.body),
      [
        '--require-replly is invalid syntax',
        '--requre-reply is literal text',
        '--reply-to one --reply-to two',
      ]
    );
    assert.strictEqual(
      (inspect.prepare('SELECT COUNT(*) AS n FROM required_message_responses').get() as { n: number }).n,
      0
    );
    inspect.close();

    const sent = runCli(
      home,
      [
        'send',
        'Bob',
        'question',
        '--require-reply',
        '15m',
        '--',
        '--require-reply',
        'is literal text',
      ],
      'Alice'
    );
    assert.strictEqual(sent.status, 0, sent.stderr || sent.stdout);
    assert.match(sent.stdout, /reply required by/);
    inspect = new DatabaseSync(dbPath, { readOnly: true });
    const request = inspect.prepare(`
      SELECT request_message_id FROM required_message_responses WHERE status = 'pending'
    `).get() as { request_message_id: number };
    inspect.close();
    assert.match(sent.stdout, new RegExp(`request #${request.request_message_id}`));
    const requesterView = runCli(home, ['replies'], 'Alice');
    assert.strictEqual(requesterView.status, 0, requesterView.stderr || requesterView.stdout);
    assert.match(
      requesterView.stdout,
      new RegExp(`#${request.request_message_id} pending — awaiting Bob; due`)
    );

    const inbox = runCli(home, ['inbox'], 'Bob');
    assert.strictEqual(inbox.status, 0, inbox.stderr || inbox.stdout);
    assert.match(
      inbox.stdout,
      new RegExp(`REPLY REQUIRED by .*swarm send Alice "<answer>" --reply-to ${request.request_message_id}`)
    );
    const transportAck = runCli(home, ['ack', String(request.request_message_id)], 'Bob');
    assert.strictEqual(transportAck.status, 0, transportAck.stderr || transportAck.stdout);
    const hook = runCli(home, ['hook-context'], 'Bob');
    assert.strictEqual(hook.status, 0, hook.stderr || hook.stdout);
    assert.match(hook.stdout, new RegExp(`REPLY REQUIRED #${request.request_message_id} from Alice`));

    const reply = runCli(
      home,
      ['send', 'Alice', 'complete answer', '--reply-to', String(request.request_message_id)],
      'Bob'
    );
    assert.strictEqual(reply.status, 0, reply.stderr || reply.stdout);
    assert.match(reply.stdout, new RegExp(`resolves required message #${request.request_message_id}`));
    inspect = new DatabaseSync(dbPath, { readOnly: true });
    assert.strictEqual(
      (inspect.prepare('SELECT status FROM required_message_responses').get() as { status: string }).status,
      'resolved'
    );
    inspect.close();
    const history = runCli(home, ['replies', '--history'], 'Bob');
    assert.strictEqual(history.status, 0, history.stderr || history.stdout);
    assert.match(
      history.stdout,
      new RegExp(`#${request.request_message_id} resolved — Alice -> Bob; reply #\\d+`)
    );

    const conflicting = runCli(
      home,
      [
        'send',
        'Bob',
        'ambiguous',
        '--require-reply',
        '15m',
        '--reply-to',
        String(request.request_message_id),
      ],
      'Alice'
    );
    assert.notStrictEqual(conflicting.status, 0);
    assert.match(conflicting.stderr, /mutually exclusive/);

    const pendingAtReset = runCli(
      home,
      ['send', 'Bob', 'last question', '--require-reply', '15m'],
      'Alice'
    );
    assert.strictEqual(pendingAtReset.status, 0, pendingAtReset.stderr || pendingAtReset.stdout);
    const pendingId = Number(pendingAtReset.stdout.match(/request #(\d+)/)?.[1]);
    assert.ok(Number.isSafeInteger(pendingId));
    inspect = new DatabaseSync(dbPath);
    inspect.prepare(`
      UPDATE required_message_responses
      SET required_by = '1970-01-01T00:00:00.000Z'
      WHERE request_message_id = ?
    `).run(pendingId);
    inspect.close();
    const invalidInbox = runCli(home, ['inbox', '--wait', 'not-a-number'], 'Bob');
    assert.notStrictEqual(invalidInbox.status, 0);
    inspect = new DatabaseSync(dbPath, { readOnly: true });
    assert.strictEqual(
      (inspect.prepare(`
        SELECT status FROM required_message_responses WHERE request_message_id = ?
      `).get(pendingId) as { status: string }).status,
      'pending',
      'invalid inbox syntax must not run the required-response sweep'
    );
    inspect.close();

    const reset = runCli(home, ['reset'], 'Alice');
    assert.strictEqual(reset.status, 0, reset.stderr || reset.stdout);
    inspect = new DatabaseSync(dbPath, { readOnly: true });
    const resetRow = inspect.prepare(`
      SELECT status, request_message_id, expiry_reason
      FROM required_message_responses
      WHERE status = 'expired'
      ORDER BY id DESC
      LIMIT 1
    `).get() as {
      status: string;
      request_message_id: number | null;
      expiry_reason: string;
    };
    assert.deepStrictEqual({ ...resetRow }, {
      status: 'expired',
      request_message_id: null,
      expiry_reason: 'swarm reset ended registration generation',
    });
    inspect.close();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
