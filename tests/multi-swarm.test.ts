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
  listSurfaceMemberships,
  readActiveSwarmId,
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
    joinHeadlessAgent(cliDb, def.id, 'Alice', undefined, { hostAgent: 'codex', versionRunner: () => 'v' });
    joinHeadlessAgent(cliDb, def.id, 'Bob', undefined, { hostAgent: 'codex', versionRunner: () => 'v' });
    cliDb.close();

    const index = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
    let status = 0;
    try {
      execFileSync('node', ['--import', import.meta.resolve('tsx'), index, 'send', 'Bob', '--swarm', 'docs'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          TMPDIR: path.join(home, 'tmp'),
          SWARM_AGENT_NAME: 'Alice',
          SWARM_TEST_DISABLE_BACKGROUND: '1',
        },
      });
    } catch (err: any) {
      status = typeof err.status === 'number' ? err.status : 1;
    }

    const after = getDbAt(path.join(home, '.swarm', 'swarm.db'));
    const delivered = after.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE to_agent = 'Bob'"
    ).get() as { n: number };
    after.close();
    fs.rmSync(home, { recursive: true, force: true });

    assert.notStrictEqual(status, 0, 'must fail loudly rather than deliver somewhere plausible');
    assert.strictEqual(delivered.n, 0, 'nothing may be inserted into the default swarm');
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

  test('headless targets are not tagged — a name is not a session identity', () => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const beta = getOrCreateSwarm(db, 'beta');
    const headless = joinHeadlessAgent(db, alpha.id, 'Worker');
    assert.strictEqual(swarmTagFor(db, headless, alpha.id), '');

    // Counting same-name headless rows was tried as a proxy for "this TTY is in several
    // swarms" and is wrong both ways: names are unique only within a swarm, so one TTY
    // under two names goes untagged while two unrelated TTYs sharing a name get tagged
    // for a membership neither holds. A confidently wrong swarm name is worse than none.
    joinHeadlessAgent(db, beta.id, 'Worker');
    assert.strictEqual(
      swarmTagFor(db, headless, alpha.id),
      '',
      'no tag until there is a durable per-session key to key it on'
    );
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

  test('joining a second swarm headless does not drop the first', () => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const beta = getOrCreateSwarm(db, 'beta');

    // Without a controlling TTY there is no marker, so the deletion this test exists to
    // catch cannot fire and the assertions below pass no matter what the source does.
    // FAIL loudly rather than report a green that proves nothing. (Caught in review: a
    // mutation test only demonstrates a guard works in the environment it was run in.)
    assert.ok(
      hasTty(),
      'no controlling TTY: the headless marker cannot resolve, so this test would pass vacuously'
    );

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
  test('deleting the active swarm falls back to a surviving headless membership', () => {
    const alpha = getOrCreateSwarm(db, 'alpha');
    const beta = getOrCreateSwarm(db, 'beta');
    assert.ok(hasTty(), 'no controlling TTY: headless markers cannot resolve');

    joinHeadlessAgent(db, beta.id, 'Quarry', undefined, { trackSession: true });
    joinHeadlessAgent(db, alpha.id, 'Quarry', undefined, { trackSession: true });
    assert.strictEqual(getSelf(db)?.swarm_id, alpha.id, 'alpha is active');

    // Exactly what reset/delete does: drop the rows, leave the markers.
    db.prepare('DELETE FROM agents WHERE swarm_id = ?').run(alpha.id);

    const resolved = getSelf(db);
    assert.ok(resolved, 'must not report "not joined" while beta is alive');
    assert.strictEqual(resolved!.swarm_id, beta.id, 'falls back to the surviving membership');
  });

  test('a same-swarm rename still reaps the old headless row', () => {
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
    assert.ok(hasTty(), 'no controlling TTY: nothing to reap from, so this would pass vacuously');
    assert.strictEqual(ghost, undefined, 'the pre-rename row in the SAME swarm is reaped');
  });
});
