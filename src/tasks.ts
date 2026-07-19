import type Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectHost } from './hooks.js';
import { sendMessage } from './mailbox.js';
import { getAgent } from './registry.js';

export const TASK_LEASE_HOURS = 24;
export const HANDOFF_FRESH_MINUTES = 60;
export const CHECKPOINT_STALE_MINUTES = 90;

export type TaskState = 'open' | 'active' | 'awaiting_review' | 'done' | 'abandoned';
export type TaskDisposition = 'pr' | 'merged' | 'archive' | 'discard';

export interface Task {
  id: string;
  swarm_id: string;
  title: string;
  state: TaskState;
  owner_agent: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  repo_path: string | null;
  branch: string | null;
  worktree_path: string | null;
  transcript_hint: string | null;
  disposition: TaskDisposition | null;
  created_at: string;
  updated_at: string;
}

interface TaskEvent {
  id: number;
  swarm_id: string;
  task_id: string;
  epoch: number;
  kind: string;
  actor: string | null;
  data: string | null;
  created_at: string;
}

interface GitFacts {
  head: string;
  branch: string;
  dirtyTracked: number;
  untracked: number;
  unpushed: string[];
}

interface AuthorityCheck {
  task?: Task;
  epoch?: number;
  error?: string;
}

export interface StartTaskOptions {
  title?: string;
  repoPath?: string;
  noWorktree?: boolean;
  takeover?: boolean;
}

export interface StartTaskResult {
  task: Task;
  eventKind: 'started' | 'claimed';
  previousOwner: string | null;
}

export interface CheckpointResult {
  task: Task;
  path: string;
  sequence: number;
  recorded: boolean;
  exitCode: 0 | 2;
}

export interface CloseTaskOptions {
  disposition: TaskDisposition;
  forceDiscard?: boolean;
}

export interface HandoffResult {
  task: Task;
  briefPath: string;
  stale: boolean;
  message: string;
}

export interface DecisionResult {
  id: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function leaseExpiry(): string {
  return new Date(Date.now() + TASK_LEASE_HOURS * 60 * 60 * 1000).toISOString();
}

function swarmHome(): string {
  return path.join(os.homedir(), '.swarm');
}

function sameName(left: string | null, right: string): boolean {
  return left !== null && left.toLowerCase() === right.toLowerCase();
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return runGit(cwd, args);
  } catch {
    return null;
  }
}

