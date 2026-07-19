import type Database from 'better-sqlite3';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const JANITOR_TICK_STALENESS_MS = 10 * 60 * 1000;
export const JANITOR_HEARTBEAT_STALE_MS = 30 * 60 * 1000;
export const JANITOR_LOCK_STALE_MS = 10 * 60 * 1000;

export interface JanitorCounters {
  worktrees: number;
  detachedHeads: number;
  orphanedWorktrees: number;
  unpushedCommits: number;
  goneUpstreamBranches: number;
  tempStrays: number;
  junkDirs: number;
  reposScanned: number;
  tickMs: number;
}

export interface JanitorStatus {
  lastTickAt: string;
  lastDurationMs: number;
  counters: JanitorCounters;
}

export type JanitorFindingKind =
  | 'orphaned-worktree'
  | 'detached-head'
  | 'gone-upstream-branches'
  | 'unpushed-commits'
  | 'temp-stray-worktree'
  | 'junk-dir';

interface Finding {
  kind: JanitorFindingKind;
  path: string;
  detail: Record<string, unknown>;
}

interface WorktreeRecord {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
}

interface RepoRecord {
  commandPath: string;
  commonGitDir: string;
}

export interface JanitorPathsOptions {
  homeDir?: string;
}

export interface JanitorTickOptions extends JanitorPathsOptions {
  /** Top-level temp directories to inspect. Defaults to /private/tmp and $TMPDIR. */
  tempScanPaths?: string[];
  /** Injectable wall clock for deterministic finding/status ages in tests. */
  now?: number;
  lockStaleMs?: number;
}

export interface JanitorTickResult {
  ran: boolean;
  lockedOut: boolean;
  counters?: JanitorCounters;
  findings?: number;
}

export interface JanitorInstallOptions extends JanitorPathsOptions {
  launchAgentsDir?: string;
  nodePath?: string;
  entrypointPath?: string;
  /** Set false in tests; production uninstall best-effort unloads first. */
  launchctlCommand?: string | false;
}

const BUILD_OUTPUT_NAMES = new Set(['node_modules', '.astro', 'dist', 'build', '.next', '.cache']);

function janitorSwarmDir(options: JanitorPathsOptions = {}): string {
  return path.join(options.homeDir ?? os.homedir(), '.swarm');
}

export function janitorRootsPath(options: JanitorPathsOptions = {}): string {
  return path.join(janitorSwarmDir(options), 'janitor-roots.json');
}

function janitorLockPath(options: JanitorPathsOptions = {}): string {
  return path.join(janitorSwarmDir(options), 'locks', 'janitor.lock');
}

function normalizeRoots(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(root => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw new Error('~/.swarm/janitor-roots.json must be a JSON array of absolute paths');
  }
  return [...new Set(value.map(root => path.normalize(root)))];
}

export function readJanitorRoots(options: JanitorPathsOptions = {}): string[] {
  const rootsPath = janitorRootsPath(options);
  if (!fs.existsSync(rootsPath)) return [];
  return normalizeRoots(JSON.parse(fs.readFileSync(rootsPath, 'utf-8')));
}

function writeJanitorRoots(roots: string[], options: JanitorPathsOptions = {}): void {
  const rootsPath = janitorRootsPath(options);
  fs.mkdirSync(path.dirname(rootsPath), { recursive: true });
  fs.writeFileSync(rootsPath, `${JSON.stringify(roots, null, 2)}\n`, 'utf-8');
}

export function addJanitorRoot(root: string, options: JanitorPathsOptions = {}): string[] {
  const absolute = path.resolve(root);
  const roots = readJanitorRoots(options);
  if (!roots.includes(absolute)) roots.push(absolute);
  writeJanitorRoots(roots, options);
  return roots;
}

export function removeJanitorRoot(root: string, options: JanitorPathsOptions = {}): string[] {
  const absolute = path.resolve(root);
  const roots = readJanitorRoots(options).filter(candidate => candidate !== absolute);
  writeJanitorRoots(roots, options);
  return roots;
}

