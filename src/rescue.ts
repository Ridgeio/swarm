import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getTask, type Task } from './tasks.js';

export interface RescueAttribution {
  swarm_id: string | null;
  task_id: string | null;
  agent: string;
}

export interface RescueFileChecksum {
  path: string;
  sha256: string | null;
  size: number | null;
  kind: 'file' | 'symlink' | 'directory' | 'missing';
}

export interface RescueArtifactChecksum {
  sha256: string;
  size: number;
}

export interface RescueManifest {
  version: 1;
  worktree_path: string;
  repo_path: string;
  branch: string | null;
  rescue_branch: string | null;
  head_sha: string;
  status_porcelain: string;
  artifacts: Record<string, RescueArtifactChecksum>;
  source_files: RescueFileChecksum[];
  local_unreachable_branches: string[];
  counts: {
    staged: number;
    unstaged: number;
    dirty_tracked: number;
    untracked: number;
  };
  created_at: string;
  attribution: RescueAttribution;
  verified: boolean;
  verified_at: string | null;
  verification_error: string | null;
}

export interface RescueTargetOptions {
  worktree?: string;
  taskId?: string;
  agent?: string;
}

export interface RescueResult {
  artifactDir: string;
  manifest: RescueManifest;
}

interface RescueTarget {
  worktreePath: string;
  task: Task | null;
  agent: string;
}

const ARTIFACT_FILES = ['repo.bundle', 'staged.patch', 'unstaged.patch', 'untracked.tar.gz'] as const;

function swarmHome(): string {
  return path.join(os.homedir(), '.swarm');
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function runGitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return runGit(cwd, args);
  } catch {
    return null;
  }
}