function realOrResolved(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isSameOrInside(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function validateAgentPathSegment(agent: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(agent) || agent === '.' || agent === '..') {
    throw new Error(`Agent name "${agent}" cannot be used in the canonical task branch/worktree path. Use only letters, numbers, dot, underscore, or hyphen.`);
  }
}

export function validateTaskSlug(slug: string): void {
  if (!/^[a-z0-9-]{3,64}$/.test(slug)) {
    throw new Error(`Invalid task slug "${slug}". Use 3-64 lowercase letters, digits, or hyphens.`);
  }
}

export function getTask(db: Database.Database, swarmId: string, slug: string): Task | null {
  return db.prepare('SELECT * FROM tasks WHERE swarm_id = ? AND id = ?')
    .get(swarmId, slug) as Task | undefined ?? null;
}

function transcriptHint(): string {
  try {
    const host = detectHost() ?? 'unknown';
    const cwd = process.cwd();
    let sessionDir: string | null = null;
    if (host === 'claude-code') {
      const cwdSlug = cwd.replace(/\//g, '-');
      const candidate = path.join(os.homedir(), '.claude', 'projects', cwdSlug);
      if (fs.existsSync(candidate)) sessionDir = candidate;
    } else if (host === 'codex') {
      const candidate = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
      if (fs.existsSync(candidate)) sessionDir = candidate;
    } else if (host === 'grok') {
      const candidate = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
      if (fs.existsSync(candidate)) sessionDir = candidate;
    }
    return [`host=${host}`, `cwd=${cwd}`, sessionDir ? `sessions=${sessionDir}` : null].filter(Boolean).join('; ');
  } catch {
    return `host=unknown; cwd=${process.cwd()}`;
  }
}

function assertRepoWorktreeAllowed(db: Database.Database, repoPath: string): string {
  const repo = realOrResolved(repoPath);
  const blockedRoots = ['/private/tmp', process.env.TMPDIR].filter((value): value is string => !!value)
    .map(realOrResolved);
  for (const blocked of blockedRoots) {
    if (isSameOrInside(repo, blocked)) {
      throw new Error(`Refusing task worktree creation from temporary repository "${repo}". Move the repository outside /private/tmp and $TMPDIR, or use --no-worktree.`);
    }
  }

  const roots = db.prepare('SELECT root_path FROM swarms WHERE root_path IS NOT NULL').all() as Array<{ root_path: string }>;
  for (const row of roots) {
    if (repo === realOrResolved(row.root_path)) {
      throw new Error(`Refusing task worktree creation from registered swarm workspace root "${repo}". Use the repository's durable source clone or --no-worktree.`);
    }
  }

  const topLevel = runGit(repo, ['rev-parse', '--show-toplevel']);
  return realOrResolved(topLevel);
}

function prepareTaskWorktree(
  db: Database.Database,
  actor: string,
  slug: string,
  repoPath: string
): { repoPath: string; branch: string; worktreePath: string } {
  validateAgentPathSegment(actor);
  const repo = assertRepoWorktreeAllowed(db, repoPath);
  const branch = `swarm/${actor}/${slug}`;
  runGit(repo, ['check-ref-format', '--branch', branch]);

  const worktreePath = path.join(swarmHome(), 'wt', path.basename(repo), `${actor}--${slug}`);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  if (fs.existsSync(worktreePath)) {
    const existingTop = tryGit(worktreePath, ['rev-parse', '--show-toplevel']);
    const existingBranch = tryGit(worktreePath, ['branch', '--show-current']);
    if (existingTop && realOrResolved(existingTop) === realOrResolved(worktreePath) && existingBranch === branch) {
      return { repoPath: repo, branch, worktreePath };
    }
    throw new Error(`Canonical task worktree path already exists and is not ${branch}: ${worktreePath}`);
  }

  const branchExists = tryGit(repo, ['show-ref', '--verify', `refs/heads/${branch}`]) !== null;
  if (branchExists) {
    runGit(repo, ['worktree', 'add', '--force', worktreePath, branch]);
  } else {
    runGit(repo, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
  }
  return { repoPath: repo, branch, worktreePath };
}

function insertEvent(
  db: Database.Database,
  task: Pick<Task, 'swarm_id' | 'id' | 'lease_epoch'>,
  kind: string,
  actor: string | null,
  data: unknown,
  createdAt: string = nowIso()
): number {
  const result = db.prepare(`
    INSERT INTO task_events (swarm_id, task_id, epoch, kind, actor, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(task.swarm_id, task.id, task.lease_epoch, kind, actor, data === null ? null : JSON.stringify(data), createdAt);
  return Number(result.lastInsertRowid);
}

function latestActorEpoch(db: Database.Database, task: Task, actor: string): number | null {
  const row = db.prepare(`
    SELECT epoch FROM task_events
    WHERE swarm_id = ? AND task_id = ? AND actor = ? COLLATE NOCASE
      AND kind IN ('started', 'claimed')
    ORDER BY id DESC LIMIT 1
  `).get(task.swarm_id, task.id, actor) as { epoch: number } | undefined;
  return row?.epoch ?? null;
}

function staleAuthorityMessage(task: Task, actor: string, verb: string, presentedEpoch: number | null): string {
  const owner = task.owner_agent ?? 'nobody';
  const action = sameName(task.owner_agent, actor)
    ? `Run "swarm task start ${task.id}" to refresh your lease before retrying.`
    : `Run "swarm task start ${task.id} --takeover" to claim it before retrying.`;
  return `Refused stale task authority for "${task.id}" (${verb}): owner is "${owner}" at lease epoch ${task.lease_epoch}, but ${actor} holds ${presentedEpoch === null ? 'no task epoch' : `epoch ${presentedEpoch}`}. ${action}`;
}

function checkAuthority(
  db: Database.Database,
  swarmId: string,
  slug: string,
  actor: string,
  verb: string,
  expectedEpoch?: number
): AuthorityCheck {
  return db.transaction(() => {
    const task = getTask(db, swarmId, slug);
    if (!task) return { error: `Task "${slug}" not found in this swarm.` };
    const presentedEpoch = expectedEpoch ?? latestActorEpoch(db, task, actor);
    if (!sameName(task.owner_agent, actor) || presentedEpoch !== task.lease_epoch) {
      insertEvent(db, task, 'refused_stale_epoch', actor, {
        verb,
        owner_agent: task.owner_agent,
        current_epoch: task.lease_epoch,
        presented_epoch: presentedEpoch,
      });
      return { error: staleAuthorityMessage(task, actor, verb, presentedEpoch) };
    }
    return { task, epoch: task.lease_epoch };
  }).immediate() as AuthorityCheck;
}

function requireAuthority(
  db: Database.Database,
  swarmId: string,
  slug: string,
  actor: string,
  verb: string,
  expectedEpoch?: number
): { task: Task; epoch: number } {
  const checked = checkAuthority(db, swarmId, slug, actor, verb, expectedEpoch);
  if (checked.error || !checked.task || checked.epoch === undefined) {
    throw new Error(checked.error ?? `Task "${slug}" authority check failed.`);
  }
  return { task: checked.task, epoch: checked.epoch };
}

export async function startTask(
  db: Database.Database,
  swarmId: string,
  actor: string,
  slug: string,
  options: StartTaskOptions
): Promise<StartTaskResult> {
  validateTaskSlug(slug);
  const prior = getTask(db, swarmId, slug);
  if (!prior && !options.title?.trim()) {
    throw new Error(`Task "${slug}" is new; --title <text> is required.`);
  }
  if (prior && ['done', 'abandoned'].includes(prior.state)) {
    throw new Error(`Task "${slug}" is ${prior.state} and cannot be started again.`);
  }
  if (prior?.owner_agent && !sameName(prior.owner_agent, actor) && prior.state === 'active' && !options.takeover) {
    throw new Error(`Task "${slug}" is active and owned by "${prior.owner_agent}" at lease epoch ${prior.lease_epoch}. Re-run with --takeover to claim it.`);
  }

  const requestedRepo = options.repoPath ?? prior?.repo_path ?? undefined;
  let worktree: { repoPath: string; branch: string; worktreePath: string } | null = null;
  if (requestedRepo && !options.noWorktree) {
    worktree = prepareTaskWorktree(db, actor, slug, requestedRepo);
  }

  const result = db.transaction(() => {
    const current = getTask(db, swarmId, slug);
    if (current && ['done', 'abandoned'].includes(current.state)) {
      throw new Error(`Task "${slug}" is ${current.state} and cannot be started again.`);
    }
    if (current?.owner_agent && !sameName(current.owner_agent, actor) && current.state === 'active' && !options.takeover) {
      throw new Error(`Task "${slug}" is active and owned by "${current.owner_agent}" at lease epoch ${current.lease_epoch}. Re-run with --takeover to claim it.`);
    }

    const previousOwner = current?.owner_agent ?? null;
    const claimed = !!current && !!previousOwner && !sameName(previousOwner, actor);
    const eventKind: 'started' | 'claimed' = claimed ? 'claimed' : 'started';
    const epoch = (current?.lease_epoch ?? 0) + 1;
    const timestamp = nowIso();
    const title = options.title?.trim() || current?.title;
    if (!title) throw new Error(`Task "${slug}" requires --title <text>.`);

    if (current) {
      db.prepare(`
        UPDATE tasks
        SET title = ?, state = 'active', owner_agent = ?, lease_epoch = ?, lease_expires_at = ?,
            repo_path = ?, branch = ?, worktree_path = ?, transcript_hint = ?, disposition = NULL,
            updated_at = ?
        WHERE swarm_id = ? AND id = ?
      `).run(
        title,
        actor,
        epoch,
        leaseExpiry(),
        worktree?.repoPath ?? (options.repoPath ? path.resolve(options.repoPath) : current.repo_path),
        worktree?.branch ?? current.branch,
        worktree?.worktreePath ?? current.worktree_path,
        transcriptHint(),
        timestamp,
        swarmId,
        slug
      );
    } else {
      db.prepare(`
        INSERT INTO tasks (
          id, swarm_id, title, state, owner_agent, lease_epoch, lease_expires_at,
          repo_path, branch, worktree_path, transcript_hint, disposition, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        slug,
        swarmId,
        title,
        actor,
        epoch,
        leaseExpiry(),
        worktree?.repoPath ?? (options.repoPath ? path.resolve(options.repoPath) : null),
        worktree?.branch ?? null,
        worktree?.worktreePath ?? null,
        transcriptHint(),
        timestamp,
        timestamp
      );
    }

    const task = getTask(db, swarmId, slug);
    if (!task) throw new Error(`Failed to start task "${slug}".`);
    insertEvent(db, task, eventKind, actor, {
      previous_owner: previousOwner,
      repo_path: task.repo_path,
      branch: task.branch,
      worktree_path: task.worktree_path,
    }, timestamp);
    return { task, eventKind, previousOwner };
  }).immediate() as StartTaskResult;

  if (result.eventKind === 'claimed' && result.previousOwner) {
    await sendMessage(
      db,
      swarmId,
      actor,
      result.previousOwner,
      `Task ${slug} was claimed by ${actor} at lease epoch ${result.task.lease_epoch}. Your prior task authority is fenced; inspect the ledger before continuing.`,
      undefined,
      'handoff'
    );
  }
  return result;
}

function taskGitFacts(task: Task): GitFacts {
  if (!task.repo_path) {
    return { head: 'unknown', branch: task.branch ?? 'unknown', dirtyTracked: 0, untracked: 0, unpushed: [] };
  }
  const cwd = task.worktree_path && fs.existsSync(task.worktree_path) ? task.worktree_path : task.repo_path;
  const head = tryGit(cwd, ['rev-parse', 'HEAD']) ?? 'unknown';
  const branch = tryGit(cwd, ['branch', '--show-current']) || task.branch || 'detached';
  const status = tryGit(cwd, ['status', '--porcelain']) ?? '';
  const lines = status ? status.split('\n').filter(Boolean) : [];
  const untracked = lines.filter(line => line.startsWith('??')).length;
  const dirtyTracked = lines.length - untracked;
  const log = task.branch ? tryGit(task.repo_path, ['log', task.branch, '--not', '--remotes', '--oneline']) : '';
  const unpushed = log ? log.split('\n').filter(Boolean) : [];
  return { head, branch, dirtyTracked, untracked, unpushed };
}

function checkpointDir(task: Task): string {
  return path.join(swarmHome(), 'briefs', 'checkpoints', task.swarm_id, task.id);
}

function checkpointSkeleton(task: Task, sequence: number, facts: GitFacts, notes?: string): string {
  const number = String(sequence).padStart(3, '0');
  const decisions = notes ?? '<FILL>';
  const other = notes === undefined ? '<FILL>' : '- none noted';
  return `# checkpoint ${task.id} #${number}
- state: ${task.state}; owner ${task.owner_agent ?? 'unowned'}; lease epoch ${task.lease_epoch}
- head: ${facts.head} on ${facts.branch} (dirty: ${facts.dirtyTracked}, untracked: ${facts.untracked})
## decisions (+why, +rejected alternatives)
${decisions}
## failed approaches (do-not-repeat)
${other}
## next action
${other}
## blockers / landmines
${other}
`;
}

function recordedCheckpointPaths(db: Database.Database, task: Task): Set<string> {
  const rows = db.prepare(`
    SELECT data FROM task_events
    WHERE swarm_id = ? AND task_id = ? AND kind = 'checkpoint'
  `).all(task.swarm_id, task.id) as Array<{ data: string | null }>;
  const paths = new Set<string>();
  for (const row of rows) {
    if (!row.data) continue;
    try {
      const parsed = JSON.parse(row.data) as { path?: string };
      if (parsed.path) paths.add(parsed.path);
    } catch { /* old or malformed event data is ignored */ }
  }
  return paths;
}

function existingCheckpointFiles(dir: string): Array<{ sequence: number; path: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(name => {
      const match = /^(\d{3,})\.md$/.exec(name);
      return match ? { sequence: Number(match[1]), path: path.join(dir, name) } : null;
    })
    .filter((entry): entry is { sequence: number; path: string } => entry !== null)
    .sort((left, right) => left.sequence - right.sequence);
}

export function checkpointTask(
  db: Database.Database,
  swarmId: string,
  actor: string,
  slug: string,
  notes?: string
): CheckpointResult {
  validateTaskSlug(slug);
  const authority = requireAuthority(db, swarmId, slug, actor, 'checkpoint');
  const task = authority.task;
  const dir = checkpointDir(task);
  fs.mkdirSync(dir, { recursive: true });

  const files = existingCheckpointFiles(dir);
  const recorded = recordedCheckpointPaths(db, task);
  const pending = [...files].reverse().find(entry => !recorded.has(entry.path));
  const sequence = pending?.sequence ?? ((files.at(-1)?.sequence ?? 0) + 1);
  const checkpointPath = pending?.path ?? path.join(dir, `${String(sequence).padStart(3, '0')}.md`);

  if (notes !== undefined) {
    fs.writeFileSync(checkpointPath, checkpointSkeleton(task, sequence, taskGitFacts(task), notes), 'utf-8');
  } else if (!fs.existsSync(checkpointPath)) {
    fs.writeFileSync(checkpointPath, checkpointSkeleton(task, sequence, taskGitFacts(task)), 'utf-8');
  }

  const contents = fs.readFileSync(checkpointPath, 'utf-8');
  if (contents.includes('<FILL>')) {
    return { task, path: checkpointPath, sequence, recorded: false, exitCode: 2 };
  }

  const committed = checkAuthority(db, swarmId, slug, actor, 'checkpoint', authority.epoch);
  if (committed.error || !committed.task) throw new Error(committed.error ?? `Task "${slug}" authority changed.`);
  const timestamp = nowIso();
  const updatedTask = db.transaction(() => {
    const checked = getTask(db, swarmId, slug);
    if (!checked || !sameName(checked.owner_agent, actor) || checked.lease_epoch !== authority.epoch) {
      if (checked) {
        insertEvent(db, checked, 'refused_stale_epoch', actor, {
          verb: 'checkpoint',
          owner_agent: checked.owner_agent,
          current_epoch: checked.lease_epoch,
          presented_epoch: authority.epoch,
        });
        return { error: staleAuthorityMessage(checked, actor, 'checkpoint', authority.epoch) };
      }
      return { error: `Task "${slug}" not found in this swarm.` };
    }
    db.prepare('UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE swarm_id = ? AND id = ?')
      .run(leaseExpiry(), timestamp, swarmId, slug);
    insertEvent(db, checked, 'checkpoint', actor, { path: checkpointPath, sequence }, timestamp);
    return { task: getTask(db, swarmId, slug) };
  }).immediate() as { task?: Task | null; error?: string };
  if (updatedTask.error || !updatedTask.task) throw new Error(updatedTask.error ?? `Failed to record checkpoint for "${slug}".`);
  return { task: updatedTask.task, path: checkpointPath, sequence, recorded: true, exitCode: 0 };
}

function hasVerifiedRescue(task: Task): boolean {
  const root = path.join(swarmHome(), 'archive', 'rescue');
  if (!fs.existsSync(root)) return false;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(root, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
        verified?: boolean;
        attribution?: { swarm_id?: string; task_id?: string };
      };
      if (manifest.verified && manifest.attribution?.swarm_id === task.swarm_id && manifest.attribution.task_id === task.id) {
        return true;
      }
    } catch { /* invalid manifests are not preservation evidence */ }
  }
  return false;
}