function loadOrSeedJanitorRoots(
  db: Database.Database,
  options: JanitorPathsOptions = {}
): string[] {
  const rootsPath = janitorRootsPath(options);
  if (fs.existsSync(rootsPath)) return readJanitorRoots(options);

  const rows = db.prepare('SELECT root_path FROM swarms WHERE root_path IS NOT NULL ORDER BY created_at')
    .all() as Array<{ root_path: string }>;
  const roots = [...new Set(rows
    .map(row => path.resolve(row.root_path))
    .filter(root => isDirectory(root)))];
  writeJanitorRoots(roots, options);
  return roots;
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function canonicalExistingPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function discoverRepositories(roots: string[]): RepoRecord[] {
  const byCommonDir = new Map<string, RepoRecord>();

  for (const root of roots) {
    if (!isDirectory(root)) continue;
    const candidates = [root];
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const candidate = path.join(root, entry.name);
        if ((entry.isDirectory() || entry.isSymbolicLink()) && isDirectory(candidate)) {
          candidates.push(candidate);
        }
      }
    } catch {
      continue;
    }

    for (const candidate of candidates) {
      if (!fs.existsSync(path.join(candidate, '.git'))) continue;
      const commonRaw = gitOutput(candidate, ['rev-parse', '--git-common-dir'])?.trim();
      if (!commonRaw) continue;
      const commonGitDir = canonicalExistingPath(
        path.isAbsolute(commonRaw) ? commonRaw : path.resolve(candidate, commonRaw)
      );
      if (!byCommonDir.has(commonGitDir)) {
        byCommonDir.set(commonGitDir, { commandPath: candidate, commonGitDir });
      }
    }
  }

  return [...byCommonDir.values()];
}

function parseWorktrees(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;

  const finish = () => {
    if (current) records.push(current);
    current = null;
  };

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      finish();
      current = { path: line.slice('worktree '.length), detached: false };
    } else if (!line) {
      finish();
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (current && line === 'detached') {
      current.detached = true;
    }
  }
  finish();
  return records;
}

function resolveWorktreeGitDir(worktreePath: string): { path: string; exists: boolean } {
  const dotGit = path.join(worktreePath, '.git');
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return { path: canonicalExistingPath(dotGit), exists: true };
    if (stat.isFile()) {
      const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
      if (match) {
        const resolved = path.resolve(path.dirname(dotGit), match[1]);
        return { path: canonicalExistingPath(resolved), exists: fs.existsSync(resolved) };
      }
    }
  } catch {
    // The worktree itself may have disappeared while its admin entry remains.
  }
  return { path: dotGit, exists: false };
}

function parseStatusCounts(output: string): { dirty: number; untracked: number } {
  const records = output.split('\0');
  let dirty = 0;
  let untracked = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 3) continue;
    const status = record.slice(0, 2);
    if (status === '??') untracked++;
    else dirty++;
    if (status.includes('R') || status.includes('C')) index++;
  }
  return { dirty, untracked };
}

function addFinding(findings: Map<string, Finding>, finding: Finding): void {
  findings.set(`${finding.kind}\0${finding.path}`, finding);
}

function repoDisplayPath(repo: RepoRecord, worktrees: WorktreeRecord[]): string {
  const main = worktrees[0]?.path;
  if (main) return path.resolve(main);
  return path.basename(repo.commonGitDir) === '.git'
    ? path.dirname(repo.commonGitDir)
    : path.resolve(repo.commandPath);
}

