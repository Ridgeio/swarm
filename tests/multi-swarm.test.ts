import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { getDbAt } from '../src/db.js';
import {
  clearActiveSwarmId,
  getAuthenticatedSelf,
  getOrCreateSwarm,
  getSelf,
  joinAgent,
  joinHeadlessAgent,
  leaveAgent,
  leaveHeadlessAgent,
  listOwnedHeadlessMarkers,
  listSurfaceMemberships,
  readActiveSwarmId,
  setActiveHeadlessSwarm,
  touchSurfaceMemberships,
  writeActiveSwarmId,
} from '../src/registry.js';
import { swarmTagFor } from '../src/mailbox.js';
import type { SwarmDb } from '../src/db.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_SURFACE = process.env.CMUX_SURFACE_ID;
const ORIGINAL_SWARM_ID = process.env.SWARM_ID;
const ORIGINAL_SWARM_NAME = process.env.SWARM_NAME;
const ORIGINAL_AGENT_NAME = process.env.SWARM_AGENT_NAME;

const SURFACE = 'surface-multi-1';

let db: SwarmDb;
let dbPath: string;
let home: string;

/** Mirrors what the CLI does on join: register, then stamp the active pointer. */
function joinSurface(swarmId: string, name: string, surfaceId: string = SURFACE) {
  const agent = joinAgent(db, swarmId, name, surfaceId, 'workspace-1', process.ppid);
  writeActiveSwarmId(surfaceId, swarmId);
  return agent;
}

