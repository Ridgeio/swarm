import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const TSX_IMPORT = import.meta.resolve('tsx');
const homes: string[] = [];

interface CliResult {
  stdout: string;
  stderr: string;
  status: number;
}

function tempHome(prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  homes.push(home);
  return home;
}

function identityToken(home: string, agent: string): string {
  const dbPath = path.join(home, '.swarm', 'swarm.db');
  if (!fs.existsSync(dbPath)) return '';
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT session_token FROM agents WHERE name = ? COLLATE NOCASE')
      .get(agent) as { session_token: string | null } | undefined;
    return row?.session_token ?? '';
  } finally {
    db.close();
  }
}

function runCli(home: string, args: string[], agent?: string): CliResult {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    SWARM_ID: '',
    SWARM_NAME: '',
    SWARM_AGENT_NAME: agent ?? '',
    SWARM_SESSION_TOKEN: agent ? identityToken(home, agent) : '',
    CMUX_SURFACE_ID: '',
    CMUX_WORKSPACE_ID: '',
    TERM_PROGRAM: '',
    CODEX_CLI: '',
    CODEX_CI: '',
    CODEX_THREAD_ID: '',
    CODEX_MANAGED_BY_NPM: '',
    CLAUDE_CODE: '',
    GROK_AGENT: '',
    SWARM_TEST_DISABLE_BACKGROUND: '1',
  };
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  try {
    const stdout = execFileSync('node', ['--import', TSX_IMPORT, INDEX, ...args], {
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
      status: typeof error.status === 'number' ? error.status : 1,
    };
  }
}

function join(home: string, agent: string, force: boolean = false): void {
  const args = ['join', agent, '--headless'];
  if (force) args.push('--force');
  const result = runCli(home, args, agent);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const swarmDir = path.join(home, '.swarm');
  for (const entry of fs.readdirSync(swarmDir)) {
    if (entry.startsWith('headless-')) fs.rmSync(path.join(swarmDir, entry), { force: true });
  }
}

function openDb(home: string): DatabaseSync {
  return new DatabaseSync(path.join(home, '.swarm', 'swarm.db'));
}

