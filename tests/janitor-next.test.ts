import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getDbAt, type SwarmDb } from '../src/db.js';
import {
  acquireJanitorLock,
  addJanitorRoot,
  formatJanitorHookLine,
  getJanitorStatus,
  installJanitorLaunchAgent,
  stableNodePath,
  JANITOR_HEARTBEAT_STALE_MS,
  JANITOR_TICK_STALENESS_MS,
  readJanitorRoots,
  removeJanitorRoot,
  runJanitorTick as runJanitorTickRaw,
  shouldSpawnJanitorTick,
  uninstallJanitorLaunchAgent,
  type JanitorCounters,
  type JanitorStatus,
  type JanitorTickOptions,
  type JanitorTickResult,
  type SwarmVersionGitRunner,
} from '../src/janitor.js';
import { formatFleetStats, getFleetStats } from '../src/stats.js';

const INDEX = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const VERSION_SHA = 'a'.repeat(40);
const VERSION_RUNNER: SwarmVersionGitRunner = (_binary, args) =>
  args[0] === 'ls-remote' ? `${VERSION_SHA}\trefs/heads/master\n` : `${VERSION_SHA}\n`;

function runJanitorTick(
  db: SwarmDb,
  options: JanitorTickOptions = {}
): JanitorTickResult {
  return runJanitorTickRaw(db, { versionRunner: VERSION_RUNNER, ...options });
}

interface CliResult { stdout: string; stderr: string; status: number }