function scanRepositories(
  repos: RepoRecord[],
  findings: Map<string, Finding>,
  counters: JanitorCounters
): void {
  const seenWorktrees = new Set<string>();

  for (const repo of repos) {
    const worktreeOutput = gitOutput(repo.commandPath, ['worktree', 'list', '--porcelain']);
    if (worktreeOutput === null) continue;
    counters.reposScanned++;
    const worktrees = parseWorktrees(worktreeOutput);
    const repoPath = repoDisplayPath(repo, worktrees);

    for (const worktree of worktrees) {
      const worktreePath = path.resolve(worktree.path);
      if (!seenWorktrees.has(worktreePath)) {
        counters.worktrees++;
        seenWorktrees.add(worktreePath);
      }

      const gitdir = resolveWorktreeGitDir(worktreePath);
      const status = gitdir.exists
        ? parseStatusCounts(gitOutput(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) ?? '')
        : { dirty: 0, untracked: 0 };

      if (!gitdir.exists) {
        counters.orphanedWorktrees++;
        addFinding(findings, {
          kind: 'orphaned-worktree',
          path: worktreePath,
          detail: { repo: repoPath, gitdir: gitdir.path },
        });
      }
      if (worktree.detached) {
        counters.detachedHeads++;
        addFinding(findings, {
          kind: 'detached-head',
          path: worktreePath,
          detail: {
            repo: repoPath,
            head: worktree.head ?? null,
            dirty: status.dirty,
            untracked: status.untracked,
          },
        });
      }
    }

    const branchOutput = gitOutput(repo.commandPath, ['branch', '-vv', '--no-color']) ?? '';
    const goneBranches = branchOutput.split('\n')
      .filter(line => line.includes(': gone]'))
      .map(line => line.replace(/^\s*\*?\s*/, '').split(/\s+/, 1)[0])
      .filter(Boolean);
    if (goneBranches.length > 0) {
      counters.goneUpstreamBranches += goneBranches.length;
      addFinding(findings, {
        kind: 'gone-upstream-branches',
        path: repoPath,
        detail: { count: goneBranches.length, branches: goneBranches },
      });
    }

    const unpushedOutput = gitOutput(
      repo.commandPath,
      ['log', '--branches', '--not', '--remotes', '--oneline']
    ) ?? '';
    const unpushedCount = unpushedOutput.split('\n').filter(Boolean).length;
    if (unpushedCount > 0) {
      counters.unpushedCommits += unpushedCount;
      addFinding(findings, {
        kind: 'unpushed-commits',
        path: repoPath,
        detail: { count: unpushedCount },
      });
    }
  }
}

function isWithin(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function defaultTempScanPaths(): string[] {
  return ['/private/tmp', ...(process.env.TMPDIR ? [process.env.TMPDIR] : [])];
}

function dedupeExistingDirectories(paths: string[]): string[] {
  const byCanonical = new Map<string, string>();
  for (const candidate of paths) {
    if (!isDirectory(candidate)) continue;
    const canonical = canonicalExistingPath(candidate);
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, candidate);
  }
  return [...byCanonical.values()];
}

function scanTempWorktrees(
  tempPaths: string[],
  repos: RepoRecord[],
  findings: Map<string, Finding>,
  counters: JanitorCounters
): void {
  const repoGitDirs = repos.map(repo => canonicalExistingPath(repo.commonGitDir));

  for (const tempRoot of dedupeExistingDirectories(tempPaths)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(tempRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(tempRoot, entry.name);
      if (!(entry.isDirectory() || entry.isSymbolicLink()) || !isDirectory(candidate)) continue;
      if (!fs.existsSync(path.join(candidate, '.git'))) continue;
      const gitdir = resolveWorktreeGitDir(candidate);
      if (!gitdir.exists) continue;
      const canonicalGitDir = canonicalExistingPath(gitdir.path);
      if (!repoGitDirs.some(repoGitDir => isWithin(repoGitDir, canonicalGitDir))) continue;

      counters.tempStrays++;
      addFinding(findings, {
        kind: 'temp-stray-worktree',
        path: path.resolve(candidate),
        detail: { gitdir: canonicalGitDir },
      });
    }
  }
}