function assertRemoteReachability(task: Task, facts: GitFacts, disposition: TaskDisposition): void {
  if (disposition !== 'pr' && disposition !== 'merged') return;
  if (!task.repo_path || !task.branch || facts.head === 'unknown') {
    throw new Error(`Cannot close task "${task.id}" as ${disposition}: no named branch tip is recorded.`);
  }
  const containing = tryGit(task.repo_path, ['branch', '-r', '--contains', facts.head]) ?? '';
  if (!containing.trim()) {
    throw new Error(`Cannot close task "${task.id}" as ${disposition}: branch tip ${facts.head} is not reachable from any remote ref. Push it first.`);
  }
}

export function closeTask(
  db: Database.Database,
  swarmId: string,
  actor: string,
  slug: string,
  options: CloseTaskOptions
): Task {
  validateTaskSlug(slug);
  if (!['pr', 'merged', 'archive', 'discard'].includes(options.disposition)) {
    throw new Error('Invalid disposition. Use pr, merged, archive, or discard.');
  }
  if (options.forceDiscard && options.disposition !== 'discard') {
    throw new Error('--force-discard requires --disposition discard.');
  }
  if (options.disposition === 'discard' && !options.forceDiscard) {
    throw new Error('Discard requires both --disposition discard and --force-discard.');
  }

  const authority = requireAuthority(db, swarmId, slug, actor, 'close');
  const task = authority.task;
  const facts = taskGitFacts(task);
  const preservedArchive = options.disposition === 'archive' && hasVerifiedRescue(task);
  const forcedDiscard = options.disposition === 'discard' && options.forceDiscard === true;
  if ((facts.unpushed.length > 0 || facts.dirtyTracked > 0 || facts.untracked > 0) && !preservedArchive && !forcedDiscard) {
    throw new Error(
      `Cannot close task "${slug}": unpushed commits: ${facts.unpushed.length}, dirty tracked files: ${facts.dirtyTracked}, untracked files: ${facts.untracked}. Push and clean the branch, create a verified rescue then use --disposition archive, or use --disposition discard --force-discard.`
    );
  }
  assertRemoteReachability(task, facts, options.disposition);

  const result = db.transaction(() => {
    const current = getTask(db, swarmId, slug);
    if (!current || !sameName(current.owner_agent, actor) || current.lease_epoch !== authority.epoch) {
      if (current) {
        insertEvent(db, current, 'refused_stale_epoch', actor, {
          verb: 'close',
          owner_agent: current.owner_agent,
          current_epoch: current.lease_epoch,
          presented_epoch: authority.epoch,
        });
        return { error: staleAuthorityMessage(current, actor, 'close', authority.epoch) };
      }
      return { error: `Task "${slug}" not found in this swarm.` };
    }

    if (current.worktree_path && fs.existsSync(current.worktree_path) && current.repo_path) {
      const removeArgs = ['worktree', 'remove'];
      if (preservedArchive || forcedDiscard) removeArgs.push('--force');
      removeArgs.push(current.worktree_path);
      runGit(current.repo_path, removeArgs);
    }

    const timestamp = nowIso();
    if (forcedDiscard) {
      insertEvent(db, current, 'force_discard', actor, {
        unpushed: facts.unpushed.length,
        dirty_tracked: facts.dirtyTracked,
        untracked: facts.untracked,
      }, timestamp);
    }
    db.prepare(`
      UPDATE tasks SET state = 'done', disposition = ?, lease_expires_at = NULL, updated_at = ?
      WHERE swarm_id = ? AND id = ?
    `).run(options.disposition, timestamp, swarmId, slug);
    insertEvent(db, current, 'closed', actor, { disposition: options.disposition }, timestamp);
    return { task: getTask(db, swarmId, slug) };
  }).immediate() as { task?: Task | null; error?: string };

  if (result.error || !result.task) throw new Error(result.error ?? `Failed to close task "${slug}".`);
  return result.task;
}