function sha256Buffer(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function artifactChecksum(filePath: string): RescueArtifactChecksum {
  const contents = fs.readFileSync(filePath);
  return { sha256: sha256Buffer(contents), size: contents.length };
}

function zeroSeparated(buffer: Buffer): string[] {
  const value = buffer.toString('utf-8');
  if (!value) return [];
  return value.split('\0').filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function safeRefComponent(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'unknown';
}

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function minuteStamp(date: Date): string {
  const digits = date.toISOString().replace(/[-:]/g, '');
  return digits.slice(0, 13).replace('T', '');
}

function canonical(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function repositoryPath(worktreePath: string, task: Task | null): string {
  if (task?.repo_path) return canonical(task.repo_path);
  const commonDir = runGit(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (path.basename(commonDir) === '.git') return canonical(path.dirname(commonDir));
  return canonical(runGit(worktreePath, ['rev-parse', '--show-toplevel']));
}

function sourceChecksum(root: string, relativePath: string): RescueFileChecksum {
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing checksum path outside worktree: ${relativePath}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return { path: relativePath, sha256: null, size: null, kind: 'missing' };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(absolute);
    return { path: relativePath, sha256: sha256Buffer(`symlink:${target}`), size: Buffer.byteLength(target), kind: 'symlink' };
  }
  if (stat.isDirectory()) {
    return { path: relativePath, sha256: sha256Buffer('directory'), size: 0, kind: 'directory' };
  }
  const contents = fs.readFileSync(absolute);
  return { path: relativePath, sha256: sha256Buffer(contents), size: contents.length, kind: 'file' };
}

function statusLines(status: string): string[] {
  return status ? status.split('\n').filter(Boolean) : [];
}

function changedSourcePaths(worktreePath: string, untracked: string[]): string[] {
  const staged = zeroSeparated(runGitBuffer(worktreePath, ['diff', '--cached', '--name-only', '-z']));
  const unstaged = zeroSeparated(runGitBuffer(worktreePath, ['diff', '--name-only', '-z']));
  return unique([...staged, ...unstaged, ...untracked]);
}

function localUnreachableRefs(worktreePath: string): Array<{ ref: string; sha: string }> {
  const output = runGit(worktreePath, ['for-each-ref', '--format=%(refname)\t%(objectname)', 'refs/heads']);
  if (!output) return [];
  const refs: Array<{ ref: string; sha: string }> = [];
  for (const line of output.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const ref = line.slice(0, tab);
    const sha = line.slice(tab + 1);
    const remoteContains = tryGit(worktreePath, ['branch', '-r', '--contains', sha]) ?? '';
    if (!remoteContains.trim()) refs.push({ ref, sha });
  }
  return refs;
}

function createDetachedRescueBranch(
  worktreePath: string,
  agent: string,
  slug: string,
  head: string,
  createdAt: Date
): string {
  const branch = `rescue/${safeRefComponent(agent)}/${safeRefComponent(slug)}-${dateStamp(createdAt)}`;
  const existing = tryGit(worktreePath, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  if (existing && existing !== head) {
    throw new Error(`Detached-HEAD rescue branch ${branch} already exists at a different commit.`);
  }
  if (!existing) runGit(worktreePath, ['branch', branch, head]);
  return branch;
}

function manifestPath(artifactDir: string): string {
  return path.join(artifactDir, 'manifest.json');
}

function writeManifest(artifactDir: string, manifest: RescueManifest): void {
  fs.writeFileSync(manifestPath(artifactDir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

function resolveTargets(
  db: Database.Database,
  swarmId: string,
  options: RescueTargetOptions
): RescueTarget[] {
  const supplied = [options.worktree, options.taskId, options.agent].filter(value => value !== undefined);
  if (supplied.length !== 1) {
    throw new Error('Choose exactly one rescue target: --worktree <path>, --task <slug>, or --agent <name>.');
  }

  if (options.taskId) {
    const task = getTask(db, swarmId, options.taskId);
    if (!task) throw new Error(`Task "${options.taskId}" not found in this swarm.`);
    if (!task.worktree_path) throw new Error(`Task "${options.taskId}" has no recorded worktree.`);
    return [{ worktreePath: canonical(task.worktree_path), task, agent: task.owner_agent ?? 'unknown' }];
  }

  if (options.agent) {
    const tasks = db.prepare(`
      SELECT * FROM tasks
      WHERE swarm_id = ? AND owner_agent = ? COLLATE NOCASE AND worktree_path IS NOT NULL
      ORDER BY updated_at ASC, id ASC
    `).all(swarmId, options.agent) as Task[];
    if (tasks.length === 0) throw new Error(`Agent "${options.agent}" has no recorded task worktrees in this swarm.`);
    const seen = new Set<string>();
    return tasks.flatMap(task => {
      const worktreePath = canonical(task.worktree_path!);
      if (seen.has(worktreePath)) return [];
      seen.add(worktreePath);
      return [{ worktreePath, task, agent: task.owner_agent ?? options.agent! }];
    });
  }

  const worktreePath = canonical(options.worktree!);
  const tasks = db.prepare('SELECT * FROM tasks WHERE swarm_id = ? AND worktree_path IS NOT NULL')
    .all(swarmId) as Task[];
  const task = tasks.find(row => canonical(row.worktree_path!) === worktreePath) ?? null;
  return [{ worktreePath, task, agent: task?.owner_agent ?? 'unknown' }];
}

function assertArtifactChecksums(artifactDir: string, manifest: RescueManifest): void {
  for (const name of ARTIFACT_FILES) {
    const expected = manifest.artifacts[name];
    if (!expected) throw new Error(`manifest checksum missing for ${name}`);
    const filePath = path.join(artifactDir, name);
    if (!fs.existsSync(filePath)) throw new Error(`${name} is missing`);
    const actual = artifactChecksum(filePath);
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw new Error(`${name} checksum mismatch`);
    }
  }
}

export function restoreRescueArtifact(artifactDir: string, destination: string): void {
  const manifest = JSON.parse(fs.readFileSync(manifestPath(artifactDir), 'utf-8')) as RescueManifest;
  execFileSync('git', ['bundle', 'verify', path.join(artifactDir, 'repo.bundle')], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('git', ['clone', '--no-checkout', path.join(artifactDir, 'repo.bundle'), destination], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runGit(destination, ['checkout', '--detach', manifest.head_sha]);

  const stagedPatch = path.join(artifactDir, 'staged.patch');
  if (fs.statSync(stagedPatch).size > 0) runGit(destination, ['apply', '--index', stagedPatch]);
  const unstagedPatch = path.join(artifactDir, 'unstaged.patch');
  if (fs.statSync(unstagedPatch).size > 0) runGit(destination, ['apply', unstagedPatch]);
  execFileSync('tar', ['-xzf', path.join(artifactDir, 'untracked.tar.gz'), '-C', destination], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function verifyRescueArtifact(artifactDir: string): RescueManifest {
  const file = manifestPath(artifactDir);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf-8')) as RescueManifest;
  let restoreDir: string | null = null;
  try {
    assertArtifactChecksums(artifactDir, manifest);
    restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rescue-verify-'));
    const restored = path.join(restoreDir, 'restore');
    restoreRescueArtifact(artifactDir, restored);

    const restoredStatus = runGit(restored, ['status', '--porcelain']);
    if (restoredStatus !== manifest.status_porcelain) {
      throw new Error('git status --porcelain mismatch');
    }
    for (const expected of manifest.source_files) {
      const actual = sourceChecksum(restored, expected.path);
      if (actual.sha256 !== expected.sha256 || actual.size !== expected.size || actual.kind !== expected.kind) {
        throw new Error(`restored checksum mismatch for ${expected.path}`);
      }
    }

    manifest.verified = true;
    manifest.verified_at = new Date().toISOString();
    manifest.verification_error = null;
    writeManifest(artifactDir, manifest);
    return manifest;
  } catch (error: any) {
    const reason = error?.message || String(error);
    manifest.verified = false;
    manifest.verified_at = null;
    manifest.verification_error = reason;
    writeManifest(artifactDir, manifest);
    throw new Error(`Rescue verification failed: ${reason}. Manifest: ${file}`);
  } finally {
    if (restoreDir) fs.rmSync(restoreDir, { recursive: true, force: true });
  }
}

function rescueOne(target: RescueTarget): RescueResult {
  const worktree = canonical(target.worktreePath);
  const sourceStatus = runGit(worktree, ['status', '--porcelain']);
  const head = runGit(worktree, ['rev-parse', 'HEAD']);
  const originalBranch = runGit(worktree, ['branch', '--show-current']) || null;
  const untrackedBuffer = runGitBuffer(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
  const untracked = zeroSeparated(untrackedBuffer);
  const files = changedSourcePaths(worktree, untracked).map(relativePath => sourceChecksum(worktree, relativePath));
  const created = new Date();
  const slug = target.task?.id ?? path.basename(worktree);
  const rescueBranch = originalBranch
    ? null
    : createDetachedRescueBranch(worktree, target.agent, slug, head, created);
  const repo = repositoryPath(worktree, target.task);

  const artifactRoot = path.join(swarmHome(), 'archive', 'rescue');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const artifactDir = path.join(artifactRoot, `${path.basename(worktree)}-${minuteStamp(created)}`);
  if (fs.existsSync(artifactDir)) {
    throw new Error(`Rescue artifact directory already exists for this minute: ${artifactDir}`);
  }
  fs.mkdirSync(artifactDir);

  const unreachable = localUnreachableRefs(worktree);
  const bundleArgs = ['bundle', 'create', path.join(artifactDir, 'repo.bundle'), 'HEAD', ...unreachable.map(row => row.ref)];
  runGit(worktree, bundleArgs);

  fs.writeFileSync(path.join(artifactDir, 'staged.patch'), runGitBuffer(worktree, ['diff', '--cached', '--binary']));
  fs.writeFileSync(path.join(artifactDir, 'unstaged.patch'), runGitBuffer(worktree, ['diff', '--binary']));
  execFileSync('tar', ['-czf', path.join(artifactDir, 'untracked.tar.gz'), '--null', '-T', '-'], {
    cwd: worktree,
    input: untrackedBuffer,
    encoding: 'buffer',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lines = statusLines(sourceStatus);
  const staged = lines.filter(line => line[0] !== ' ' && line[0] !== '?').length;
  const unstaged = lines.filter(line => line[1] !== ' ' && line[1] !== '?').length;
  const dirtyTracked = lines.filter(line => !line.startsWith('??')).length;
  const artifacts: Record<string, RescueArtifactChecksum> = {};
  for (const name of ARTIFACT_FILES) artifacts[name] = artifactChecksum(path.join(artifactDir, name));

  const manifest: RescueManifest = {
    version: 1,
    worktree_path: worktree,
    repo_path: repo,
    branch: originalBranch,
    rescue_branch: rescueBranch,
    head_sha: head,
    status_porcelain: sourceStatus,
    artifacts,
    source_files: files,
    local_unreachable_branches: unreachable.map(row => row.ref.replace(/^refs\/heads\//, '')),
    counts: { staged, unstaged, dirty_tracked: dirtyTracked, untracked: untracked.length },
    created_at: created.toISOString(),
    attribution: {
      swarm_id: target.task?.swarm_id ?? null,
      task_id: target.task?.id ?? null,
      agent: target.agent,
    },
    verified: false,
    verified_at: null,
    verification_error: null,
  };
  writeManifest(artifactDir, manifest);

  try {
    const verified = verifyRescueArtifact(artifactDir);
    const afterHead = runGit(worktree, ['rev-parse', 'HEAD']);
    const afterStatus = runGit(worktree, ['status', '--porcelain']);
    const sourceChecksumsMatch = files.every(expected => {
      const actual = sourceChecksum(worktree, expected.path);
      return actual.sha256 === expected.sha256 && actual.size === expected.size && actual.kind === expected.kind;
    });
    if (afterHead !== head || afterStatus !== sourceStatus || !sourceChecksumsMatch) {
      verified.verified = false;
      verified.verified_at = null;
      verified.verification_error = 'source worktree changed during rescue';
      writeManifest(artifactDir, verified);
      throw new Error(`Rescue verification failed: source worktree changed during rescue. Manifest: ${manifestPath(artifactDir)}`);
    }
    return { artifactDir, manifest: verified };
  } catch (error) {
    throw error;
  }
}

export function rescueTargets(
  db: Database.Database,
  swarmId: string,
  options: RescueTargetOptions
): RescueResult[] {
  return resolveTargets(db, swarmId, options).map(rescueOne);
}

export function listRescueArtifacts(): Array<{ artifactDir: string; manifest: RescueManifest | null; error?: string }> {
  const root = path.join(swarmHome(), 'archive', 'rescue');
  if (!fs.existsSync(root)) return [];
  const rows = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const artifactDir = path.join(root, entry.name);
      try {
        return {
          artifactDir,
          manifest: JSON.parse(fs.readFileSync(manifestPath(artifactDir), 'utf-8')) as RescueManifest,
        };
      } catch (error: any) {
        return { artifactDir, manifest: null, error: error?.message || String(error) };
      }
    });
  return rows.sort((left, right) => {
    const leftDate = left.manifest?.created_at ?? '';
    const rightDate = right.manifest?.created_at ?? '';
    return rightDate.localeCompare(leftDate);
  });
}