function scanJunkDirectories(
  roots: string[],
  findings: Map<string, Finding>,
  counters: JanitorCounters
): void {
  for (const root of roots) {
    if (!isDirectory(root)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(root, entry.name);
      if (!(entry.isDirectory() || entry.isSymbolicLink()) || !isDirectory(candidate)) continue;
      if (fs.existsSync(path.join(candidate, '.git'))) continue;
      let childNames: string[];
      try {
        childNames = fs.readdirSync(candidate);
      } catch {
        continue;
      }
      if (childNames.length === 0 || !childNames.every(name => BUILD_OUTPUT_NAMES.has(name))) continue;

      counters.junkDirs++;
      addFinding(findings, {
        kind: 'junk-dir',
        path: path.resolve(candidate),
        detail: { entries: childNames.sort() },
      });
    }
  }
}

/**
 * Acquire the same mkdir-based singleton lock used by redelivery. The returned
 * callback owns the lock and must be invoked in a finally block.
 */
export function acquireJanitorLock(options: JanitorTickOptions = {}): (() => void) | null {
  const lockPath = janitorLockPath(options);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    fs.mkdirSync(lockPath);
  } catch {
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs <= (options.lockStaleMs ?? JANITOR_LOCK_STALE_MS)) return null;
      fs.rmSync(lockPath, { recursive: true, force: true });
      fs.mkdirSync(lockPath);
    } catch {
      return null;
    }
  }
  try { fs.writeFileSync(path.join(lockPath, 'pid'), String(process.pid)); } catch {}
  return () => {
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
  };
}

function emptyCounters(): JanitorCounters {
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
  };
}

function persistTick(
  db: Database.Database,
  tickAt: string,
  counters: JanitorCounters,
  findings: Map<string, Finding>
): void {
  const upsertFinding = db.prepare(`
    INSERT INTO janitor_findings (first_seen_at, last_seen_at, kind, path, detail, state)
    VALUES (?, ?, ?, ?, ?, 'hold')
    ON CONFLICT(kind, path) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      detail = excluded.detail,
      state = 'hold'
  `);
  const heldRows = db.prepare("SELECT id, kind, path FROM janitor_findings WHERE state = 'hold'")
    .all() as Array<{ id: number; kind: string; path: string }>;
  const observed = new Set(findings.keys());
  const clearFinding = db.prepare("UPDATE janitor_findings SET state = 'cleared' WHERE id = ?");
  const countersJson = JSON.stringify(counters);

  db.transaction(() => {
    for (const finding of findings.values()) {
      upsertFinding.run(
        tickAt,
        tickAt,
        finding.kind,
        finding.path,
        JSON.stringify(finding.detail)
      );
    }
    for (const row of heldRows) {
      if (!observed.has(`${row.kind}\0${row.path}`) && !fs.existsSync(row.path)) {
        clearFinding.run(row.id);
      }
    }
    db.prepare(`
      INSERT INTO janitor_status (id, last_tick_at, last_duration_ms, counters)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_tick_at = excluded.last_tick_at,
        last_duration_ms = excluded.last_duration_ms,
        counters = excluded.counters
    `).run(tickAt, counters.tickMs, countersJson);
    db.prepare('INSERT INTO janitor_snapshots (tick_at, counters) VALUES (?, ?)')
      .run(tickAt, countersJson);
  })();
}

/** Recompute the complete observe-only census. No probe writes outside ~/.swarm. */
export function runJanitorTick(
  db: Database.Database,
  options: JanitorTickOptions = {}
): JanitorTickResult {
  const releaseLock = acquireJanitorLock(options);
  if (!releaseLock) return { ran: false, lockedOut: true };

  const started = performance.now();
  try {
    const tickAt = new Date(options.now ?? Date.now()).toISOString();
    const roots = loadOrSeedJanitorRoots(db, options);
    const repos = discoverRepositories(roots);
    const findings = new Map<string, Finding>();
    const counters = emptyCounters();

    scanRepositories(repos, findings, counters);
    scanTempWorktrees(options.tempScanPaths ?? defaultTempScanPaths(), repos, findings, counters);
    scanJunkDirectories(roots, findings, counters);
    counters.tickMs = Math.max(0, Math.round(performance.now() - started));
    persistTick(db, tickAt, counters, findings);
    return { ran: true, lockedOut: false, counters, findings: findings.size };
  } finally {
    releaseLock();
  }
}

