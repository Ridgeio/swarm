import { withImmediateTransaction, type SwarmDb } from './db.js';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { REPO_DIR } from './version.js';

const MODULE_ROOT = REPO_DIR;
const DEFAULT_CONTROLS_PATH = path.join(MODULE_ROOT, 'docs', 'controls.md');
const WORKER_REQUALIFICATION_RUNBOOK = 'docs/runbooks/requalify-worker.md';
const SWARM_VERSION_CACHE_KEY = 'swarm_version_check';

export const JANITOR_TICK_STALENESS_MS = 10 * 60 * 1000;
export const JANITOR_HEARTBEAT_STALE_MS = 30 * 60 * 1000;
export const JANITOR_LOCK_STALE_MS = 10 * 60 * 1000;
export const SWARM_VERSION_CACHE_STALE_MS = 6 * 60 * 60 * 1000;

export type SwarmVersionStatus = 'current' | 'update-available' | 'unknown';

export interface SwarmVersionCache {
  local_sha: string | null;
  remote_sha: string | null;
  checked_at: string;
  status: SwarmVersionStatus;
}

export interface SwarmVersionGitOptions {
  cwd: string;
  encoding: 'utf-8';
  timeout: number;
  env: NodeJS.ProcessEnv;
  stdio: ['ignore', 'pipe', 'pipe'];
}

export type SwarmVersionGitRunner = (
  binary: 'git',
  args: string[],
  options: SwarmVersionGitOptions
) => string | Buffer;

export interface SwarmVersionCheckOptions {
  now?: number;
  repoDir?: string;
  runner?: SwarmVersionGitRunner;
}

export interface JoinUpdateAwarenessOptions {
  now?: number;
  repoDir?: string;
  spawnTick?: () => void;
  print?: (line: string) => void;
}

export interface JoinUpdateAwarenessResult {
  banner: string | null;
  spawned: boolean;
}

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
  | 'junk-dir'
  | 'worker-epoch-change'
  | 'control-retest-due'
  | 'controls-file-invalid';

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
  /** Registry fixture override; production resolves docs/controls.md from the package root. */
  controlsFilePath?: string;
  /** Injectable read-only Git runner and repo path for the update-awareness step. */
  versionRunner?: SwarmVersionGitRunner;
  versionRepoDir?: string;
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
const CONTROL_HEADER = '| id | mechanism | guards-against | retest-by | retirement condition |';
const CONTROL_DIVIDER = '| --- | --- | --- | --- | --- |';
const CONTROL_ROW = /^\| ([a-z0-9]+(?:-[a-z0-9]+)*) \| ([^|\r\n]+) \| ([^|\r\n]+) \| (\d{4}-\d{2}-\d{2}) \| ([^|\r\n]+) \|$/;

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
  db: SwarmDb,
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

function validIsoDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function scanControls(
  controlsPath: string,
  today: string,
  findings: Map<string, Finding>
): void {
  if (!fs.existsSync(controlsPath)) return;

  let contents: string;
  try {
    contents = fs.readFileSync(controlsPath, 'utf-8');
  } catch {
    return;
  }

  const invalidLines: number[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.startsWith('|')) continue;
    if (line === CONTROL_HEADER || line === CONTROL_DIVIDER) continue;
    const match = CONTROL_ROW.exec(line);
    if (!match || !validIsoDate(match[4])) {
      invalidLines.push(index + 1);
      continue;
    }
    const [, id, , , retestBy] = match;
    if (retestBy < today) {
      addFinding(findings, {
        kind: 'control-retest-due',
        path: `control:${id}`,
        detail: { id, retest_by: retestBy },
      });
    }
  }

  if (invalidLines.length > 0) {
    addFinding(findings, {
      kind: 'controls-file-invalid',
      path: controlsPath,
      detail: { path: controlsPath, lines: invalidLines },
    });
  }
}

