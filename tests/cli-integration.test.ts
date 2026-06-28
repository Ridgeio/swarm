import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import SQLite from 'better-sqlite3';

// Exercise the real CLI handlers (join reclaim, rename-workspace id resolution) as a
// subprocess against an isolated HOME (so ~/.swarm is a throwaway temp DB, never the
// live swarm). cmux-dependent side effects are best-effort and not asserted on.
const INDEX = resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));

interface CliResult { stdout: string; stderr: string; status: number; }

function runCli(home: string, args: string[], env: Record<string, string> = {}): CliResult {
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    // Start each call from a clean identity so nothing leaks in from the test runner.
    SWARM_ID: '', SWARM_NAME: '', SWARM_AGENT_NAME: '',
    CMUX_SURFACE_ID: '', CMUX_WORKSPACE_ID: '', TERM_PROGRAM: '',
    ...env,
  };
  try {
    const stdout = execFileSync('node', ['--import', 'tsx', INDEX, ...args], {
      encoding: 'utf-8', env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      status: typeof err.status === 'number' ? err.status : 1,
    };
  }
}

describe('cli integration', () => {
  let home: string;
  before(() => { home = mkdtempSync(join(tmpdir(), 'swarm-cli-')); });
  after(() => { rmSync(home, { recursive: true, force: true }); });

  test('a fresh (likely-live) headless holder blocks a no-force re-join', () => {
    const j1 = runCli(home, ['join', 'Baz', '--headless'], { SWARM_AGENT_NAME: 'Baz' });
    assert.strictEqual(j1.status, 0, j1.stderr || j1.stdout);

    // Heartbeat is fresh (just joined), so a same-name join from another session must be
    // refused — it could be a still-live agent. The error must point at --force.
    const j2 = runCli(home, ['join', 'Baz'], { CMUX_SURFACE_ID: 'surf-baz', CMUX_WORKSPACE_ID: 'ws-baz' });
    assert.notStrictEqual(j2.status, 0, 'fresh headless holder should block a no-force re-join');
    assert.match(j2.stdout + j2.stderr, /--force/);
  });

  test('--force reclaims a headless-held name (resume into Cmux)', () => {
    const j1 = runCli(home, ['join', 'Foo', '--headless'], { SWARM_AGENT_NAME: 'Foo' });
    assert.strictEqual(j1.status, 0, j1.stderr || j1.stdout);
    assert.match(j1.stdout, /Joined swarm .* as "Foo"/);

    const j2 = runCli(home, ['join', 'Foo', '--force'], { CMUX_SURFACE_ID: 'surf-1', CMUX_WORKSPACE_ID: 'ws-1' });
    assert.strictEqual(j2.status, 0, `--force reclaim should succeed: ${j2.stderr || j2.stdout}`);
    assert.match(j2.stdout, /Reclaimed headless registration "Foo"/);
    assert.doesNotMatch(j2.stdout + j2.stderr, /already taken/);

    const who = runCli(home, ['whoami'], { CMUX_SURFACE_ID: 'surf-1' });
    assert.strictEqual(who.status, 0, who.stderr || who.stdout);
    assert.match(who.stdout, /Type: cmux/);
  });

  test('a headless holder is never auto-evicted — reclaim is --force only, even when stale', () => {
    const j1 = runCli(home, ['join', 'Qux', '--headless'], { SWARM_AGENT_NAME: 'Qux' });
    assert.strictEqual(j1.status, 0, j1.stderr || j1.stdout);

    // Age its heartbeat far past any threshold. A headless agent has no probeable surface,
    // so even a long-stale one is NOT auto-evicted (it could be busy on a long task) — only
    // an explicit --force reclaims it.
    const sqlite = new SQLite(join(home, '.swarm', 'swarm.db'));
    sqlite.prepare("UPDATE agents SET last_heartbeat = ? WHERE name = 'Qux'")
      .run(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    sqlite.close();

    const blocked = runCli(home, ['join', 'Qux'], { CMUX_SURFACE_ID: 'surf-qux', CMUX_WORKSPACE_ID: 'ws-qux' });
    assert.notStrictEqual(blocked.status, 0, 'a stale headless holder must still require --force');
    assert.match(blocked.stdout + blocked.stderr, /--force/);

    const forced = runCli(home, ['join', 'Qux', '--force'], { CMUX_SURFACE_ID: 'surf-qux', CMUX_WORKSPACE_ID: 'ws-qux' });
    assert.strictEqual(forced.status, 0, forced.stderr || forced.stdout);
    assert.match(forced.stdout, /Reclaimed headless registration "Qux"/);
  });

  test('--headless join inside a Cmux env still resolves its own identity', () => {
    // Force headless even though a Cmux surface is present; getSelf must fall through from
    // the surface lookup (which finds no Cmux row) to the headless resolution path.
    const j = runCli(home, ['join', 'Hax', '--headless'], { CMUX_SURFACE_ID: 'surf-hidden', SWARM_AGENT_NAME: 'Hax' });
    assert.strictEqual(j.status, 0, j.stderr || j.stdout);

    const who = runCli(home, ['whoami'], { CMUX_SURFACE_ID: 'surf-hidden', SWARM_AGENT_NAME: 'Hax' });
    assert.strictEqual(who.status, 0, who.stderr || who.stdout);
    assert.match(who.stdout, /Type: headless/);
  });

  test('rename-workspace resolves a Surface id to the agent\'s Workspace id', () => {
    const j = runCli(home, ['join', 'Bar'], { CMUX_SURFACE_ID: 'surf-bar', CMUX_WORKSPACE_ID: 'ws-bar' });
    assert.strictEqual(j.status, 0, j.stderr || j.stdout);

    // Pass the SURFACE id by mistake (whoami prints both). The CLI should detect it and
    // substitute the agent's Workspace id, printing a note — regardless of whether the
    // underlying cmux rename then succeeds or fails in this environment.
    const r = runCli(home, ['rename-workspace', 'surf-bar', 'Bar'], { CMUX_SURFACE_ID: 'surf-bar' });
    assert.match(r.stdout + r.stderr, /is Bar's Surface id; using their Workspace id ws-bar/);
  });
});