function normalizeCounters(value: unknown): JanitorCounters {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const counters = emptyCounters();
  for (const key of Object.keys(counters) as Array<keyof JanitorCounters>) {
    const number = raw[key];
    if (typeof number === 'number' && Number.isFinite(number)) counters[key] = number;
  }
  return counters;
}

export function getJanitorStatus(db: Database.Database): JanitorStatus | null {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'janitor_status'").get();
  if (!table) return null;
  const row = db.prepare('SELECT last_tick_at, last_duration_ms, counters FROM janitor_status WHERE id = 1')
    .get() as { last_tick_at: string; last_duration_ms: number; counters: string } | undefined;
  if (!row) return null;
  let parsed: unknown = {};
  try { parsed = JSON.parse(row.counters); } catch {}
  return {
    lastTickAt: row.last_tick_at,
    lastDurationMs: row.last_duration_ms,
    counters: normalizeCounters(parsed),
  };
}

export function janitorTickAgeMinutes(status: JanitorStatus, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(status.lastTickAt).getTime()) / 60_000));
}

function debrisSummary(counters: JanitorCounters): string {
  const noun = (count: number, singular: string) => `${count} ${singular}${count === 1 ? '' : 's'}`;
  return `${noun(counters.worktrees, 'worktree')} (${counters.detachedHeads} detached), ` +
    `${counters.unpushedCommits} unpushed ${counters.unpushedCommits === 1 ? 'commit' : 'commits'}, ` +
    `${noun(counters.tempStrays, 'temp stray')}, ${noun(counters.junkDirs, 'junk dir')}`;
}

export function formatJanitorHookLine(status: JanitorStatus, now: number = Date.now()): string {
  const age = janitorTickAgeMinutes(status, now);
  const stale = now - new Date(status.lastTickAt).getTime() > JANITOR_HEARTBEAT_STALE_MS;
  return stale
    ? `JANITOR HEARTBEAT STALE (${age}m) — debris: ${debrisSummary(status.counters)}`
    : `janitor: tick ${age}m ago | debris: ${debrisSummary(status.counters)}`;
}

export function shouldSpawnJanitorTick(status: JanitorStatus | null, now: number = Date.now()): boolean {
  return !status || now - new Date(status.lastTickAt).getTime() > JANITOR_TICK_STALENESS_MS;
}

/** Fire-and-forget an observe-only janitor tick (no-op if spawn fails). */
export function spawnJanitorTick(): void {
  try {
    const child = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1], 'janitor', 'tick', '--observe'],
      { detached: true, stdio: 'ignore', env: process.env }
    );
    child.unref();
  } catch {}
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function builtEntrypoint(): string {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return path.join(repoRoot, 'dist', 'index.js');
}

export function janitorLaunchAgentPath(options: JanitorInstallOptions = {}): string {
  const directory = options.launchAgentsDir
    ?? path.join(options.homeDir ?? os.homedir(), 'Library', 'LaunchAgents');
  return path.join(directory, 'io.swarm.janitor.plist');
}

export function installJanitorLaunchAgent(options: JanitorInstallOptions = {}): string {
  const plistPath = janitorLaunchAgentPath(options);
  const programArguments = [
    options.nodePath ?? process.execPath,
    options.entrypointPath ?? builtEntrypoint(),
    'janitor',
    'tick',
    '--observe',
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.swarm.janitor</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map(argument => `    <string>${xmlEscape(argument)}</string>`).join('\n')}
  </array>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist, 'utf-8');
  return plistPath;
}

export function uninstallJanitorLaunchAgent(options: JanitorInstallOptions = {}): boolean {
  const plistPath = janitorLaunchAgentPath(options);
  if (!fs.existsSync(plistPath)) return false;
  const launchctl = options.launchctlCommand === undefined ? 'launchctl' : options.launchctlCommand;
  if (launchctl !== false) {
    try { execFileSync(launchctl, ['unload', plistPath], { stdio: 'ignore' }); } catch {}
  }
  fs.unlinkSync(plistPath);
  return true;
}