function runCli(home: string, args: string[], envOverrides: Record<string, string> = {}): CliResult {
  const tmp = path.join(home, 'cli tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: tmp,
    SWARM_ID: '',
    SWARM_NAME: '',
    SWARM_AGENT_NAME: '',
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
    ...envOverrides,
  };
  try {
    const stdout = execFileSync('node', ['--import', 'tsx', INDEX, ...args], {
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function worktreeState(worktree: string): { status: string; indexMtimeMs: number } {
  const status = git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']);
  const rawIndexPath = git(worktree, ['rev-parse', '--git-path', 'index']);
  const indexPath = path.isAbsolute(rawIndexPath) ? rawIndexPath : path.resolve(worktree, rawIndexPath);
  return { status, indexMtimeMs: fs.statSync(indexPath).mtimeMs };
}

function emptyCounters(overrides: Partial<JanitorCounters> = {}): JanitorCounters {
  return {
    worktrees: 0,
    detachedHeads: 0,
    orphanedWorktrees: 0,
    unpushedCommits: 0,
    goneUpstreamBranches: 0,
    tempStrays: 0,
    junkDirs: 0,
    reposScanned: 0,
    tickMs: 0,
    ...overrides,
  };
}

describe('WI-5 observe-only janitor census', () => {
  let suiteRoot: string;

  before(() => {
    suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-janitor-next-'));
  });

  after(() => {
    fs.rmSync(suiteRoot, { recursive: true, force: true });
  });

  test('fixture census is correct, idempotent, clears removed paths, snapshots, and does not write repos', () => {
    const fixture = fs.mkdtempSync(path.join(suiteRoot, 'fixture-'));
    const home = path.join(fixture, 'home with spaces');
    const censusRoot = path.join(fixture, 'census root');
    const repo = path.join(censusRoot, 'repo with spaces');
    const remote = path.join(fixture, 'remote.git');
    const detachedWorktree = path.join(censusRoot, 'detached worktree');
    const orphanedWorktree = path.join(censusRoot, 'orphaned worktree');
    const tempRoot = path.join(fixture, 'fake tmp');
    const tempWorktree = path.join(tempRoot, 'stray worktree');
    const junkDir = path.join(censusRoot, 'pe-marketing-pixel');
    const swarmDir = path.join(home, '.swarm');
    fs.mkdirSync(swarmDir, { recursive: true });
    fs.mkdirSync(censusRoot, { recursive: true });
    fs.mkdirSync(tempRoot, { recursive: true });

    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
    git(repo, ['config', 'user.name', 'Swarm Janitor Test']);
    git(repo, ['config', 'user.email', 'janitor@example.test']);
    writeFile(path.join(repo, 'tracked.txt'), 'base\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'initial']);
    git(repo, ['remote', 'add', 'origin', pathToFileURL(remote).href]);
    git(repo, ['push', '-u', 'origin', 'main']);

    git(repo, ['checkout', '-b', 'gone-branch']);
    writeFile(path.join(repo, 'gone.txt'), 'gone upstream\n');
    git(repo, ['add', 'gone.txt']);
    git(repo, ['commit', '-m', 'gone branch commit']);
    git(repo, ['push', '-u', 'origin', 'gone-branch']);
    git(repo, ['push', 'origin', '--delete', 'gone-branch']);
    git(repo, ['fetch', '--prune', 'origin']);

    git(repo, ['checkout', 'main']);
    writeFile(path.join(repo, 'local.txt'), 'not pushed\n');
    git(repo, ['add', 'local.txt']);
    git(repo, ['commit', '-m', 'local only commit']);
    git(repo, ['worktree', 'add', '--detach', detachedWorktree, 'HEAD']);
    git(repo, ['worktree', 'add', '-b', 'temp-stray-fixture', tempWorktree, 'HEAD']);
    git(repo, ['worktree', 'add', '-b', 'orphan-fixture', orphanedWorktree, 'HEAD']);
    fs.rmSync(orphanedWorktree, { recursive: true, force: true });
    fs.mkdirSync(path.join(junkDir, 'node_modules'), { recursive: true });

    const db = getDbAt(path.join(swarmDir, 'swarm.db'));
    const createdAt = new Date().toISOString();
    db.prepare('UPDATE swarms SET root_path = ? WHERE id = ?').run(censusRoot, 'default');
    db.prepare(`
      INSERT INTO swarms (id, name, root_path, description, created_at, last_active_at)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).run('repo-root', 'repo-root', repo, createdAt, createdAt);

    const worktrees = [repo, detachedWorktree, tempWorktree];
    const beforeStates = new Map(worktrees.map(worktree => [worktree, worktreeState(worktree)]));
    const expectedUnpushed = git(repo, ['log', '--branches', '--not', '--remotes', '--oneline'])
      .split('\n').filter(Boolean).length;
    const firstAt = Date.now();
    const first = runJanitorTick(db, { homeDir: home, tempScanPaths: [tempRoot], now: firstAt });

    assert.strictEqual(first.ran, true);
    assert.deepStrictEqual(readJanitorRoots({ homeDir: home }), [censusRoot, repo]);
    assert.deepStrictEqual(first.counters, {
      worktrees: 4,
      detachedHeads: 1,
      orphanedWorktrees: 1,
      unpushedCommits: expectedUnpushed,
      goneUpstreamBranches: 1,
      tempStrays: 1,
      junkDirs: 1,
      reposScanned: 1,
      tickMs: first.counters!.tickMs,
    });

    const firstRows = db.prepare('SELECT * FROM janitor_findings ORDER BY kind, path').all() as any[];
    assert.strictEqual(firstRows.length, 6);
    assert.deepStrictEqual(firstRows.map(row => row.kind), [
      'detached-head',
      'gone-upstream-branches',
      'junk-dir',
      'orphaned-worktree',
      'temp-stray-worktree',
      'unpushed-commits',
    ]);
    assert.ok(firstRows.every(row => row.state === 'hold'));
    assert.strictEqual(JSON.parse(firstRows.find(row => row.kind === 'gone-upstream-branches').detail).count, 1);
    assert.strictEqual(JSON.parse(firstRows.find(row => row.kind === 'unpushed-commits').detail).count, expectedUnpushed);

    for (const worktree of worktrees) {
      assert.deepStrictEqual(worktreeState(worktree), beforeStates.get(worktree));
    }

    const secondAt = firstAt + 60_000;
    const second = runJanitorTick(db, { homeDir: home, tempScanPaths: [tempRoot], now: secondAt });
    assert.strictEqual(second.ran, true);
    const secondRows = db.prepare('SELECT * FROM janitor_findings ORDER BY kind, path').all() as any[];
    assert.strictEqual(secondRows.length, firstRows.length);
    for (const row of secondRows) {
      assert.strictEqual(row.first_seen_at, new Date(firstAt).toISOString());
      assert.strictEqual(row.last_seen_at, new Date(secondAt).toISOString());
      assert.strictEqual(row.state, 'hold');
    }
    assert.strictEqual((db.prepare('SELECT count(*) AS count FROM janitor_snapshots').get() as any).count, 2);

    fs.rmSync(junkDir, { recursive: true, force: true });
    const thirdAt = secondAt + 60_000;
    runJanitorTick(db, { homeDir: home, tempScanPaths: [tempRoot], now: thirdAt });
    const cleared = db.prepare("SELECT * FROM janitor_findings WHERE kind = 'junk-dir'").get() as any;
    assert.strictEqual(cleared.state, 'cleared');
    assert.strictEqual(cleared.last_seen_at, new Date(secondAt).toISOString());
    assert.strictEqual((db.prepare('SELECT count(*) AS count FROM janitor_snapshots').get() as any).count, 3);

    const formattedStats = formatFleetStats(getFleetStats(db, 'default', 24, 0, thirdAt));
    assert.match(formattedStats, /Janitor\/debris:/);
    assert.match(formattedStats, /worktrees: 4 total \| 1 detached \| 1 orphaned/);
    assert.match(formattedStats, new RegExp(`commits: ${expectedUnpushed} unpushed \\| upstream branches gone: 1`));
    assert.match(formattedStats, /temp strays: 1 \| junk dirs: 0 \| repos scanned: 1/);
    db.close();

    const cliStats = runCli(home, ['stats']);
    assert.strictEqual(cliStats.status, 0, cliStats.stderr);
    assert.match(cliStats.stdout, /Janitor\/debris:/);
    assert.match(cliStats.stdout, /worktrees: 4 total \| 1 detached \| 1 orphaned/);
    assert.match(cliStats.stdout, /temp strays: 1 \| junk dirs: 0 \| repos scanned: 1/);
  });

  test('tick refuses destructive mode with the exact v1 message', () => {
    const home = fs.mkdtempSync(path.join(suiteRoot, 'refusal-home-'));
    const result = runCli(home, ['janitor', 'tick']);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(
      result.stderr.trim(),
      'only --observe is implemented; destructive phases are deliberately unbuilt — see docs/design/SWARM-NEXT-V1.md'
    );
  });

  test('roots list/add/remove stores normalized absolute paths under ~/.swarm', () => {
    const home = fs.mkdtempSync(path.join(suiteRoot, 'roots-home-'));
    const root = path.join(suiteRoot, 'managed root');
    fs.mkdirSync(root, { recursive: true });
    const added = runCli(home, ['janitor', 'roots', 'add', root]);
    assert.strictEqual(added.status, 0, added.stderr);
    assert.deepStrictEqual(readJanitorRoots({ homeDir: home }), [root]);
    assert.match(runCli(home, ['janitor', 'roots', 'list']).stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const removed = runCli(home, ['janitor', 'roots', 'remove', root]);
    assert.strictEqual(removed.status, 0, removed.stderr);
    assert.deepStrictEqual(readJanitorRoots({ homeDir: home }), []);

    assert.deepStrictEqual(addJanitorRoot(root, { homeDir: home }), [root]);
    assert.deepStrictEqual(removeJanitorRoot(root, { homeDir: home }), []);
  });

  test('hook line renders fresh and loud stale variants and uses the trigger thresholds', () => {
    const now = Date.now();
    const status: JanitorStatus = {
      lastTickAt: new Date(now - 4 * 60_000).toISOString(),
      lastDurationMs: 42,
      counters: emptyCounters({
        worktrees: 3,
        detachedHeads: 1,
        unpushedCommits: 129,
        tempStrays: 2,
        junkDirs: 1,
      }),
    };
    assert.strictEqual(
      formatJanitorHookLine(status, now),
      'janitor: tick 4m ago | debris: 3 worktrees (1 detached), 129 unpushed commits, 2 temp strays, 1 junk dir'
    );
    assert.strictEqual(shouldSpawnJanitorTick(status, now), false);
    assert.strictEqual(shouldSpawnJanitorTick(null, now), true);

    const triggerStatus = { ...status, lastTickAt: new Date(now - JANITOR_TICK_STALENESS_MS - 1).toISOString() };
    assert.strictEqual(shouldSpawnJanitorTick(triggerStatus, now), true);
    const staleStatus = { ...status, lastTickAt: new Date(now - JANITOR_HEARTBEAT_STALE_MS - 60_000).toISOString() };
    assert.strictEqual(
      formatJanitorHookLine(staleStatus, now),
      'JANITOR HEARTBEAT STALE (31m) — debris: 3 worktrees (1 detached), 129 unpushed commits, 2 temp strays, 1 junk dir'
    );

    const home = fs.mkdtempSync(path.join(suiteRoot, 'hook-home-'));
    const joined = runCli(home, ['join', 'Alice', '--headless'], { SWARM_AGENT_NAME: 'Alice' });
    assert.strictEqual(joined.status, 0, joined.stderr);
    const db = getDbAt(path.join(home, '.swarm', 'swarm.db'));
    db.prepare(`
      INSERT INTO janitor_status (id, last_tick_at, last_duration_ms, counters)
      VALUES (1, ?, ?, ?)
    `).run(status.lastTickAt, status.lastDurationMs, JSON.stringify(status.counters));
    db.close();
    const hook = runCli(home, ['hook-context'], { SWARM_AGENT_NAME: 'Alice' });
    assert.strictEqual(hook.status, 0, hook.stderr);
    assert.match(hook.stdout, /janitor: tick [34]m ago \| debris: 3 worktrees \(1 detached\), 129 unpushed commits, 2 temp strays, 1 junk dir/);
  });

  test('a concurrent second tick no-ops cleanly and stats reports never run', () => {
    const home = fs.mkdtempSync(path.join(suiteRoot, 'lock-home-'));
    const swarmDir = path.join(home, '.swarm');
    fs.mkdirSync(swarmDir, { recursive: true });
    const db = getDbAt(path.join(swarmDir, 'swarm.db'));
    const release = acquireJanitorLock({ homeDir: home });
    assert.ok(release);
    try {
      const second = runJanitorTick(db, { homeDir: home, tempScanPaths: [] });
      assert.deepStrictEqual(second, { ran: false, lockedOut: true });
      assert.strictEqual(getJanitorStatus(db), null);
      assert.match(formatFleetStats(getFleetStats(db, 'default', 24, 0)), /janitor: never run/);
    } finally {
      release!();
      db.close();
    }
  });

  test('install/uninstall writes only the injected launch-agent plist and never loads it', () => {
    const launchAgentsDir = path.join(suiteRoot, 'fake Library', 'LaunchAgents');
    const entrypoint = path.join(suiteRoot, 'repo with spaces', 'dist', 'index.js');
    const plistPath = installJanitorLaunchAgent({
      launchAgentsDir,
      nodePath: '/test/node',
      entrypointPath: entrypoint,
      launchctlCommand: false,
    });
    assert.strictEqual(plistPath, path.join(launchAgentsDir, 'io.swarm.janitor.plist'));
    const plist = fs.readFileSync(plistPath, 'utf-8');
    assert.match(plist, /<integer>900<\/integer>/);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<string>\/test\/node<\/string>/);
    assert.match(plist, new RegExp(`<string>${entrypoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
    assert.match(plist, /<string>janitor<\/string>\s*<string>tick<\/string>\s*<string>--observe<\/string>/);
    assert.strictEqual(uninstallJanitorLaunchAgent({ launchAgentsDir, launchctlCommand: false }), true);
    assert.strictEqual(fs.existsSync(plistPath), false);
    assert.strictEqual(uninstallJanitorLaunchAgent({ launchAgentsDir, launchctlCommand: false }), false);
  });

  /**
   * Measured failure this fixes: the plist held /opt/homebrew/Cellar/node/25.9.0_1/bin/node,
   * `brew upgrade node` moved to 26.5.0, and the job failed with exit 78 from then on —
   * while launchctl still listed it, so registered-and-dead looked exactly like
   * registered-and-working.
   */
  test('stableNodePath rewrites a version-pinned Cellar path to an alias that survives upgrade', () => {
    const cellar = '/opt/homebrew/Cellar/node/26.5.0/bin/node';
    const stable = '/opt/homebrew/bin/node';
    const resolved = stableNodePath(cellar, {
      existsSync: (p) => p === stable,
      // Both aliases resolve to the SAME binary today, which is the precondition for
      // swapping one for the other.
      realpathSync: (p) => (p === stable || p === cellar ? cellar : p),
    });
    assert.strictEqual(resolved, stable);
  });

  test('stableNodePath keeps a path that is not version-pinned', () => {
    // The mock is built so the guard is LOAD-BEARING: this path's realpath matches a
    // candidate alias, so without the not-pinned guard it would be rewritten. A mock that
    // cannot distinguish the two cases would pass either way.
    const plain = '/usr/bin/node';
    const resolved = stableNodePath(plain, {
      existsSync: (c) => c === '/opt/homebrew/bin/node',
      realpathSync: () => '/shared/real/node',
    });
    assert.strictEqual(resolved, plain, 'a non-pinned path must be left alone');
  });

  test('stableNodePath keeps the Cellar path when no alias resolves to the same binary', () => {
    // Never point the job at a DIFFERENT node than the one that installed it: a wrong
    // interpreter is worse than a pinned one, because it may half-work.
    const cellar = '/opt/homebrew/Cellar/node/26.5.0/bin/node';
    const resolved = stableNodePath(cellar, {
      existsSync: () => true,
      realpathSync: (p) => (p === cellar ? cellar : '/some/other/node'),
    });
    assert.strictEqual(resolved, cellar);
  });

  test('installing WITHOUT an explicit nodePath resolves a Cellar default on EVERY platform', () => {
    // Platform-independent by construction. The earlier version only caught the bug on a
    // host whose own execPath was Homebrew-pinned; anywhere else stableNodePath() equals
    // process.execPath, the assertion was skipped, and reverting the installer stayed
    // green. The seam drives a SIMULATED Cellar default through the real installer.
    const launchAgentsDir = path.join(suiteRoot, 'default Library', 'LaunchAgents');
    const cellar = '/opt/homebrew/Cellar/node/26.5.0/bin/node';
    const stable = '/opt/homebrew/bin/node';
    const plistPath = installJanitorLaunchAgent({
      launchAgentsDir,
      homeDir: path.join(suiteRoot, 'default home'),
      entrypointPath: '/test/index.js',
      launchctlCommand: false,
      execPath: cellar,
      pathProbe: {
        existsSync: (c) => c === stable,
        realpathSync: (c) => (c === stable || c === cellar ? cellar : c),
      },
    });
    const plist = fs.readFileSync(plistPath, 'utf-8');
    assert.ok(plist.includes(`<string>${stable}</string>`), 'plist must use the stable alias');
    assert.ok(!plist.includes('/Cellar/'), 'a version-pinned path must never reach the plist');
  });

  test('the installed plist can report its own failure', () => {
    const launchAgentsDir = path.join(suiteRoot, 'stderr Library', 'LaunchAgents');
    const homeDir = path.join(suiteRoot, 'stderr home');
    const plistPath = installJanitorLaunchAgent({
      launchAgentsDir, homeDir, nodePath: '/test/node',
      entrypointPath: '/test/index.js', launchctlCommand: false,
    });
    const plist = fs.readFileSync(plistPath, 'utf-8');
    assert.match(plist, /<key>StandardErrorPath<\/key>/);
    assert.match(plist, /janitor-stderr\.log/);
    // launchd creates the FILE but never missing parent directories, so on a fresh
    // install the diagnostic path would be unusable exactly when it is needed.
    assert.ok(fs.existsSync(path.join(homeDir, '.swarm')),
      'installer must create the stderr log directory; launchd will not');
  });
});
