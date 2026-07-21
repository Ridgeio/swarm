import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import type { SwarmDb } from '../src/db.js';

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
    SWARM_ID: '', SWARM_NAME: '', SWARM_AGENT_NAME: '', SWARM_SESSION_TOKEN: '',
    CMUX_SURFACE_ID: '', CMUX_WORKSPACE_ID: '', TERM_PROGRAM: '',
    ...env,
  };
  if (childEnv.SWARM_AGENT_NAME && !Object.prototype.hasOwnProperty.call(env, 'SWARM_SESSION_TOKEN')) {
    const dbPath = join(home, '.swarm', 'swarm.db');
    if (existsSync(dbPath)) {
      const identityDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = identityDb.prepare('SELECT session_token FROM agents WHERE name = ? COLLATE NOCASE')
          .get(childEnv.SWARM_AGENT_NAME) as { session_token: string | null } | undefined;
        childEnv.SWARM_SESSION_TOKEN = row?.session_token ?? '';
      } finally {
        identityDb.close();
      }
    }
  }
  const result = spawnSync('node', ['--import', 'tsx', INDEX, ...args], {
    encoding: 'utf-8', env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

function fakeTtyPath(root: string, tty: string = 'ttys999'): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const ps = join(bin, 'ps');
  writeFileSync(ps, `#!/bin/sh\nprintf '%s\\n' '${tty}'\n`, { mode: 0o755 });
  chmodSync(ps, 0o755);
  return `${bin}:${process.env.PATH ?? ''}`;
}

function fakeUnavailableCmuxPath(root: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const cmux = join(bin, 'cmux');
  writeFileSync(cmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$SWARM_TEST_CMUX_LOG"\nexit 1\n`, { mode: 0o755 });
  chmodSync(cmux, 0o755);
  return `${bin}:${process.env.PATH ?? ''}`;
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
    const sqlite = new DatabaseSync(join(home, '.swarm', 'swarm.db'));
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

  test('registered surface identity wins a conflicting headless marker and join warns', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'swarm-identity-precedence-'));
    const fixtureHome = join(fixture, 'home');
    const fixturePath = fakeTtyPath(fixture);
    try {
      const surfaceJoin = runCli(fixtureHome, ['join', 'SurfaceY'], {
        PATH: fixturePath,
        CMUX_SURFACE_ID: 'surface-y',
        CMUX_WORKSPACE_ID: 'workspace-y',
      });
      assert.strictEqual(surfaceJoin.status, 0, surfaceJoin.stderr || surfaceJoin.stdout);

      const childJoin = runCli(fixtureHome, ['join', 'MarkerX', '--headless'], {
        PATH: fixturePath,
        CMUX_SURFACE_ID: 'surface-y',
      });
      assert.strictEqual(childJoin.status, 0, childJoin.stderr || childJoin.stdout);

      const who = runCli(fixtureHome, ['whoami'], {
        PATH: fixturePath,
        CMUX_SURFACE_ID: 'surface-y',
      });
      assert.strictEqual(who.status, 0, who.stderr || who.stdout);
      assert.match(who.stdout, /Name: SurfaceY/);
      assert.match(who.stdout, /Type: cmux/);

      const rejoin = runCli(fixtureHome, ['join', 'SurfaceY'], {
        PATH: fixturePath,
        CMUX_SURFACE_ID: 'surface-y',
        CMUX_WORKSPACE_ID: 'workspace-y',
      });
      assert.strictEqual(rejoin.status, 0, rejoin.stderr || rejoin.stdout);
      assert.match(
        rejoin.stderr,
        /session marker says MarkerX; this surface is registered as SurfaceY — child processes may have stamped the marker/
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('a marker-only headless session still resolves when no surface registration exists', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'swarm-marker-only-'));
    const fixtureHome = join(fixture, 'home');
    const fixturePath = fakeTtyPath(fixture, 'ttys998');
    try {
      const joined = runCli(fixtureHome, ['join', 'MarkerOnly', '--headless'], { PATH: fixturePath });
      assert.strictEqual(joined.status, 0, joined.stderr || joined.stdout);
      const who = runCli(fixtureHome, ['whoami'], { PATH: fixturePath });
      assert.strictEqual(who.status, 0, who.stderr || who.stdout);
      assert.match(who.stdout, /Name: MarkerOnly/);
      assert.match(who.stdout, /Type: headless/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('repeated members calls from a cmux-blind process preserve stale registrations and report unknown', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'swarm-members-blind-'));
    const fixtureHome = join(fixture, 'home');
    const fixturePath = fakeUnavailableCmuxPath(fixture);
    const cmuxLog = join(fixture, 'cmux.log');
    const common = { PATH: fixturePath, SWARM_TEST_CMUX_LOG: cmuxLog };
    try {
      for (const [name, surface] of [['BlindA', 'surface-blind-a'], ['BlindB', 'surface-blind-b']]) {
        const joined = runCli(fixtureHome, ['join', name], {
          ...common,
          CMUX_SURFACE_ID: surface,
          CMUX_WORKSPACE_ID: 'workspace-blind',
        });
        assert.strictEqual(joined.status, 0, joined.stderr || joined.stdout);
      }
      const sqlite = new DatabaseSync(join(fixtureHome, '.swarm', 'swarm.db'));
      sqlite.prepare("UPDATE agents SET last_heartbeat = ? WHERE agent_type = 'cmux'")
        .run(new Date(Date.now() - 60 * 60 * 1000).toISOString());
      sqlite.close();
      writeFileSync(cmuxLog, '');

      for (let attempt = 0; attempt < 2; attempt++) {
        const members = runCli(fixtureHome, ['members'], {
          ...common,
          CMUX_SURFACE_ID: 'surface-blind-a',
        });
        assert.strictEqual(members.status, 0, members.stderr || members.stdout);
        assert.match(members.stdout, /BlindA/);
        assert.match(members.stdout, /BlindB/);
        assert.match(members.stderr, /cmux unreachable from this process — liveness unknown/);
      }

      const after = new DatabaseSync(join(fixtureHome, '.swarm', 'swarm.db'), { readOnly: true });
      assert.strictEqual((after.prepare("SELECT count(*) AS n FROM agents WHERE agent_type = 'cmux'").get() as any).n, 2);
      after.close();
      assert.deepStrictEqual(readFileSync(cmuxLog, 'utf-8').trim().split('\n'), ['ping', 'ping']);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
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
    assert.match(s.stderr, /Allowed: status, digest, merge-req, escalation, ack, gate, handoff\./);
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

describe('cli supersession and pull/ack delivery', () => {
  function dropSessionMarkers(home: string) {
    const swarmDir = join(home, '.swarm');
    if (!existsSync(swarmDir)) return;
    for (const file of readdirSync(swarmDir)) {
      if (file.startsWith('headless-')) rmSync(join(swarmDir, file), { force: true });
    }
  }

  function joinHeadless(home: string, name: string) {
    const result = runCli(home, ['join', name, '--headless'], { SWARM_AGENT_NAME: name });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    dropSessionMarkers(home);
  }

  function openDb(home: string): SwarmDb {
    return new DatabaseSync(join(home, '.swarm', 'swarm.db'));
  }

  test('first join fences hook history while --recent deliberately replays it', () => {
    const home = mkdtempSync(join(tmpdir(), 'swarm-cli-fence-'));
    try {
      joinHeadless(home, 'Lead');
      const sqlite = openDb(home);
      sqlite.prepare(`
        INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at)
        VALUES ('default', 'Lead', NULL, 'historical doctrine', 1, ?)
      `).run(new Date().toISOString());
      sqlite.close();

      joinHeadless(home, 'Bob');
      const hook = runCli(home, ['hook-context'], { SWARM_AGENT_NAME: 'Bob' });
      assert.strictEqual(hook.status, 0, hook.stderr || hook.stdout);
      assert.doesNotMatch(hook.stdout, /historical doctrine/);
      assert.doesNotMatch(hook.stdout, /NEW MESSAGES/);

      const recent = runCli(home, ['inbox', '--recent', '10'], { SWARM_AGENT_NAME: 'Bob' });
      assert.strictEqual(recent.status, 0, recent.stderr || recent.stdout);
      assert.match(recent.stdout, /\[#1 .+\] Lead: historical doctrine/);

      const verify = openDb(home);
      const deliveries = verify.prepare('SELECT COUNT(*) AS n FROM message_deliveries').get() as { n: number };
      assert.strictEqual(deliveries.n, 0, 'hook/recent must not activate fenced history');
      verify.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('CLI owner validation and hook/recent supersession rendering', () => {
    const home = mkdtempSync(join(tmpdir(), 'swarm-cli-supersede-'));
    try {
      for (const name of ['Alice', 'Bob', 'Carol']) joinHeadless(home, name);
      const oldSend = runCli(home, ['send', 'Bob', 'old order'], { SWARM_AGENT_NAME: 'Alice' });
      assert.strictEqual(oldSend.status, 0, oldSend.stderr || oldSend.stdout);

      const sqlite = openDb(home);
      const old = sqlite.prepare("SELECT id FROM messages WHERE body = 'old order'").get() as { id: number };
      sqlite.close();

      const denied = runCli(
        home,
        ['send', 'Bob', 'not mine', '--supersedes', String(old.id)],
        { SWARM_AGENT_NAME: 'Carol' }
      );
      assert.notStrictEqual(denied.status, 0);
      assert.match(denied.stderr, /you can only supersede your own messages/);

      const replace = runCli(
        home,
        ['send', 'Bob', 'new order', '--supersedes', String(old.id)],
        { SWARM_AGENT_NAME: 'Alice' }
      );
      assert.strictEqual(replace.status, 0, replace.stderr || replace.stdout);

      const hook = runCli(home, ['hook-context'], { SWARM_AGENT_NAME: 'Bob' });
      assert.match(hook.stdout, /new order/);
      assert.doesNotMatch(hook.stdout, /old order/);

      const verify = openDb(home);
      const replacement = verify.prepare("SELECT id FROM messages WHERE body = 'new order'").get() as { id: number };
      verify.close();
      const recent = runCli(home, ['inbox', '--recent', '10'], { SWARM_AGENT_NAME: 'Bob' });
      assert.match(recent.stdout, /old order \[superseded by #\d+\]/);
      assert.match(recent.stdout, /new order/);
      assert.match(recent.stdout, new RegExp(`superseded by #${replacement.id}`));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('broadcast --supersedes creates the forward tombstone used by every recipient', () => {
    const home = mkdtempSync(join(tmpdir(), 'swarm-cli-broadcast-supersede-'));
    try {
      joinHeadless(home, 'Alice');
      joinHeadless(home, 'Bob');
      const oldBroadcast = runCli(home, ['broadcast', 'old broadcast'], { SWARM_AGENT_NAME: 'Alice' });
      assert.strictEqual(oldBroadcast.status, 0, oldBroadcast.stderr || oldBroadcast.stdout);
      const sqlite = openDb(home);
      const old = sqlite.prepare("SELECT id FROM messages WHERE body = 'old broadcast'").get() as { id: number };
      sqlite.close();

      const replacement = runCli(
        home,
        ['broadcast', 'new broadcast', '--supersedes', String(old.id)],
        { SWARM_AGENT_NAME: 'Alice' }
      );
      assert.strictEqual(replacement.status, 0, replacement.stderr || replacement.stdout);
      const hook = runCli(home, ['hook-context'], { SWARM_AGENT_NAME: 'Bob' });
      assert.match(hook.stdout, /new broadcast/);
      assert.doesNotMatch(hook.stdout, /old broadcast/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('hook turn loss keeps a message pending, third injection collapses, and ack clears it', () => {
    const home = mkdtempSync(join(tmpdir(), 'swarm-cli-hook-'));
    try {
      joinHeadless(home, 'Alice');
      joinHeadless(home, 'Bob');
      const send = runCli(home, ['send', 'Bob', 'survive compaction', '--kind', 'gate'], { SWARM_AGENT_NAME: 'Alice' });
      assert.strictEqual(send.status, 0, send.stderr || send.stdout);

      const sqlite = openDb(home);
      const message = sqlite.prepare("SELECT id FROM messages WHERE body = 'survive compaction'").get() as { id: number };
      sqlite.close();

      const first = runCli(home, ['hook-context'], { SWARM_AGENT_NAME: 'Bob' });
      const second = runCli(home, ['hook-context'], { SWARM_AGENT_NAME: 'Bob' });
      const third = runCli(home, ['hook-context'], { SWARM_AGENT_NAME: 'Bob' });
      assert.match(first.stdout, new RegExp(`\\[#${message.id} .+\\] \\[gate\\] Alice: survive compaction`));
      assert.match(second.stdout, /survive compaction/);
      assert.match(third.stdout, new RegExp(`\\(#${message.id} from Alice, unacked for \\d+m`));
      assert.doesNotMatch(third.stdout, /survive compaction/);

      const pendingDb = openDb(home);
      const delivery = pendingDb.prepare('SELECT status, inject_count FROM message_deliveries WHERE message_id = ?')
        .get(message.id) as { status: string; inject_count: number };
      const watermark = pendingDb.prepare("SELECT last_read_id FROM inbox_cursors WHERE agent_name = 'Bob'").get() as { last_read_id: number };
      assert.deepStrictEqual({ ...delivery }, { status: 'injected', inject_count: 3 });
      assert.strictEqual(watermark.last_read_id, 0);
      pendingDb.close();

      const ack = runCli(home, ['ack', String(message.id)], { SWARM_AGENT_NAME: 'Bob' });
      assert.strictEqual(ack.status, 0, ack.stderr || ack.stdout);
      const ackAgain = runCli(home, ['ack', String(message.id)], { SWARM_AGENT_NAME: 'Bob' });
      assert.strictEqual(ackAgain.status, 0, ackAgain.stderr || ackAgain.stdout);
      const after = runCli(home, ['hook-context'], { SWARM_AGENT_NAME: 'Bob' });
      assert.doesNotMatch(after.stdout, /survive compaction/);
      assert.doesNotMatch(after.stdout, new RegExp(`#${message.id} from Alice`));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('peek/recent/kind reads do not ack, while plain inbox acks every printed row', () => {
    const home = mkdtempSync(join(tmpdir(), 'swarm-cli-read-'));
    try {
      joinHeadless(home, 'Alice');
      joinHeadless(home, 'Bob');
      for (const [body, kind] of [['plain', undefined], ['gate item', 'gate'], ['status item', 'status']] as const) {
        const args = ['send', 'Bob', body];
        if (kind) args.push('--kind', kind);
        const sent = runCli(home, args, { SWARM_AGENT_NAME: 'Alice' });
        assert.strictEqual(sent.status, 0, sent.stderr || sent.stdout);
      }

      const filtered = runCli(home, ['inbox', '--kind', 'gate'], { SWARM_AGENT_NAME: 'Bob' });
      const peek = runCli(home, ['inbox', '--peek'], { SWARM_AGENT_NAME: 'Bob' });
      const recent = runCli(home, ['inbox', '--recent', '10'], { SWARM_AGENT_NAME: 'Bob' });
      assert.match(filtered.stdout, /gate item/);
      assert.match(peek.stdout, /plain/);
      assert.match(recent.stdout, /status item/);

      const before = openDb(home);
      const beforeAck = before.prepare("SELECT COUNT(*) AS n FROM message_deliveries WHERE status = 'acked'").get() as { n: number };
      const beforeCursor = before.prepare("SELECT last_read_id FROM inbox_cursors WHERE agent_name = 'Bob'").get() as { last_read_id: number };
      assert.strictEqual(beforeAck.n, 0);
      assert.strictEqual(beforeCursor.last_read_id, 0);
      before.close();

      const plain = runCli(home, ['inbox'], { SWARM_AGENT_NAME: 'Bob' });
      assert.match(plain.stdout, /3 message\(s\)/);
      const after = openDb(home);
      const afterAck = after.prepare("SELECT COUNT(*) AS n FROM message_deliveries WHERE status = 'acked'").get() as { n: number };
      const maxMessage = after.prepare('SELECT MAX(id) AS id FROM messages').get() as { id: number };
      const afterCursor = after.prepare("SELECT last_read_id FROM inbox_cursors WHERE agent_name = 'Bob'").get() as { last_read_id: number };
      assert.strictEqual(afterAck.n, 3);
      assert.strictEqual(afterCursor.last_read_id, maxMessage.id);
      after.close();

      for (const body of ['ack one', 'ack two']) {
        const sent = runCli(home, ['send', 'Bob', body], { SWARM_AGENT_NAME: 'Alice' });
        assert.strictEqual(sent.status, 0, sent.stderr || sent.stdout);
      }
      const idsDb = openDb(home);
      const ids = idsDb.prepare("SELECT id FROM messages WHERE body IN ('ack one', 'ack two') ORDER BY id")
        .all() as Array<{ id: number }>;
      idsDb.close();
      const ackMany = runCli(home, ['ack', ...ids.map(row => String(row.id))], { SWARM_AGENT_NAME: 'Bob' });
      assert.strictEqual(ackMany.status, 0, ackMany.stderr || ackMany.stdout);
      assert.match(ackMany.stdout, /Acknowledged 2 message\(s\)/);

      const finalSend = runCli(home, ['send', 'Bob', 'ack all'], { SWARM_AGENT_NAME: 'Alice' });
      assert.strictEqual(finalSend.status, 0, finalSend.stderr || finalSend.stdout);
      const ackAll = runCli(home, ['ack', '--all'], { SWARM_AGENT_NAME: 'Bob' });
      assert.strictEqual(ackAll.status, 0, ackAll.stderr || ackAll.stdout);
      assert.match(ackAll.stdout, /Acknowledged 1 message\(s\)/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