function latestCheckpoint(db: Database.Database, task: Task): { event: TaskEvent; path: string } | null {
  const event = db.prepare(`
    SELECT * FROM task_events
    WHERE swarm_id = ? AND task_id = ? AND kind = 'checkpoint'
    ORDER BY id DESC LIMIT 1
  `).get(task.swarm_id, task.id) as TaskEvent | undefined;
  if (!event?.data) return null;
  try {
    const data = JSON.parse(event.data) as { path?: string };
    return data.path ? { event, path: data.path } : null;
  } catch {
    return null;
  }
}

function minuteStamp(date: Date): string {
  const digits = date.toISOString().replace(/[-:]/g, '');
  return `${digits.slice(0, 8)}-${digits.slice(9, 13)}`;
}

export async function handoffTask(
  db: Database.Database,
  swarmId: string,
  actor: string,
  slug: string,
  targetName: string,
  staleOk: boolean = false
): Promise<HandoffResult> {
  validateTaskSlug(slug);
  const target = getAgent(db, swarmId, targetName);
  if (!target) throw new Error(`Agent "${targetName}" not found in this swarm.`);
  if (sameName(target.name, actor)) throw new Error('Cannot hand a task off to yourself.');

  const authority = requireAuthority(db, swarmId, slug, actor, 'handoff');
  const task = authority.task;
  const checkpoint = latestCheckpoint(db, task);
  if (!checkpoint || !fs.existsSync(checkpoint.path)) {
    throw new Error(`Task "${slug}" has no readable checkpoint. Run "swarm task checkpoint ${slug}" before handoff.`);
  }
  const ageMinutes = Math.floor((Date.now() - new Date(checkpoint.event.created_at).getTime()) / 60_000);
  const stale = ageMinutes > HANDOFF_FRESH_MINUTES;
  if (stale && !staleOk) {
    throw new Error(`Task "${slug}" checkpoint is ${ageMinutes}m old; handoff requires one within ${HANDOFF_FRESH_MINUTES}m. Checkpoint now or re-run with --stale-ok.`);
  }

  const facts = taskGitFacts(task);
  const title = `${stale ? 'STALE ' : ''}${task.title.replace(/[\r\n]+/g, ' ')}`;
  const checkpointBody = fs.readFileSync(checkpoint.path, 'utf-8');
  const briefDir = path.join(swarmHome(), 'briefs', 'handoffs');
  fs.mkdirSync(briefDir, { recursive: true });
  const briefPath = path.join(briefDir, `${slug}--${minuteStamp(new Date())}.md`);
  const brief = `# ${title}

## task facts
- slug: ${task.id}
- state: ${task.state}
- owner: ${task.owner_agent ?? 'unowned'}
- lease epoch before handoff: ${task.lease_epoch}
- repo: ${task.repo_path ?? 'none'}
- branch: ${task.branch ?? 'none'}
- worktree: ${task.worktree_path ?? 'none'}
- checkpoint age: ${ageMinutes}m

## unpushed branch inventory
${facts.unpushed.length ? facts.unpushed.map(line => `- ${line}`).join('\n') : '- none'}

## transcript hint
${task.transcript_hint ?? 'not available'}

## latest checkpoint (verbatim)
${checkpointBody}`;
  fs.writeFileSync(briefPath, brief, 'utf-8');

  const transferred = db.transaction(() => {
    const current = getTask(db, swarmId, slug);
    if (!current || !sameName(current.owner_agent, actor) || current.lease_epoch !== authority.epoch) {
      if (current) {
        insertEvent(db, current, 'refused_stale_epoch', actor, {
          verb: 'handoff',
          owner_agent: current.owner_agent,
          current_epoch: current.lease_epoch,
          presented_epoch: authority.epoch,
        });
        return { error: staleAuthorityMessage(current, actor, 'handoff', authority.epoch) };
      }
      return { error: `Task "${slug}" not found in this swarm.` };
    }
    const nextEpoch = current.lease_epoch + 1;
    const timestamp = nowIso();
    db.prepare(`
      UPDATE tasks SET owner_agent = ?, lease_epoch = ?, lease_expires_at = ?, updated_at = ?
      WHERE swarm_id = ? AND id = ?
    `).run(target.name, nextEpoch, leaseExpiry(), timestamp, swarmId, slug);
    const next = getTask(db, swarmId, slug);
    if (!next) return { error: `Failed to transfer task "${slug}".` };
    insertEvent(db, next, 'handoff', actor, {
      to: target.name,
      brief_path: briefPath,
      stale,
      checkpoint_age_minutes: ageMinutes,
    }, timestamp);
    return { task: next };
  }).immediate() as { task?: Task; error?: string };
  if (transferred.error || !transferred.task) throw new Error(transferred.error ?? `Failed to hand off task "${slug}".`);

  const body = `Handoff ${slug}: ${briefPath.replace(/[\r\n]+/g, ' ')} — ${title}`;
  const delivery = await sendMessage(db, swarmId, actor, target.name, body, undefined, 'handoff');
  if (!delivery.delivered && !delivery.queued) {
    throw new Error(`Task authority transferred, but handoff pointer delivery failed: ${delivery.message}`);
  }
  return { task: transferred.task, briefPath, stale, message: delivery.message };
}

