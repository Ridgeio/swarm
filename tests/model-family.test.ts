import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDbAt } from '../src/db.js';
import {
  agentModelFamily,
  deriveModelFamily,
  MODEL_FAMILIES,
  parseModelFamily,
} from '../src/model-family.js';
import {
  getAgent,
  getOrCreateSwarm,
  joinA2AAgent,
  joinAgent,
  joinHeadlessAgent,
  setModelFamily,
  updateHostAgent,
} from '../src/registry.js';
import { requestTaskReview } from '../src/reviews.js';
import { startTask } from '../src/tasks.js';
import type { SwarmDb } from '../src/db.js';

const NOW = Date.parse('2026-07-21T18:42:00.000Z');

let db: SwarmDb;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `swarm-family-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = getDbAt(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

describe('model family is stated, never guessed', () => {
  test('an undeclared A2A agent is UNKNOWN, not "some other family"', () => {
    const swarm = getOrCreateSwarm(db, 'alpha');
    joinA2AAgent(db, swarm.id, 'Anvil', 'http://127.0.0.1:1/');
    const anvil = getAgent(db, swarm.id, 'Anvil')!;

    assert.strictEqual(agentModelFamily(anvil), 'unknown');
    // The distinction that matters: unknown !== claude is TRUE, which is exactly why
    // a raw inequality test would have accepted this agent as a cross-family reviewer.
    assert.notStrictEqual(agentModelFamily(anvil), 'claude');
  });

  test('a declared A2A family is honoured', () => {
    const swarm = getOrCreateSwarm(db, 'alpha');
    joinA2AAgent(db, swarm.id, 'Remote', 'http://127.0.0.1:1/', undefined, 'openai');
    assert.strictEqual(agentModelFamily(getAgent(db, swarm.id, 'Remote')!), 'openai');
  });

  test('a local agent records the family its harness implies at join', () => {
    const swarm = getOrCreateSwarm(db, 'alpha');
    joinAgent(db, swarm.id, 'Quarry', 'surface-1', 'ws', process.ppid, undefined, 'cmux', undefined, 'claude-code', () => 'v1');
    const row = getAgent(db, swarm.id, 'Quarry')!;
    assert.strictEqual(row.model_family, 'claude', 'family is persisted, not only derivable');
    assert.strictEqual(agentModelFamily(row), 'claude');
  });

  test('re-registering without --family keeps the previous declaration', () => {
    const swarm = getOrCreateSwarm(db, 'alpha');
    joinA2AAgent(db, swarm.id, 'Remote', 'http://127.0.0.1:1/', undefined, 'openai');
    // INSERT OR REPLACE rewrites the row; a silent demotion to UNKNOWN here would
    // quietly remove the agent from the cross-family reviewer pool.
    joinA2AAgent(db, swarm.id, 'Remote', 'http://127.0.0.1:1/', undefined, undefined);
    assert.strictEqual(agentModelFamily(getAgent(db, swarm.id, 'Remote')!), 'openai');

    joinA2AAgent(db, swarm.id, 'Remote', 'http://127.0.0.1:1/', undefined, 'xai');
    assert.strictEqual(agentModelFamily(getAgent(db, swarm.id, 'Remote')!), 'xai', 'a new declaration wins');
  });

  test('a KNOWN harness outranks a stale stored family', () => {
    const swarm = getOrCreateSwarm(db, 'alpha');
    joinAgent(db, swarm.id, 'Odd', 'surface-2', 'ws', process.ppid, undefined, 'cmux', undefined, 'claude-code', () => 'v1');
    // Simulate the stored column going stale: host_agent is re-detected on every
    // command, model_family is not. If the column won, a claude seat carrying a stale
    // 'openai' would be routed as the cross-family reviewer for a claude author.
    setModelFamily(db, swarm.id, 'Odd', 'openai');
    assert.strictEqual(
      agentModelFamily(getAgent(db, swarm.id, 'Odd')!),
      'claude',
      'the live harness is authoritative over the cached column'
    );
  });

  /**
   * Found by Ledger (codex) in cross-family review. An A2A row describes a REMOTE agent,
   * so host_agent is not an observation of it — any local process running as that
   * identity (SWARM_AGENT_NAME) stamps its own harness there. Letting that outrank the
   * declaration produced a WRONG family, which approves, rather than unknown, which
   * refuses: a declared-claude seat read as openai and would be accepted as an inverted
   * reviewer for a Claude author.
   */
  test('an A2A declaration is NOT overridden by a host_agent written by some local caller', () => {
    const swarm = getOrCreateSwarm(db, 'alpha');
    joinA2AAgent(db, swarm.id, 'Remote', 'http://127.0.0.1:1/', undefined, 'claude');
    const before = getAgent(db, swarm.id, 'Remote')!;
    assert.strictEqual(agentModelFamily(before), 'claude');

    updateHostAgent(db, swarm.id, before.surface_id, 'codex');
    const after = getAgent(db, swarm.id, 'Remote')!;
    assert.strictEqual(after.host_agent, 'codex', 'precondition: the column really was written');
    assert.strictEqual(
      agentModelFamily(after),
      'claude',
      'only the declaration speaks for a remote agent'
    );
  });

  test('an UNDECLARED A2A agent stays unknown even when a caller stamps a harness', () => {
    const swarm = getOrCreateSwarm(db, 'alpha');
    joinA2AAgent(db, swarm.id, 'Bare', 'http://127.0.0.1:2/');
    const bare = getAgent(db, swarm.id, 'Bare')!;
    updateHostAgent(db, swarm.id, bare.surface_id, 'codex');
    assert.strictEqual(
      agentModelFamily(getAgent(db, swarm.id, 'Bare')!),
      'unknown',
      'a borrowed harness must never manufacture a family — unknown refuses, wrong approves'
    );
  });

  test('the stored family is used only when no harness is detectable', () => {
    const swarm = getOrCreateSwarm(db, 'alpha');
    joinAgent(db, swarm.id, 'Ghost', 'surface-3', 'ws', process.ppid, undefined, 'cmux', undefined, null, () => 'v1');
    assert.strictEqual(agentModelFamily(getAgent(db, swarm.id, 'Ghost')!), 'unknown');
    setModelFamily(db, swarm.id, 'Ghost', 'xai');
    assert.strictEqual(agentModelFamily(getAgent(db, swarm.id, 'Ghost')!), 'xai');
  });

  test('joinAgent returns the family it actually persisted', () => {
    const swarm = getOrCreateSwarm(db, 'alpha');
    joinAgent(db, swarm.id, 'Ember', 'surface-4', 'ws', process.ppid, undefined, 'cmux', undefined, 'codex', () => 'v1');
    const rejoined = joinAgent(db, swarm.id, 'Ember', 'surface-4', 'ws', process.ppid, undefined, 'cmux', undefined, null, () => 'v1');
    assert.strictEqual(
      rejoined.model_family,
      getAgent(db, swarm.id, 'Ember')!.model_family,
      'the returned object must agree with its own row'
    );
  });

  test('parseModelFamily accepts only declarable families, never "unknown"', () => {
    for (const family of MODEL_FAMILIES) {
      assert.strictEqual(parseModelFamily(family), family);
    }
    assert.strictEqual(parseModelFamily('CLAUDE'), 'claude', 'case-insensitive');
    assert.strictEqual(parseModelFamily('unknown'), null, '"unknown" is not declarable');
    assert.strictEqual(parseModelFamily('gpt'), null);
    assert.strictEqual(parseModelFamily(''), null);
    assert.strictEqual(parseModelFamily(undefined), null);
  });

  test('harness mapping is unchanged for known hosts', () => {
    assert.strictEqual(deriveModelFamily('claude-code'), 'claude');
    assert.strictEqual(deriveModelFamily('codex'), 'openai');
    assert.strictEqual(deriveModelFamily('grok'), 'xai');
    assert.strictEqual(deriveModelFamily('gemini'), 'google');
    assert.strictEqual(deriveModelFamily(null), 'unknown');
  });
});

/**
 * The control this protects: cross-family review. Before this, an agent of UNKNOWN
 * family satisfied it, because `unknown !== claude` is true — true for the wrong
 * reason. A review recorded as cross-family when it was not is worse than no review,
 * because it stops anyone looking for a real one.
 */
describe('an unknown-family agent cannot satisfy cross-family review', () => {
  let root: string;
  let home: string;
  let fdb: SwarmDb;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-family-review-'));
    home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.swarm'), { recursive: true });
    fdb = getDbAt(path.join(home, '.swarm', 'swarm.db'));
  });

  afterEach(() => {
    fdb.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  const joinLocal = (name: string, host: 'claude-code' | 'codex' | null) =>
    joinHeadlessAgent(fdb, 'default', name, undefined, {
      hostAgent: host,
      versionRunner: () => 'fixture version\n',
    });

  test('routing refuses an explicitly chosen UNKNOWN-family reviewer', async () => {
    joinLocal('Author', 'claude-code');
    joinA2AAgent(fdb, 'default', 'Anvil', 'http://127.0.0.1:1/');
    await startTask(fdb, 'default', 'Author', 'unknown-reviewer', {
      title: 'Unknown reviewer', noWorktree: true, claimKind: 'analysis',
    });

    await assert.rejects(
      requestTaskReview(fdb, 'default', 'Author', 'unknown-reviewer', {
        to: 'Anvil', now: new Date(NOW), homeDir: home,
      }),
      /model family is UNKNOWN/
    );
    assert.strictEqual(
      (fdb.prepare("SELECT state FROM tasks WHERE id = 'unknown-reviewer'").get() as any).state,
      'active',
      'the task must NOT advance to awaiting_review on a refused route'
    );
  });

  test('auto-routing never picks an UNKNOWN-family agent, and says why', async () => {
    joinLocal('Author', 'claude-code');
    joinA2AAgent(fdb, 'default', 'Anvil', 'http://127.0.0.1:1/');
    await startTask(fdb, 'default', 'Author', 'auto-route', {
      title: 'Auto route', noWorktree: true, claimKind: 'analysis',
    });

    await assert.rejects(
      requestTaskReview(fdb, 'default', 'Author', 'auto-route', {
        now: new Date(NOW), homeDir: home,
      }),
      /No live cross-family reviewer[\s\S]*UNKNOWN family and do not count[\s\S]*Anvil/
    );
  });

  test('declaring the family makes the same agent eligible', async () => {
    joinLocal('Author', 'claude-code');
    joinA2AAgent(fdb, 'default', 'Anvil', 'http://127.0.0.1:1/', undefined, 'openai');
    await startTask(fdb, 'default', 'Author', 'declared', {
      title: 'Declared', noWorktree: true, claimKind: 'analysis',
    });

    const result = await requestTaskReview(fdb, 'default', 'Author', 'declared', {
      now: new Date(NOW), homeDir: home,
    });
    assert.strictEqual(result.reviewer, 'Anvil');
    assert.strictEqual(result.reviewerFamily, 'openai');
    assert.strictEqual(result.authorFamily, 'claude');
  });

  const overrideEvents = (slug: string) =>
    fdb.prepare(
      "SELECT data FROM task_events WHERE task_id = ? AND kind = 'same_family_review'"
    ).all(slug) as Array<{ data: string }>;

  test('overriding the UNKNOWN-REVIEWER gate is audited and records the reason', async () => {
    joinLocal('Author', 'claude-code');
    joinA2AAgent(fdb, 'default', 'Anvil', 'http://127.0.0.1:1/');
    await startTask(fdb, 'default', 'Author', 'audit-unknown-reviewer', {
      title: 'Audit', noWorktree: true, claimKind: 'analysis',
    });

    await requestTaskReview(fdb, 'default', 'Author', 'audit-unknown-reviewer', {
      to: 'Anvil', sameFamilyOk: true, reason: 'no other seat live',
      now: new Date(NOW), homeDir: home,
    });

    // Before this was fixed the audit fired only when the families were EQUAL, so this
    // bypass wrote no exception row at all and the ledger was byte-identical to a
    // legitimate cross-family review.
    const events = overrideEvents('audit-unknown-reviewer');
    assert.strictEqual(events.length, 1, 'the override must be recorded');
    const data = JSON.parse(events[0].data);
    assert.strictEqual(data.gate, 'unknown-reviewer');
    assert.strictEqual(data.reason, 'no other seat live', 'the mandatory reason must be persisted');
    assert.strictEqual(data.reviewer_family, 'unknown');
  });

  test('overriding the UNKNOWN-AUTHOR gate is audited too', async () => {
    joinLocal('Ghost', null);
    joinLocal('Reviewer', 'codex');
    await startTask(fdb, 'default', 'Ghost', 'audit-unknown-author', {
      title: 'Audit', noWorktree: true, claimKind: 'analysis',
    });

    await requestTaskReview(fdb, 'default', 'Ghost', 'audit-unknown-author', {
      to: 'Reviewer', sameFamilyOk: true, reason: 'author harness undetected',
      now: new Date(NOW), homeDir: home,
    });

    const events = overrideEvents('audit-unknown-author');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(JSON.parse(events[0].data).gate, 'unknown-author');
  });

  test('a clean cross-family review records NO override event', async () => {
    joinLocal('Author', 'claude-code');
    joinLocal('Cx', 'codex');
    await startTask(fdb, 'default', 'Author', 'clean-route', {
      title: 'Clean', noWorktree: true, claimKind: 'analysis',
    });

    await requestTaskReview(fdb, 'default', 'Author', 'clean-route', {
      now: new Date(NOW), homeDir: home,
    });
    assert.strictEqual(overrideEvents('clean-route').length, 0);
  });

  test('an UNKNOWN-family AUTHOR cannot establish inversion either', async () => {
    joinLocal('Ghost', null);
    joinLocal('Reviewer', 'codex');
    await startTask(fdb, 'default', 'Ghost', 'unknown-author', {
      title: 'Unknown author', noWorktree: true, claimKind: 'analysis',
    });

    await assert.rejects(
      requestTaskReview(fdb, 'default', 'Ghost', 'unknown-author', {
        to: 'Reviewer', now: new Date(NOW), homeDir: home,
      }),
      /author's model family is UNKNOWN/
    );
  });
});