function markerFiles(): string[] {
  const dir = path.join(home, '.swarm', 'sessions');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.startsWith('cmux-')) : [];
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-multi-home-'));
  process.env.HOME = home;
  process.env.CMUX_SURFACE_ID = SURFACE;
  delete process.env.SWARM_ID;
  delete process.env.SWARM_NAME;
  delete process.env.SWARM_AGENT_NAME;
  dbPath = path.join(os.tmpdir(), `swarm-multi-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = getDbAt(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_SURFACE === undefined) delete process.env.CMUX_SURFACE_ID;
  else process.env.CMUX_SURFACE_ID = ORIGINAL_SURFACE;
  if (ORIGINAL_SWARM_ID === undefined) delete process.env.SWARM_ID;
  else process.env.SWARM_ID = ORIGINAL_SWARM_ID;
  if (ORIGINAL_SWARM_NAME === undefined) delete process.env.SWARM_NAME;
  else process.env.SWARM_NAME = ORIGINAL_SWARM_NAME;
  if (ORIGINAL_AGENT_NAME === undefined) delete process.env.SWARM_AGENT_NAME;
  else process.env.SWARM_AGENT_NAME = ORIGINAL_AGENT_NAME;
});

describe('multi-swarm membership on one surface', () => {
  test('joining a second swarm does not deregister the surface from the first', () => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const beta = getOrCreateSwarm(db, 'beta');

    joinSurface(alpha.id, 'Quarry');
    joinSurface(beta.id, 'Quarry');

    const memberships = listSurfaceMemberships(db, SURFACE);
    assert.strictEqual(memberships.length, 2, 'surface should hold a membership in both swarms');
    assert.deepStrictEqual(
      memberships.map(m => m.swarm_id).sort(),
      [alpha.id, beta.id].sort()
    );
    // The regression this feature exists to kill: the first swarm's roster must
    // still list the agent after the second join.
    assert.ok(getSelf(db, alpha.id), 'still registered in alpha');
    assert.ok(getSelf(db, beta.id), 'still registered in beta');
  });

  test('each membership authenticates with its own token', () => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const beta = getOrCreateSwarm(db, 'beta');

    const inAlpha = joinSurface(alpha.id, 'Quarry');
    const inBeta = joinSurface(beta.id, 'Quarry');

    assert.notStrictEqual(
      inAlpha.session_token,
      inBeta.session_token,
      'memberships must not share a token'
    );
    assert.strictEqual(markerFiles().length, 2, 'one session marker per (surface, swarm)');

    // Both must authenticate. Before markers were swarm-scoped, the second join
    // overwrote the first swarm's marker and this threw for alpha.
    assert.strictEqual(getAuthenticatedSelf(db, alpha.id)?.swarm_id, alpha.id);
    assert.strictEqual(getAuthenticatedSelf(db, beta.id)?.swarm_id, beta.id);
  });

  test('the active pointer decides which swarm an unqualified command resolves to', () => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const beta = getOrCreateSwarm(db, 'beta');

    joinSurface(alpha.id, 'Quarry');
    joinSurface(beta.id, 'Quarry');
    assert.strictEqual(getSelf(db)?.swarm_id, beta.id, 'newest join becomes the default');

    writeActiveSwarmId(SURFACE, alpha.id);
    assert.strictEqual(getSelf(db)?.swarm_id, alpha.id, 'pointer overrides recency');
    assert.strictEqual(getAuthenticatedSelf(db)?.swarm_id, alpha.id, 'and still authenticates');

    // An explicit --swarm equivalent must beat the pointer.
    assert.strictEqual(getSelf(db, beta.id)?.swarm_id, beta.id);
  });

  test('a pointer naming a swarm this surface never joined is ignored, not obeyed', () => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const ghost = getOrCreateSwarm(db, 'ghost');

    joinSurface(alpha.id, 'Quarry');
    writeActiveSwarmId(SURFACE, ghost.id);

    // Resolution must fall back to a real membership rather than resolve to
    // nothing and report "not joined" while a valid membership exists.
    assert.strictEqual(getSelf(db)?.swarm_id, alpha.id);
  });

  test('leaving one swarm keeps the others and their tokens intact', () => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const beta = getOrCreateSwarm(db, 'beta');

    joinSurface(alpha.id, 'Quarry');
    joinSurface(beta.id, 'Quarry');

    leaveAgent(db, beta.id, SURFACE);
    clearActiveSwarmId(SURFACE, beta.id);

    const memberships = listSurfaceMemberships(db, SURFACE);
    assert.strictEqual(memberships.length, 1);
    assert.strictEqual(memberships[0].swarm_id, alpha.id);
    assert.strictEqual(getAuthenticatedSelf(db, alpha.id)?.swarm_id, alpha.id, 'alpha token survives');
    assert.strictEqual(readActiveSwarmId(SURFACE), null, 'pointer to the left swarm is cleared');
    assert.strictEqual(markerFiles().length, 1, 'only the left swarm\'s marker is removed');
  });

  test('leaving does not clear a pointer that names a different swarm', () => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const beta = getOrCreateSwarm(db, 'beta');

    joinSurface(alpha.id, 'Quarry');
    joinSurface(beta.id, 'Quarry');
    writeActiveSwarmId(SURFACE, beta.id);

    leaveAgent(db, alpha.id, SURFACE);
    clearActiveSwarmId(SURFACE, alpha.id);

    assert.strictEqual(readActiveSwarmId(SURFACE), beta.id, 'beta remains the default');
  });

  test('a pre-upgrade surface-keyed marker is adopted forward instead of logging the agent out', () => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const agent = joinAgent(db, alpha.id, 'Quarry', SURFACE, 'workspace-1', process.ppid);

    // Rebuild the legacy layout: one marker keyed by surface alone.
    const sessions = path.join(home, '.swarm', 'sessions');
    for (const file of markerFiles()) fs.rmSync(path.join(sessions, file), { force: true });
    const legacyKey = createHash('sha256').update(SURFACE).digest('hex');
    fs.writeFileSync(
      path.join(sessions, `cmux-${legacyKey}.json`),
      JSON.stringify({
        swarm_id: alpha.id,
        agent_name: 'Quarry',
        session_token: agent.session_token,
      })
    );

    assert.strictEqual(
      getAuthenticatedSelf(db, alpha.id)?.name,
      'Quarry',
      'legacy marker must still authenticate after upgrade'
    );
  });

  test('a heartbeat from one swarm keeps every membership on the surface alive', () => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const beta = getOrCreateSwarm(db, 'beta');

    joinSurface(alpha.id, 'Quarry');
    joinSurface(beta.id, 'Quarry');

    // Freeze both heartbeats far in the past, then act in beta only.
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE agents SET last_heartbeat = ? WHERE surface_id = ?').run(stale, SURFACE);
    touchSurfaceMemberships(db, SURFACE);

    // alpha is the swarm no command touched; its heartbeat must still have moved,
    // or cleanupStale's grace clause is disarmed for it and a false-negative
    // liveness probe deletes a live agent.
    const alphaRow = getSelf(db, alpha.id)!;
    assert.notStrictEqual(alphaRow.last_heartbeat, stale, 'non-default membership must be heartbeated');
  });

  test('two surfaces in the same swarm remain independent', () => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    joinSurface(alpha.id, 'Quarry', SURFACE);
    joinSurface(alpha.id, 'Caliper', 'surface-other');

    assert.strictEqual(listSurfaceMemberships(db, SURFACE).length, 1);
    assert.strictEqual(listSurfaceMemberships(db, 'surface-other').length, 1);
    assert.strictEqual(listSurfaceMemberships(db, SURFACE)[0].name, 'Quarry');
  });
});

describe('a trailing --swarm selector is refused, not delivered elsewhere', () => {
  /**
   * The minimal misuse is `swarm send Bob --swarm docs`, where the ENTIRE message body
   * is the selector. A guard requiring leading whitespace missed exactly that case and
   * reported success while inserting into the default swarm — the silent misroute it
   * exists to prevent. Driven through the real CLI because the guard lives there.
   */
  test('a message consisting only of the selector exits non-zero and delivers nothing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-selector-'));
    fs.mkdirSync(path.join(home, '.swarm'), { recursive: true });
    const cliDb = getDbAt(path.join(home, '.swarm', 'swarm.db'));
    const def = getOrCreateSwarm(cliDb, 'default');
    getOrCreateSwarm(cliDb, 'docs');
    const alice = joinHeadlessAgent(cliDb, def.id, 'Alice', undefined, { hostAgent: 'codex', versionRunner: () => 'v' });
    joinHeadlessAgent(cliDb, def.id, 'Bob', undefined, { hostAgent: 'codex', versionRunner: () => 'v' });
    cliDb.close();

    const index = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
    const run = (selector: string[]) => {
      try {
        execFileSync('node', ['--import', import.meta.resolve('tsx'), index, 'send', 'Bob', ...selector], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            TMPDIR: path.join(home, 'tmp'),
            SWARM_AGENT_NAME: 'Alice',
            // Without the token `send` (requireSelf(true)) fails on authentication BEFORE
            // reaching the guard — so the test passed even with the guard deleted. Caught
            // in review: asserting only "nonzero exit + no rows" cannot tell a refusal
            // from any other early exit.
            SWARM_SESSION_TOKEN: alice.session_token ?? '',
            SWARM_TEST_DISABLE_BACKGROUND: '1',
          },
        });
        return { status: 0, stderr: '' };
      } catch (err: any) {
        return {
          status: typeof err.status === 'number' ? err.status : 1,
          stderr: err.stderr?.toString() ?? '',
        };
      }
    };

    // Mid-message forms too: end-anchoring caught `send Bob --swarm docs` but missed
    // `send Bob --swarm docs hello`, which is the more natural way to make the mistake.
    for (const selector of [
      ['--swarm', 'docs'],
      ['--swarm=docs'],
      ['-s', 'docs'],
      ['--swarm', 'nosuchswarm'],
      ['--swarm', 'docs', 'hello'],
      ['-s', 'docs', 'hello', 'there'],
    ]) {
      const result = run(selector);
      assert.notStrictEqual(result.status, 0, `${selector.join(' ')}: must exit non-zero`);
      assert.match(
        result.stderr,
        /^Refusing:[\s\S]*swarm selector/m,
        `${selector.join(' ')}: must fail with the SELECTOR refusal, not some other error`
      );
    }

    const after = getDbAt(path.join(home, '.swarm', 'swarm.db'));
    const delivered = after.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE to_agent = 'Bob'"
    ).get() as { n: number };
    after.close();
    fs.rmSync(home, { recursive: true, force: true });
    assert.strictEqual(delivered.n, 0, 'nothing may be inserted into the default swarm');
  });

  /**
   * The broadcast defect was the ABSENCE of the validator call, so sharing a helper with
   * `send` proves the parsing logic but not that both call sites stay wired: deleting the
   * broadcast call left every send-only test green.
   */
  test('broadcast refuses a misplaced selector too, and delivers nothing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bcast-'));
    fs.mkdirSync(path.join(home, '.swarm'), { recursive: true });
    const cliDb = getDbAt(path.join(home, '.swarm', 'swarm.db'));
    const def = getOrCreateSwarm(cliDb, 'default');
    getOrCreateSwarm(cliDb, 'docs');
    const alice = joinHeadlessAgent(cliDb, def.id, 'Alice', undefined, { hostAgent: 'codex', versionRunner: () => 'v' });
    joinHeadlessAgent(cliDb, def.id, 'Bob', undefined, { hostAgent: 'codex', versionRunner: () => 'v' });
    cliDb.close();

    const index = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
    let status = 0;
    let stderr = '';
    try {
      execFileSync('node', ['--import', import.meta.resolve('tsx'), index, 'broadcast', 'hello', '--swarm', 'docs'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          TMPDIR: path.join(home, 'tmp'),
          SWARM_AGENT_NAME: 'Alice',
          SWARM_SESSION_TOKEN: alice.session_token ?? '',
          SWARM_TEST_DISABLE_BACKGROUND: '1',
        },
      });
    } catch (err: any) {
      status = typeof err.status === 'number' ? err.status : 1;
      stderr = err.stderr?.toString() ?? '';
    }

    const after = getDbAt(path.join(home, '.swarm', 'swarm.db'));
    const rows = after.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    after.close();
    fs.rmSync(home, { recursive: true, force: true });

    assert.notStrictEqual(status, 0, 'broadcast must exit non-zero');
    assert.match(stderr, /^Refusing:[\s\S]*swarm selector/m);
    assert.strictEqual(rows.n, 0, 'no broadcast row may be written');
  });
});

describe('pushed-message swarm attribution', () => {
  test('single-swarm recipients keep the original envelope, multi-swarm ones name the swarm', () => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const beta = getOrCreateSwarm(db, 'beta');

    const solo = joinAgent(db, alpha.id, 'Solo', 'surface-solo', 'ws', process.ppid);
    assert.strictEqual(
      swarmTagFor(db, solo, alpha.id),
      '',
      'a terminal in one swarm must keep the exact pre-existing format'
    );

    joinSurface(alpha.id, 'Quarry');
    const dual = joinSurface(beta.id, 'Quarry');
    assert.strictEqual(swarmTagFor(db, dual, beta.id), ' in beta');
    assert.strictEqual(swarmTagFor(db, dual, alpha.id), ' in alpha');
  });

  test('headless targets are ALWAYS tagged — the value cannot name the wrong swarm', () => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const headless = joinHeadlessAgent(db, alpha.id, 'Worker');

    // There is no reliable way to know whether a headless recipient holds several
    // memberships, but that uncertainty is about WHETHER a tag is needed, never about
    // WHAT it says: the value comes from the message's own swarm. A redundant-but-accurate
    // tag is cheap; an untagged cross-swarm message can be answered into the wrong swarm.
    assert.strictEqual(swarmTagFor(db, headless, alpha.id), ' in alpha');
  });
});

/**
 * Headless sessions (plain terminals, spawned workers, OpenClaw/Hermes) have no Cmux
 * surface and take a different code path. The cross-swarm drop lived there too.
 */
describe('multi-swarm membership for headless sessions', () => {
  // Headless identity comes from the per-TTY marker, which only resolves when the
  // process has a controlling TTY. Skip rather than assert a vacuous pass.
  const hasTty = (() => {
    const alpha = getOrCreateSwarm(db, 'probe');
    joinHeadlessAgent(db, alpha.id, 'Probe', undefined, { trackSession: true });
    const resolved = getSelf(db, alpha.id);
    leaveHeadlessAgent(db, alpha.id, 'Probe', { trackSession: true });
    return Boolean(resolved);
  })

  test('joining a second swarm headless does not drop the first', (t) => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const beta = getOrCreateSwarm(db, 'beta');

    // Without a controlling TTY there is no marker, so the deletion this test exists to
    // catch cannot fire and the assertions below pass no matter what the source does.
    // FAIL loudly rather than report a green that proves nothing. (Caught in review: a
    // mutation test only demonstrates a guard works in the environment it was run in.)
    // No controlling TTY => no marker => the deletion this covers cannot fire, and the
    // assertions below would pass regardless of the source. SKIP loudly: a vacuous green
    // hides a broken guard, but failing on absent platform plumbing turns normal non-PTY
    // CI red for a reason that is not about the product.
    if (!hasTty()) return t.skip('no controlling TTY: headless session markers cannot resolve');

    joinHeadlessAgent(db, alpha.id, 'Quarry', undefined, { trackSession: true });
    joinHeadlessAgent(db, beta.id, 'Quarry', undefined, { trackSession: true });

    const inAlpha = db.prepare(
      "SELECT * FROM agents WHERE swarm_id = ? AND name = 'Quarry' AND agent_type = 'headless'"
    ).get(alpha.id);
    const inBeta = db.prepare(
      "SELECT * FROM agents WHERE swarm_id = ? AND name = 'Quarry' AND agent_type = 'headless'"
    ).get(beta.id);

    assert.ok(inBeta, 'beta membership exists');
    assert.ok(inAlpha, 'alpha membership must SURVIVE the second headless join');
  });

  /**
   * `swarm reset`/`delete` removes agent rows without touching session markers, so the
   * unscoped active marker can name a swarm that no longer exists. Reporting "not
   * joined" then stranded every surviving membership unless the operator guessed the
   * right swarm name. Cmux already ignored a pointer with no live membership.
   */
  test('deleting the active swarm falls back to a surviving headless membership', (t) => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const beta = getOrCreateSwarm(db, 'beta');
    if (!hasTty()) return t.skip('no controlling TTY: headless session markers cannot resolve');

    joinHeadlessAgent(db, beta.id, 'Quarry', undefined, { trackSession: true });
    joinHeadlessAgent(db, alpha.id, 'Quarry', undefined, { trackSession: true });
    assert.strictEqual(getSelf(db)?.swarm_id, alpha.id, 'alpha is active');

    // Exactly what reset/delete does: drop the rows, leave the markers.
    db.prepare('DELETE FROM agents WHERE swarm_id = ?').run(alpha.id);

    const resolved = getSelf(db);
    assert.ok(resolved, 'must not report "not joined" while beta is alive');
    assert.strictEqual(resolved!.swarm_id, beta.id, 'falls back to the surviving membership');
  });

  /**
   * A marker names a swarm and an agent, and both survive that agent being replaced:
   * another terminal can force-reclaim the name with a fresh token. Validating only that
   * the ROW EXISTS is exactly what reclamation defeats — the stale session then reports
   * the reclaimed seat as its own membership, can make it the default, and reads that
   * agent's inbox. Only a token match distinguishes "mine" from "someone else's, same name".
   */
  test('a reclaimed seat is not reported as this session membership', (t) => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const beta = getOrCreateSwarm(db, 'beta');
    if (!hasTty()) return t.skip('no controlling TTY: headless session markers cannot be written');

    joinHeadlessAgent(db, alpha.id, 'OldSeat', undefined, { trackSession: true });
    joinHeadlessAgent(db, beta.id, 'Mine', undefined, { trackSession: true });
    assert.strictEqual(listOwnedHeadlessMarkers(db).length, 2, 'precondition: both owned');

    // Another terminal force-reclaims alpha/OldSeat, minting a new token. This session's
    // alpha marker keeps the OLD one, so the row still exists under the same name.
    db.prepare("UPDATE agents SET session_token = 'reclaimed-token' WHERE swarm_id = ? AND name = 'OldSeat'")
      .run(alpha.id);

    const owned = listOwnedHeadlessMarkers(db);
    assert.strictEqual(owned.length, 1, 'the reclaimed seat is no longer ours');
    assert.strictEqual(owned[0].swarm_id, beta.id);

    // ...and it cannot be adopted as the default, which is how the stale session would
    // have gone on to read the reclaimed agent's inbox.
    assert.strictEqual(setActiveHeadlessSwarm(db, alpha.id), false, 'use must refuse a seat we do not own');
    assert.strictEqual(setActiveHeadlessSwarm(db, beta.id), true, 'our own membership still works');
  });

  test('a same-swarm rename still reaps the old headless row', (t) => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    joinHeadlessAgent(db, alpha.id, 'OldName', undefined, { trackSession: true });
    joinHeadlessAgent(db, alpha.id, 'NewName', undefined, { trackSession: true });

    const ghost = db.prepare(
      "SELECT * FROM agents WHERE swarm_id = ? AND name = 'OldName' AND agent_type = 'headless'"
    ).get(alpha.id);
    const current = db.prepare(
      "SELECT * FROM agents WHERE swarm_id = ? AND name = 'NewName' AND agent_type = 'headless'"
    ).get(alpha.id);

    assert.ok(current, 'renamed agent is registered');
    if (!hasTty()) return t.skip('no controlling TTY: nothing to reap from');
    assert.strictEqual(ghost, undefined, 'the pre-rename row in the SAME swarm is reaped');
  });
});
