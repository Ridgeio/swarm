import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
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

// Multi-recipient send, --kind tagging/filtering, and inbox cursor clarity, exercised
// through the real CLI against an isolated HOME. All agents are headless (no push
// surface in this environment), so sends resolve to "Message sent to <name>" and land
// in the DB inbox. Tests within this block share DB state and run in order.
describe('cli messaging (multi-send, kinds, cursor clarity)', () => {
  let home: string;

  // Every runCli child shares this terminal's TTY, so sequential headless joins look
  // like ONE interactive session renaming itself — the per-TTY session marker makes
  // the next join evict the previous agent. These tests simulate DISTINCT agents
  // (identified per-call via SWARM_AGENT_NAME), so drop the marker between joins.
  function dropSessionMarkers() {
    const swarmDir = join(home, '.swarm');
    if (!existsSync(swarmDir)) return;
    for (const f of readdirSync(swarmDir)) {
      if (f.startsWith('headless-')) rmSync(join(swarmDir, f), { force: true });
    }
  }

  function joinHeadless(name: string) {
    const j = runCli(home, ['join', name, '--headless'], { SWARM_AGENT_NAME: name });
    assert.strictEqual(j.status, 0, j.stderr || j.stdout);
    dropSessionMarkers();
  }

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'swarm-msg-'));
    for (const name of ['Alice', 'Bob', 'Carol']) joinHeadless(name);
  });
  after(() => { rmSync(home, { recursive: true, force: true }); });

  test('multi-recipient send delivers to each recipient and exits 0', () => {
    const r = runCli(home, ['send', 'Bob,Carol', 'contract frozen'], { SWARM_AGENT_NAME: 'Alice' });
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
    const lines = r.stdout.trim().split('\n');
    assert.deepStrictEqual(lines, ['Message sent to Bob', 'Message sent to Carol']);
  });

  test('multi-send trims whitespace and dedupes case-insensitively', () => {
    const r = runCli(home, ['send', 'Bob, bob , Carol,', 'dedupe test'], { SWARM_AGENT_NAME: 'Alice' });
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
    const lines = r.stdout.trim().split('\n');
    assert.deepStrictEqual(lines, ['Message sent to Bob', 'Message sent to Carol']);
  });

  test('multi-send with an unknown recipient still attempts the rest and exits nonzero', () => {
    const r = runCli(home, ['send', 'Ghost,Bob', 'partial failure'], { SWARM_AGENT_NAME: 'Alice' });
    assert.notStrictEqual(r.status, 0, 'any failed recipient must make the exit code nonzero');
    assert.match(r.stdout, /Agent "Ghost" not found/);
    assert.match(r.stdout, /Message sent to Bob/, 'remaining recipients must still be attempted');
  });

  test('single-name send output is unchanged', () => {
    const r = runCli(home, ['send', 'Bob', 'solo line'], { SWARM_AGENT_NAME: 'Alice' });
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
    assert.strictEqual(r.stdout, 'Message sent to Bob\n');
  });

  test('--kind is stored, filterable on read, and a filtered read does not advance the cursor', () => {
    const s = runCli(home, ['send', 'Carol', 'merge ready', '--kind', 'gate'], { SWARM_AGENT_NAME: 'Bob' });
    assert.strictEqual(s.status, 0, s.stderr || s.stdout);

    // Filtered read: shows only the gate message, flags that the cursor is untouched.
    const filtered = runCli(home, ['inbox', '--kind', 'gate'], { SWARM_AGENT_NAME: 'Carol' });
    assert.strictEqual(filtered.status, 0, filtered.stderr || filtered.stdout);
    assert.match(filtered.stdout, /\[gate\] Bob: merge ready/);
    assert.match(filtered.stdout, /cursor not advanced/);
    assert.doesNotMatch(filtered.stdout, /contract frozen/, 'other kinds must be filtered out');

    // Plain read afterwards: every message is still unread — the filtered read must
    // not have advanced the cursor past the messages it did not show.
    const plain = runCli(home, ['inbox'], { SWARM_AGENT_NAME: 'Carol' });
    assert.strictEqual(plain.status, 0, plain.stderr || plain.stdout);
    assert.match(plain.stdout, /contract frozen/);
    assert.match(plain.stdout, /dedupe test/);
    assert.match(plain.stdout, /\[gate\] Bob: merge ready/);
  });

  test('zero-unread inbox points at --recent when recent traffic exists', () => {
    // Carol consumed everything in the previous test; 3 messages exist in her last 24h.
    const r = runCli(home, ['inbox'], { SWARM_AGENT_NAME: 'Carol' });
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
    assert.match(
      r.stdout,
      /^No new messages \(read cursor is current\)\. 3 message\(s\) in the last 24h — replay with: swarm inbox --recent 3$/m
    );
  });

  test('zero-unread inbox with no traffic keeps the plain "No new messages." line', () => {
    joinHeadless('Dave');
    const r = runCli(home, ['inbox'], { SWARM_AGENT_NAME: 'Dave' });
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
    assert.strictEqual(r.stdout, 'No new messages.\n');
  });

  test('unknown --kind is rejected with a usage error on send and inbox', () => {
    const s = runCli(home, ['send', 'Bob', 'oops', '--kind', 'bogus'], { SWARM_AGENT_NAME: 'Alice' });
    assert.notStrictEqual(s.status, 0);
    assert.match(s.stderr, /Invalid --kind "bogus"/);
    assert.match(s.stderr, /Allowed: status, digest, merge-req, escalation, ack, gate/);
    assert.doesNotMatch(s.stdout, /Message sent/);

    const i = runCli(home, ['inbox', '--kind', 'nope'], { SWARM_AGENT_NAME: 'Alice' });
    assert.notStrictEqual(i.status, 0);
    assert.match(i.stderr, /Invalid --kind "nope"/);
  });

  test('broadcast --kind tags the broadcast; --recent honors the kind filter', () => {
    const b = runCli(home, ['broadcast', 'org update', '--kind', 'digest'], { SWARM_AGENT_NAME: 'Alice' });
    assert.strictEqual(b.status, 0, b.stderr || b.stdout);
    assert.match(b.stdout, /Broadcast to \d+ agent\(s\)/);

    const inbox = runCli(home, ['inbox', '--kind', 'digest'], { SWARM_AGENT_NAME: 'Bob' });
    assert.match(inbox.stdout, /\[digest\] Alice: org update/);

    const recent = runCli(home, ['inbox', '--recent', '10', '--kind', 'gate'], { SWARM_AGENT_NAME: 'Carol' });
    assert.match(recent.stdout, /\[gate\] Bob: merge ready/);
    assert.doesNotMatch(recent.stdout, /contract frozen/);
    assert.doesNotMatch(recent.stdout, /org update/);
  });
});