function createCheckpointedTask(home: string, slug: string = 'async-handoff'): void {
  const started = runCli(home, [
    'task', 'start', slug, '--title', 'Deterministic async transfer', '--no-worktree',
  ], 'Alice');
  assert.strictEqual(started.status, 0, started.stderr || started.stdout);
  const checkpoint = runCli(home, [
    'task', 'checkpoint', slug, '--notes', 'Charter is complete and source retains authority.',
  ], 'Alice');
  assert.strictEqual(checkpoint.status, 0, checkpoint.stderr || checkpoint.stdout);
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('two-phase asynchronous task handoff', () => {
  test('offer retains the source lease; acknowledged pickup is sender-visible; accept atomically transfers the exact charter epoch', () => {
    const home = tempHome('swarm-handoff-offer-');
    join(home, 'Alice');
    join(home, 'Bob');
    createCheckpointedTask(home);

    const offered = runCli(home, [
      'handoff', 'offer', 'async-handoff', '--to', 'Bob', '--ttl', '15m',
    ], 'Alice');
    assert.strictEqual(offered.status, 0, offered.stderr || offered.stdout);
    assert.match(offered.stdout, /source owner Alice retains lease epoch 1 until acceptance/);
    const offerId = Number(offered.stdout.match(/Handoff offer #(\d+)/)?.[1]);
    const digest = offered.stdout.match(/charter sha256: ([0-9a-f]{64})/)?.[1];
    const briefPath = offered.stdout.match(/^Brief: (.+)$/m)?.[1];
    assert.ok(Number.isSafeInteger(offerId) && offerId > 0);
    assert.ok(digest);
    assert.ok(briefPath);
    assert.strictEqual(
      createHash('sha256').update(fs.readFileSync(briefPath!, 'utf-8')).digest('hex'),
      digest
    );

    let db = openDb(home);
    const sourceTask = db.prepare("SELECT owner_agent, lease_epoch FROM tasks WHERE id = 'async-handoff'")
      .get() as { owner_agent: string; lease_epoch: number };
    assert.deepStrictEqual({ ...sourceTask }, { owner_agent: 'Alice', lease_epoch: 1 });
    const offer = db.prepare('SELECT * FROM handoff_offers WHERE id = ?').get(offerId) as any;
    assert.strictEqual(offer.status, 'pending');
    assert.strictEqual(offer.source_epoch, 1);
    assert.strictEqual(offer.charter_sha256, digest);
    assert.ok(offer.message_id);
    const offeredEvent = db.prepare(
      "SELECT epoch, data FROM task_events WHERE task_id = 'async-handoff' AND kind = 'handoff_offered'"
    ).get() as { epoch: number; data: string };
    assert.strictEqual(offeredEvent.epoch, 1);
    assert.strictEqual(JSON.parse(offeredEvent.data).charter_sha256, digest);
    db.close();

    const pickedUp = runCli(home, ['inbox'], 'Bob');
    assert.strictEqual(pickedUp.status, 0, pickedUp.stderr || pickedUp.stdout);
    assert.match(pickedUp.stdout, new RegExp(`Handoff offer #${offerId}`));
    const senderStatus = runCli(home, ['handoff', 'status', 'async-handoff'], 'Alice');
    assert.strictEqual(senderStatus.status, 0, senderStatus.stderr || senderStatus.stdout);
    assert.match(senderStatus.stdout, new RegExp(`#${offerId} async-handoff \\[pending\\].*pickup acked`));

    const accepted = runCli(home, [
      'handoff', 'accept', 'async-handoff', '--offer', String(offerId),
    ], 'Bob');
    assert.strictEqual(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.match(accepted.stdout, /owned by Bob at lease epoch 2/);
    assert.match(accepted.stdout, new RegExp(`Charter sha256: ${digest}`));

    db = openDb(home);
    const transferred = db.prepare("SELECT owner_agent, lease_epoch FROM tasks WHERE id = 'async-handoff'")
      .get() as { owner_agent: string; lease_epoch: number };
    assert.deepStrictEqual({ ...transferred }, { owner_agent: 'Bob', lease_epoch: 2 });
    const acceptedOffer = db.prepare('SELECT status, resolved_by, accepted_epoch FROM handoff_offers WHERE id = ?')
      .get(offerId) as { status: string; resolved_by: string; accepted_epoch: number };
    assert.deepStrictEqual(
      { ...acceptedOffer },
      { status: 'accepted', resolved_by: 'Bob', accepted_epoch: 2 }
    );
    const acceptedEvent = db.prepare(
      "SELECT epoch, actor, data FROM task_events WHERE task_id = 'async-handoff' AND kind = 'handoff_accepted'"
    ).get() as { epoch: number; actor: string; data: string };
    assert.strictEqual(acceptedEvent.epoch, 2);
    assert.strictEqual(acceptedEvent.actor, 'Bob');
    assert.strictEqual(JSON.parse(acceptedEvent.data).source_epoch, 1);
    db.close();

    const recipientCheckpoint = runCli(home, [
      'task', 'checkpoint', 'async-handoff', '--notes', 'Accepted exact charter and continuing.',
    ], 'Bob');
    assert.strictEqual(recipientCheckpoint.status, 0, recipientCheckpoint.stderr || recipientCheckpoint.stdout);
    const staleSource = runCli(home, [
      'task', 'checkpoint', 'async-handoff', '--notes', 'This must be fenced.',
    ], 'Alice');
    assert.notStrictEqual(staleSource.status, 0);
    assert.match(staleSource.stderr, /Refused stale task authority.*owner is "Bob".*epoch 2/s);
  });

  test('a changed charter invalidates the offer and never transfers the source lease', () => {
    const home = tempHome('swarm-handoff-tamper-');
    join(home, 'Alice');
    join(home, 'Bob');
    createCheckpointedTask(home, 'tamper-charter');
    const offered = runCli(home, [
      'handoff', 'offer', 'tamper-charter', '--to', 'Bob',
    ], 'Alice');
    assert.strictEqual(offered.status, 0, offered.stderr || offered.stdout);
    const offerId = Number(offered.stdout.match(/Handoff offer #(\d+)/)?.[1]);
    const briefPath = offered.stdout.match(/^Brief: (.+)$/m)?.[1];
    assert.ok(briefPath);
    fs.appendFileSync(briefPath!, '\nunauthorized charter change\n');

    const accepted = runCli(home, [
      'handoff', 'accept', 'tamper-charter', '--offer', String(offerId),
    ], 'Bob');
    assert.notStrictEqual(accepted.status, 0);
    assert.match(accepted.stderr, /charter digest mismatch.*source lease was not transferred/s);

    const db = openDb(home);
    const task = db.prepare("SELECT owner_agent, lease_epoch FROM tasks WHERE id = 'tamper-charter'")
      .get() as { owner_agent: string; lease_epoch: number };
    assert.deepStrictEqual({ ...task }, { owner_agent: 'Alice', lease_epoch: 1 });
    const offer = db.prepare('SELECT status FROM handoff_offers WHERE id = ?').get(offerId) as { status: string };
    assert.strictEqual(offer.status, 'invalidated');
    const event = db.prepare(
      "SELECT data FROM task_events WHERE task_id = 'tamper-charter' AND kind = 'handoff_offer_invalidated'"
    ).get() as { data: string };
    assert.match(JSON.parse(event.data).reason, /charter digest mismatch/);
    db.close();
  });

  test('a rejoined same-name recipient cannot accept an offer bound to the prior registration', () => {
    const home = tempHome('swarm-handoff-recipient-id-');
    join(home, 'Alice');
    join(home, 'Bob');
    createCheckpointedTask(home, 'recipient-binding');
    const offered = runCli(home, [
      'handoff', 'offer', 'recipient-binding', '--to', 'Bob',
    ], 'Alice');
    assert.strictEqual(offered.status, 0, offered.stderr || offered.stdout);
    const offerId = Number(offered.stdout.match(/Handoff offer #(\d+)/)?.[1]);

    let db = openDb(home);
    const prior = db.prepare("SELECT id FROM agents WHERE name = 'Bob'").get() as { id: string };
    db.close();
    join(home, 'Bob', true);
    db = openDb(home);
    const replacement = db.prepare("SELECT id FROM agents WHERE name = 'Bob'").get() as { id: string };
    db.close();
    assert.notStrictEqual(replacement.id, prior.id);

    const replacementStatus = runCli(home, ['handoff', 'status', 'recipient-binding'], 'Bob');
    assert.strictEqual(replacementStatus.status, 0, replacementStatus.stderr || replacementStatus.stdout);
    assert.match(replacementStatus.stdout, /No handoff offers recorded/);
    const replacementInbox = runCli(home, ['inbox', '--peek'], 'Bob');
    assert.strictEqual(replacementInbox.status, 0, replacementInbox.stderr || replacementInbox.stdout);
    assert.match(replacementInbox.stdout, /No new messages/);

    const accepted = runCli(home, [
      'handoff', 'accept', 'recipient-binding', '--offer', String(offerId),
    ], 'Bob');
    assert.notStrictEqual(accepted.status, 0);
    assert.match(accepted.stderr, /No handoff offer.*is addressed to Bob/s);

    db = openDb(home);
    const task = db.prepare("SELECT owner_agent, lease_epoch FROM tasks WHERE id = 'recipient-binding'")
      .get() as { owner_agent: string; lease_epoch: number };
    assert.deepStrictEqual({ ...task }, { owner_agent: 'Alice', lease_epoch: 1 });
    assert.strictEqual(
      (db.prepare('SELECT status FROM handoff_offers WHERE id = ?').get(offerId) as { status: string }).status,
      'pending',
      'a same-name replacement must not mutate an offer bound to the prior registration'
    );
    db.close();
  });

  test('deadline sweep dead-letters an unaccepted offer and the hook tells the source that authority stayed put', () => {
    const home = tempHome('swarm-handoff-expiry-');
    join(home, 'Alice');
    join(home, 'Bob');
    createCheckpointedTask(home, 'deadline-task');
    const offered = runCli(home, [
      'handoff', 'offer', 'deadline-task', '--to', 'Bob',
    ], 'Alice');
    assert.strictEqual(offered.status, 0, offered.stderr || offered.stdout);
    const offerId = Number(offered.stdout.match(/Handoff offer #(\d+)/)?.[1]);

    let db = openDb(home);
    db.prepare('UPDATE handoff_offers SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', offerId);
    db.close();

    const status = runCli(home, ['handoff', 'status', 'deadline-task'], 'Alice');
    assert.strictEqual(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, new RegExp(`#${offerId} deadline-task \\[expired\\]`));
    const hook = runCli(home, ['hook-context'], 'Alice');
    assert.strictEqual(hook.status, 0, hook.stderr || hook.stdout);
    assert.match(hook.stdout, new RegExp(`Handoff DEAD LETTER #${offerId}: deadline-task is expired`));
    assert.match(hook.stdout, /source lease was not transferred/);

    const late = runCli(home, [
      'handoff', 'accept', 'deadline-task', '--offer', String(offerId),
    ], 'Bob');
    assert.notStrictEqual(late.status, 0);
    assert.match(late.stderr, /is expired; it cannot transfer a lease/);

    db = openDb(home);
    const task = db.prepare("SELECT owner_agent, lease_epoch FROM tasks WHERE id = 'deadline-task'")
      .get() as { owner_agent: string; lease_epoch: number };
    assert.deepStrictEqual({ ...task }, { owner_agent: 'Alice', lease_epoch: 1 });
    assert.strictEqual(
      (db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE kind = ? AND task_id = ?')
        .get('handoff_offer_expired', 'deadline-task') as { n: number }).n,
      1,
      'repeated status/hook sweeps must be idempotent'
    );
    db.close();
  });

  test('recipient decline and source cancel resolve offers without changing the lease', () => {
    const home = tempHome('swarm-handoff-resolve-');
    join(home, 'Alice');
    join(home, 'Bob');
    createCheckpointedTask(home, 'resolve-offer');
    const first = runCli(home, [
      'handoff', 'offer', 'resolve-offer', '--to', 'Bob',
    ], 'Alice');
    assert.strictEqual(first.status, 0, first.stderr || first.stdout);
    const firstId = Number(first.stdout.match(/Handoff offer #(\d+)/)?.[1]);
    const declined = runCli(home, [
      'handoff', 'decline', 'resolve-offer', '--offer', String(firstId),
      '--reason', 'need a narrower charter',
    ], 'Bob');
    assert.strictEqual(declined.status, 0, declined.stderr || declined.stdout);
    assert.match(declined.stdout, /remains owned by Alice at lease epoch 1/);

    const second = runCli(home, [
      'handoff', 'offer', 'resolve-offer', '--to', 'Bob',
    ], 'Alice');
    assert.strictEqual(second.status, 0, second.stderr || second.stdout);
    const secondId = Number(second.stdout.match(/Handoff offer #(\d+)/)?.[1]);
    const cancelled = runCli(home, [
      'handoff', 'cancel', 'resolve-offer', '--offer', String(secondId),
      '--reason', 'scope changed',
    ], 'Alice');
    assert.strictEqual(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
    assert.match(cancelled.stdout, /remains owned by Alice at lease epoch 1/);

    const db = openDb(home);
    const offers = db.prepare(
      'SELECT id, status FROM handoff_offers WHERE task_id = ? ORDER BY id'
    ).all('resolve-offer') as Array<{ id: number; status: string }>;
    assert.deepStrictEqual(
      offers.map(row => ({ ...row })),
      [
        { id: firstId, status: 'declined' },
        { id: secondId, status: 'cancelled' },
      ]
    );
    const task = db.prepare("SELECT owner_agent, lease_epoch FROM tasks WHERE id = 'resolve-offer'")
      .get() as { owner_agent: string; lease_epoch: number };
    assert.deepStrictEqual({ ...task }, { owner_agent: 'Alice', lease_epoch: 1 });
    assert.strictEqual(
      (db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE kind IN ('handoff_declined', 'handoff_cancelled')")
        .get() as { n: number }).n,
      2
    );
    db.close();
  });
});

describe('coordination authority hardening', () => {
  test('ack --all is refused without clearing an injected gate', () => {
    const home = tempHome('swarm-ack-all-refusal-');
    join(home, 'Alice');
    join(home, 'Bob');
    const sent = runCli(home, ['send', 'Bob', 'STOP until reviewed', '--kind', 'gate'], 'Alice');
    assert.strictEqual(sent.status, 0, sent.stderr || sent.stdout);
    const hook = runCli(home, ['hook-context'], 'Bob');
    assert.match(hook.stdout, /STOP until reviewed/);

    const refused = runCli(home, ['ack', '--all'], 'Bob');
    assert.notStrictEqual(refused.status, 0);
    assert.match(refused.stderr, /Refused unsafe "swarm ack --all".*unseen STOP, gate, question, or handoff/s);

    const db = openDb(home);
    const delivery = db.prepare('SELECT status FROM message_deliveries').get() as { status: string };
    assert.strictEqual(delivery.status, 'injected');
    db.close();
  });

  test('task decisions require the current fenced owner and record authenticated agent-id + epoch provenance', () => {
    const home = tempHome('swarm-decision-provenance-');
    join(home, 'Alice');
    join(home, 'Bob');
    createCheckpointedTask(home, 'decision-provenance');

    const recorded = runCli(home, [
      'decision', 'DECISION: retain the source lease BECAUSE acceptance is explicit',
      '--task', 'decision-provenance',
    ], 'Alice');
    assert.strictEqual(recorded.status, 0, recorded.stderr || recorded.stdout);
    const decisionId = Number(recorded.stdout.match(/Decision #(\d+)/)?.[1]);

    const unauthorized = runCli(home, [
      'decision', 'DECISION: spoofed', '--task', 'decision-provenance',
    ], 'Bob');
    assert.notStrictEqual(unauthorized.status, 0);
    assert.match(unauthorized.stderr, /Refused stale task authority.*owner is "Alice"/s);

    const db = openDb(home);
    const alice = db.prepare("SELECT id FROM agents WHERE name = 'Alice'").get() as { id: string };
    const decision = db.prepare(
      'SELECT actor_agent_id, task_epoch, made_by FROM decisions WHERE id = ?'
    ).get(decisionId) as { actor_agent_id: string; task_epoch: number; made_by: string };
    assert.deepStrictEqual(
      { ...decision },
      { actor_agent_id: alice.id, task_epoch: 1, made_by: 'Alice' }
    );
    const provenanceEvent = db.prepare(
      "SELECT epoch, data FROM task_events WHERE task_id = 'decision-provenance' AND kind = 'decision_recorded'"
    ).get() as { epoch: number; data: string };
    assert.strictEqual(provenanceEvent.epoch, 1);
    assert.strictEqual(JSON.parse(provenanceEvent.data).decision_id, decisionId);
    db.close();

    const programDecision = runCli(home, ['decision', 'DECISION: program scope stays author-owned'], 'Alice');
    assert.strictEqual(programDecision.status, 0, programDecision.stderr || programDecision.stdout);
    const programId = Number(programDecision.stdout.match(/Decision #(\d+)/)?.[1]);
    const spoofSupersede = runCli(home, [
      'decision', 'DECISION: hostile replacement', '--supersedes', String(programId),
    ], 'Bob');
    assert.notStrictEqual(spoofSupersede.status, 0);
    assert.match(spoofSupersede.stderr, /not an active Owner\/Lead authority/);
  });
});