function scanWorkerEpochs(
  db: SwarmDb,
  findings: Map<string, Finding>,
  kvUpdates: Map<string, string>
): void {
  const rows = db.prepare(`
    SELECT id, host_agent, worker_version, joined_at
    FROM agents
    WHERE host_agent IS NOT NULL AND worker_version IS NOT NULL
    ORDER BY joined_at ASC, id ASC
  `).all() as Array<{
    id: string;
    host_agent: string;
    worker_version: string;
    joined_at: string;
  }>;
  const latest = new Map<string, string>();
  for (const row of rows) latest.set(row.host_agent, row.worker_version);

  const readPrior = db.prepare('SELECT value FROM janitor_kv WHERE key = ?');
  for (const [host, version] of latest) {
    const key = `worker-version:${host}`;
    const prior = readPrior.get(key) as { value: string } | undefined;
    if (prior && prior.value !== version) {
      addFinding(findings, {
        kind: 'worker-epoch-change',
        path: `worker:${host}`,
        detail: {
          host,
          from: prior.value,
          to: version,
          runbook: WORKER_REQUALIFICATION_RUNBOOK,
        },
      });
    }
    if (!prior || prior.value !== version) kvUpdates.set(key, version);
  }
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
  db: SwarmDb,
  tickAt: string,
  counters: JanitorCounters,
  findings: Map<string, Finding>,
  kvUpdates: Map<string, string>
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
  const upsertKv = db.prepare(`
    INSERT INTO janitor_kv (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);
  const countersJson = JSON.stringify(counters);

  withImmediateTransaction(db, () => {
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
      if (observed.has(`${row.kind}\0${row.path}`)) continue;
      if (row.kind === 'worker-epoch-change') continue;
      if (row.kind === 'control-retest-due' || row.kind === 'controls-file-invalid' || !fs.existsSync(row.path)) {
        clearFinding.run(row.id);
      }
    }
    for (const [key, value] of kvUpdates) upsertKv.run(key, value, tickAt);
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
  });
}

const defaultSwarmVersionGitRunner: SwarmVersionGitRunner = (binary, args, options) =>
  execFileSync(binary, args, options);

/**
 * Compare this checkout to origin/master without updating refs, FETCH_HEAD, or
 * any other repository state. The result is always cached, including failures.
 */
export function checkSwarmVersion(
  db: SwarmDb,
  options: SwarmVersionCheckOptions = {}
): SwarmVersionCache {
  const checkedAt = new Date(options.now ?? Date.now()).toISOString();
  const runner = options.runner ?? defaultSwarmVersionGitRunner;
  const run = (args: string[]): string => String(runner('git', args, {
    cwd: path.resolve(options.repoDir ?? REPO_DIR),
    encoding: 'utf-8',
    timeout: 5_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })).trim();

  let localSha: string | null = null;
  let remoteSha: string | null = null;
  let status: SwarmVersionStatus = 'unknown';
  try {
    localSha = run(['rev-parse', 'HEAD']);
    const remote = run(['ls-remote', 'origin', 'master']);
    remoteSha = remote.split(/\s+/, 1)[0] || null;
    if (!localSha || !remoteSha) throw new Error('missing local or remote SHA');
    status = localSha === remoteSha ? 'current' : 'update-available';
  } catch {
    status = 'unknown';
  }

  const cache: SwarmVersionCache = {
    local_sha: localSha,
    remote_sha: remoteSha,
    checked_at: checkedAt,
    status,
  };
  db.prepare(`
    INSERT INTO janitor_kv (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(SWARM_VERSION_CACHE_KEY, JSON.stringify(cache), checkedAt);
  return cache;
}

export function getSwarmVersionCache(db: SwarmDb): SwarmVersionCache | null {
  const row = db.prepare('SELECT value FROM janitor_kv WHERE key = ?')
    .get(SWARM_VERSION_CACHE_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<SwarmVersionCache>;
    if (
      (parsed.local_sha !== null && typeof parsed.local_sha !== 'string') ||
      (parsed.remote_sha !== null && typeof parsed.remote_sha !== 'string') ||
      typeof parsed.checked_at !== 'string' ||
      !['current', 'update-available', 'unknown'].includes(String(parsed.status))
    ) return null;
    return parsed as SwarmVersionCache;
  } catch {
    return null;
  }
}

export function formatSwarmUpdateBanner(
  cache: SwarmVersionCache | null,
  repoDir: string = REPO_DIR
): string | null {
  if (cache?.status !== 'update-available') return null;
  return `swarm update available — cd ${path.resolve(repoDir)} && git pull && npm install && npm run build`;
}

export function shouldRefreshSwarmVersion(
  cache: SwarmVersionCache | null,
  now: number = Date.now()
): boolean {
  if (!cache) return true;
  const checkedAt = new Date(cache.checked_at).getTime();
  return !Number.isFinite(checkedAt) || now - checkedAt > SWARM_VERSION_CACHE_STALE_MS;
}

/** Print cached update advice and asynchronously refresh absent/stale caches. */
export function handleJoinUpdateAwareness(
  db: SwarmDb,
  options: JoinUpdateAwarenessOptions = {}
): JoinUpdateAwarenessResult {
  const cache = getSwarmVersionCache(db);
  const banner = formatSwarmUpdateBanner(cache, options.repoDir ?? REPO_DIR);
  if (banner) (options.print ?? console.log)(banner);
  const spawned = shouldRefreshSwarmVersion(cache, options.now ?? Date.now());
  if (spawned) (options.spawnTick ?? spawnJanitorTick)();
  return { banner, spawned };
}

/** Recompute the complete observe-only census. No probe writes outside ~/.swarm. */
export function runJanitorTick(
  db: SwarmDb,
  options: JanitorTickOptions = {}
): JanitorTickResult {
  const releaseLock = acquireJanitorLock(options);
  if (!releaseLock) return { ran: false, lockedOut: true };

  const started = performance.now();
  try {
    const tickAt = new Date(options.now ?? Date.now()).toISOString();
    checkSwarmVersion(db, {
      now: options.now,
      repoDir: options.versionRepoDir,
      runner: options.versionRunner,
    });
    const roots = loadOrSeedJanitorRoots(db, options);
    const repos = discoverRepositories(roots);
    const findings = new Map<string, Finding>();
    const kvUpdates = new Map<string, string>();
    const counters = emptyCounters();

    scanWorkerEpochs(db, findings, kvUpdates);
    scanControls(
      options.controlsFilePath ?? DEFAULT_CONTROLS_PATH,
      tickAt.slice(0, 10),
      findings
    );
    scanRepositories(repos, findings, counters);
    scanTempWorktrees(options.tempScanPaths ?? defaultTempScanPaths(), repos, findings, counters);
    scanJunkDirectories(roots, findings, counters);
    counters.tickMs = Math.max(0, Math.round(performance.now() - started));
    persistTick(db, tickAt, counters, findings, kvUpdates);
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

export function getJanitorStatus(db: SwarmDb): JanitorStatus | null {
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
  // Node's test runner marks test workers with this internal context. Tests use
  // the injected spawn seam above; suppressing real detached children prevents
  // them from racing temporary-home cleanup after CLI integration assertions.
  if (process.env.NODE_TEST_CONTEXT || process.env.SWARM_TEST_DISABLE_BACKGROUND === '1') return;
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
  return path.join(MODULE_ROOT, 'dist', 'index.js');
}

export function janitorLaunchAgentPath(options: JanitorInstallOptions = {}): string {
  const directory = options.launchAgentsDir
    ?? path.join(options.homeDir ?? os.homedir(), 'Library', 'LaunchAgents');
  return path.join(directory, 'io.swarm.janitor.plist');
}

/**
 * A node path that survives `brew upgrade node`.
 *
 * `process.execPath` under Homebrew resolves to the VERSION-PINNED Cellar binary
 * (/opt/homebrew/Cellar/node/25.9.0_1/bin/node). Baking that into a LaunchAgent means the
 * job dies the next time node is upgraded — and dies SILENTLY: launchctl still lists it,
 * so registered-and-failing is indistinguishable from registered-and-working unless you
 * read the exit status column. Measured on this machine: the janitor sat at exit 78 for
 * an unknown period while its heartbeat-stale banner was printed to every agent and read
 * past by all of them.
 *
 * Prefer a stable alias that resolves to the SAME binary today and follows the upgrade.
 */
export function stableNodePath(
  execPath: string = process.execPath,
  deps: { existsSync?: (p: string) => boolean; realpathSync?: (p: string) => string } = {}
): string {
  const exists = deps.existsSync ?? fs.existsSync;
  const realpath = deps.realpathSync ?? fs.realpathSync;
  // Only rewrite version-pinned paths; anything else is already stable or deliberate.
  if (!execPath.includes('/Cellar/')) return execPath;

  let target: string;
  try { target = realpath(execPath); } catch { return execPath; }

  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/opt/homebrew/opt/node/bin/node']) {
    try {
      // Must resolve to the same binary NOW, or we would be pointing the job at a
      // different node than the one that installed it.
      if (exists(candidate) && realpath(candidate) === target) return candidate;
    } catch { /* try the next candidate */ }
  }
  // No stable alias found — keep the working path rather than inventing one.
  return execPath;
}

export function installJanitorLaunchAgent(options: JanitorInstallOptions = {}): string {
  const plistPath = janitorLaunchAgentPath(options);
  const programArguments = [
    options.nodePath ?? stableNodePath(),
    options.entrypointPath ?? builtEntrypoint(),
    'janitor',
    'tick',
    '--observe',
  ];
  // Without this the job can only fail silently: launchd discards stderr by default, so a
  // broken interpreter path leaves no trace anywhere. A job that cannot report its own
  // failure is not monitored, it is merely installed.
  const stderrPath = path.join(options.homeDir ?? os.homedir(), '.swarm', 'janitor-stderr.log');
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
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
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