export function recordDecision(
  db: Database.Database,
  swarmId: string,
  actor: string,
  body: string,
  taskId?: string,
  supersedes?: number
): DecisionResult {
  const text = body.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Decision text cannot be empty.');
  if (taskId) {
    validateTaskSlug(taskId);
    if (!getTask(db, swarmId, taskId)) throw new Error(`Task "${taskId}" not found in this swarm.`);
  }
  return db.transaction(() => {
    if (supersedes !== undefined) {
      const previous = db.prepare('SELECT id FROM decisions WHERE id = ? AND swarm_id = ?')
        .get(supersedes, swarmId);
      if (!previous) throw new Error(`Decision #${supersedes} does not exist in this swarm.`);
    }
    const createdAt = nowIso();
    const result = db.prepare(`
      INSERT INTO decisions (swarm_id, task_id, body, made_by, supersedes, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?)
    `).run(swarmId, taskId ?? null, text, actor, supersedes ?? null, createdAt);
    if (supersedes !== undefined) {
      db.prepare("UPDATE decisions SET status = 'superseded' WHERE id = ? AND swarm_id = ?")
        .run(supersedes, swarmId);
    }
    return { id: Number(result.lastInsertRowid) };
  }).immediate() as DecisionResult;
}

function firstNextAction(contents: string): string | null {
  const lines = contents.split(/\r?\n/);
  const heading = lines.findIndex(line => line.trim() === '## next action');
  if (heading === -1) return null;
  for (let index = heading + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith('## ')) break;
    if (line) return line;
  }
  return null;
}

export function getActiveTaskHookLines(
  db: Database.Database,
  swarmId: string,
  actor: string,
  at: Date = new Date()
): string[] {
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE swarm_id = ? AND owner_agent = ? COLLATE NOCASE AND state = 'active'
    ORDER BY updated_at ASC, id ASC
  `).all(swarmId, actor) as Task[];

  const lines: string[] = [];
  for (const task of tasks) {
    const checkpoint = latestCheckpoint(db, task);
    if (!checkpoint || !fs.existsSync(checkpoint.path)) {
      lines.push(`Your task: ${task.id} [${task.state}] — no checkpoint yet — swarm task checkpoint ${task.id}`);
      continue;
    }
    let next: string | null = null;
    try {
      next = firstNextAction(fs.readFileSync(checkpoint.path, 'utf-8'));
    } catch {
      lines.push(`Your task: ${task.id} [${task.state}] — no checkpoint yet — swarm task checkpoint ${task.id}`);
      continue;
    }
    const age = Math.max(0, Math.floor((at.getTime() - new Date(checkpoint.event.created_at).getTime()) / 60_000));
    const nag = age > CHECKPOINT_STALE_MINUTES
      ? ` (stale — swarm task checkpoint ${task.id})`
      : '';
    lines.push(`Your task: ${task.id} [${task.state}] — last checkpoint ${age}m ago${nag}; next: ${next ?? '(not recorded)'}`);
  }
  return lines;
}
