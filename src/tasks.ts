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
export const RUN_SUMMARY_HEAD_LINES = 15;
export const RUN_SUMMARY_TAIL_LINES = 25;
export const DEPLOY_HEALTH_TIMEOUT_MS = 2_000;

export type TaskState = 'open' | 'active' | 'awaiting_review' | 'done' | 'abandoned';
export type TaskDisposition = 'pr' | 'merged' | 'archive' | 'discard';
export const CLAIM_KINDS = [
  'code-merged',
  'journey-works',
  'deploy-healthy',
  'analysis',
  'decision',
  'probe',
] as const;
export type ClaimKind = typeof CLAIM_KINDS[number];
export const EVIDENCE_KINDS = ['journey', 'deploy-health', 'report', 'decision'] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];
export type EvidenceVerification = boolean | number | 'unverified';

export interface CloseEvidence {
  kind: EvidenceKind | string;
  ref: string;
  verified: EvidenceVerification;
}

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
  claim_kind: ClaimKind | null;
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
  claimKind?: string;
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
  evidence?: string[];
  notEstablished?: string;
  outcome?: string;
  override?: boolean;
  reason?: string;
  deployHealthCheck?: DeployHealthCheck;
}

export type DeployHealthCheck = (url: string) => Promise<number | 'unverified'>;

export interface RunTaskCommandOptions {
  taskId?: string;
  cwd?: string;
}

export interface RunTaskCommandResult {
  task: Task;
  exitCode: number;
  logPath: string;
  durationMs: number;
  summary: string;
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

export function validateClaimKind(value: string): ClaimKind {
  if (!(CLAIM_KINDS as readonly string[]).includes(value)) {
    throw new Error(`Invalid --claim "${value}". Expected one of: ${CLAIM_KINDS.join(', ')}.`);
  }
  return value as ClaimKind;
}

export function effectiveClaimKind(task: Pick<Task, 'claim_kind'>): ClaimKind {
  return task.claim_kind ?? 'code-merged';
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
  const explicitClaimKind = options.claimKind === undefined
    ? undefined
    : validateClaimKind(options.claimKind);
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
    const claimKind: ClaimKind | null = explicitClaimKind !== undefined
      ? explicitClaimKind
      : current
        ? current.claim_kind
        : requestedRepo && !options.noWorktree
          ? 'code-merged'
          : 'analysis';

    if (current) {
      db.prepare(`
        UPDATE tasks
        SET title = ?, state = 'active', owner_agent = ?, lease_epoch = ?, lease_expires_at = ?,
            repo_path = ?, branch = ?, worktree_path = ?, transcript_hint = ?, disposition = NULL,
            claim_kind = ?, updated_at = ?
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
        claimKind,
        timestamp,
        swarmId,
        slug
      );
    } else {
      db.prepare(`
        INSERT INTO tasks (
          id, swarm_id, title, state, owner_agent, lease_epoch, lease_expires_at,
          repo_path, branch, worktree_path, transcript_hint, disposition, claim_kind, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
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
        claimKind,
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
      claim_kind: effectiveClaimKind(task),
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

const CLAIM_EVIDENCE_KINDS: Record<ClaimKind, readonly EvidenceKind[]> = {
  'code-merged': EVIDENCE_KINDS,
  'journey-works': ['journey'],
  'deploy-healthy': ['deploy-health'],
  analysis: ['report'],
  decision: ['decision', 'report'],
  probe: ['report'],
};

interface GateFailure {
  gate: string;
  message: string;
}

interface EvidenceReview {
  evidence: CloseEvidence[];
  failures: GateFailure[];
}

function expectedEvidenceMessage(task: Task, claimKind: ClaimKind, received?: string): string {
  const expected = CLAIM_EVIDENCE_KINDS[claimKind].join(', ');
  const receivedText = received ? `; received "${received}"` : '';
  return `Cannot close task "${task.id}": claim "${claimKind}" expects evidence kind(s): ${expected}${receivedText}. ` +
    `Pass ${CLAIM_EVIDENCE_KINDS[claimKind].map(kind => `--evidence ${kind}:<ref>`).join(' or ')}.`;
}

function parseEvidenceSpec(raw: string): { kind: string; ref: string } | null {
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) return null;
  const kind = raw.slice(0, separator).trim();
  const ref = raw.slice(separator + 1).trim();
  return kind && ref ? { kind, ref } : null;
}

function httpUrl(ref: string): boolean {
  try {
    const parsed = new URL(ref);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function fileFacts(ref: string): { exists: boolean; nonEmpty: boolean } {
  try {
    const stats = fs.statSync(ref);
    return { exists: stats.isFile(), nonEmpty: stats.isFile() && stats.size > 0 };
  } catch {
    return { exists: false, nonEmpty: false };
  }
}

export const defaultDeployHealthCheck: DeployHealthCheck = async (url: string) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEPLOY_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
    return response.status;
  } catch {
    return 'unverified';
  } finally {
    clearTimeout(timeout);
  }
};

async function reviewCloseEvidence(
  db: Database.Database,
  task: Task,
  claimKind: ClaimKind,
  rawEvidence: string[],
  outcome: string | undefined,
  deployHealthCheck: DeployHealthCheck
): Promise<EvidenceReview> {
  const evidence: CloseEvidence[] = [];
  const failures: GateFailure[] = [];
  const allowed = CLAIM_EVIDENCE_KINDS[claimKind];

  if (outcome !== undefined && outcome !== 'inconclusive') {
    failures.push({
      gate: 'evidence-outcome',
      message: 'Invalid --outcome. The only supported value is "inconclusive" for a probe claim.',
    });
  } else if (outcome === 'inconclusive' && claimKind !== 'probe') {
    failures.push({
      gate: 'evidence-outcome',
      message: `Cannot close task "${task.id}" with --outcome inconclusive: only claim "probe" accepts that outcome. ` +
        `Supply evidence for claim "${claimKind}" instead.`,
    });
  }

  for (const raw of rawEvidence) {
    const parsed = parseEvidenceSpec(raw);
    if (!parsed) {
      failures.push({
        gate: 'evidence-format',
        message: `Invalid --evidence "${raw}". Expected <kind>:<ref>; valid kinds for claim "${claimKind}": ${allowed.join(', ')}.`,
      });
      continue;
    }

    const item: CloseEvidence = { kind: parsed.kind, ref: parsed.ref, verified: false };
    evidence.push(item);
    if (!(EVIDENCE_KINDS as readonly string[]).includes(parsed.kind) || !allowed.includes(parsed.kind as EvidenceKind)) {
      failures.push({
        gate: 'evidence-kind',
        message: expectedEvidenceMessage(task, claimKind, parsed.kind),
      });
      continue;
    }

    const kind = parsed.kind as EvidenceKind;
    if (kind === 'journey') {
      if (httpUrl(parsed.ref)) {
        item.verified = 'unverified';
      } else {
        const facts = fileFacts(parsed.ref);
        if (facts.exists) {
          item.verified = true;
        } else {
          failures.push({
            gate: 'evidence-file',
            message: `Cannot close task "${task.id}": journey evidence file "${parsed.ref}" does not exist. ` +
              `Create the journey log/screenshot/recording, then retry with --evidence journey:${parsed.ref}.`,
          });
        }
      }
    } else if (kind === 'deploy-health') {
      if (httpUrl(parsed.ref)) {
        try {
          item.verified = await deployHealthCheck(parsed.ref);
        } catch {
          item.verified = 'unverified';
        }
      } else {
        const facts = fileFacts(parsed.ref);
        if (facts.exists) {
          item.verified = true;
        } else {
          failures.push({
            gate: 'evidence-file',
            message: `Cannot close task "${task.id}": deploy-health evidence file "${parsed.ref}" does not exist. ` +
              `Create the health-check log, then retry with --evidence deploy-health:${parsed.ref}.`,
          });
        }
      }
    } else if (kind === 'report') {
      const facts = fileFacts(parsed.ref);
      if (facts.nonEmpty) {
        item.verified = true;
      } else {
        failures.push({
          gate: 'evidence-file',
          message: `Cannot close task "${task.id}": report evidence file "${parsed.ref}" must exist and be non-empty. ` +
            `Write the report, then retry with --evidence report:${parsed.ref}.`,
        });
      }
    } else if (kind === 'decision') {
      const decisionId = /^\d+$/.test(parsed.ref) ? Number(parsed.ref) : 0;
      const row = decisionId > 0 && Number.isSafeInteger(decisionId)
        ? db.prepare('SELECT id FROM decisions WHERE id = ? AND swarm_id = ?').get(decisionId, task.swarm_id)
        : undefined;
      if (row) {
        item.verified = true;
      } else {
        failures.push({
          gate: 'evidence-decision',
          message: `Cannot close task "${task.id}": decision evidence id "${parsed.ref}" does not exist in this swarm. ` +
            `Record it with "swarm decision <text> --task ${task.id}", then retry with --evidence decision:<id>.`,
        });
      }
    }
  }

  const evidenceOptional = claimKind === 'code-merged' || (claimKind === 'probe' && outcome === 'inconclusive');
  if (rawEvidence.length === 0 && !evidenceOptional) {
    failures.unshift({
      gate: 'evidence-required',
      message: expectedEvidenceMessage(task, claimKind),
    });
  }
  return { evidence, failures };
}

function gitGateFailures(
  task: Task,
  facts: GitFacts,
  disposition: TaskDisposition,
  preservedArchive: boolean,
  forcedDiscard: boolean
): GateFailure[] {
  if (!task.repo_path) return [];
  const failures: GateFailure[] = [];
  if (!preservedArchive && !forcedDiscard &&
      (facts.unpushed.length > 0 || facts.dirtyTracked > 0 || facts.untracked > 0)) {
    if (facts.unpushed.length > 0) failures.push({ gate: 'git-unpushed', message: '' });
    if (facts.dirtyTracked > 0) failures.push({ gate: 'git-dirty-tracked', message: '' });
    if (facts.untracked > 0) failures.push({ gate: 'git-untracked', message: '' });
    failures[0].message =
      `Cannot close task "${task.id}": unpushed commits: ${facts.unpushed.length}, dirty tracked files: ${facts.dirtyTracked}, untracked files: ${facts.untracked}. ` +
      'Push and clean the branch, create a verified rescue then use --disposition archive, or use --disposition discard --force-discard.';
  }
  if (disposition === 'pr' || disposition === 'merged') {
    if (!task.branch || facts.head === 'unknown') {
      failures.push({
        gate: 'git-remote-reachability',
        message: `Cannot close task "${task.id}" as ${disposition}: no named branch tip is recorded. Start it with an attached repository and named task branch, then push it.`,
      });
    } else {
      const containing = tryGit(task.repo_path, ['branch', '-r', '--contains', facts.head]) ?? '';
      if (!containing.trim()) {
        failures.push({
          gate: 'git-remote-reachability',
          message: `Cannot close task "${task.id}" as ${disposition}: branch tip ${facts.head} is not reachable from any remote ref. Push it first.`,
        });
      }
    }
  }
  return failures;
}

export async function closeTask(
  db: Database.Database,
  swarmId: string,
  actor: string,
  slug: string,
  options: CloseTaskOptions
): Promise<Task> {
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
  const notEstablished = options.notEstablished?.trim();
  if (!notEstablished) {
    throw new Error(`Task close requires --not-established "<text>" for "${slug}" (use --not-established "none" when appropriate).`);
  }
  if (options.override && !options.reason?.trim()) {
    throw new Error(`--override for task "${slug}" requires --reason "<text>" so the bypass is auditable.`);
  }
  if (!options.override && options.reason !== undefined) {
    throw new Error('--reason requires --override.');
  }

  const authority = requireAuthority(db, swarmId, slug, actor, 'close');
  const task = authority.task;
  const claimKind = effectiveClaimKind(task);
  const evidenceReview = await reviewCloseEvidence(
    db,
    task,
    claimKind,
    options.evidence ?? [],
    options.outcome,
    options.deployHealthCheck ?? defaultDeployHealthCheck
  );
  const facts = taskGitFacts(task);
  const preservedArchive = options.disposition === 'archive' && hasVerifiedRescue(task);
  const forcedDiscard = options.disposition === 'discard' && options.forceDiscard === true;
  const gitFailures = gitGateFailures(task, facts, options.disposition, preservedArchive, forcedDiscard);
  const failures = [...evidenceReview.failures, ...gitFailures];
  if (!options.override && failures.length > 0) {
    throw new Error(failures.find(failure => failure.message)?.message ?? `Cannot close task "${slug}": a close gate failed.`);
  }

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
      if (preservedArchive || forcedDiscard || options.override) removeArgs.push('--force');
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
    for (const item of evidenceReview.evidence) {
      insertEvent(db, current, 'close_evidence', actor, item, timestamp);
    }
    if (options.override) {
      insertEvent(db, current, 'gate_override', actor, {
        reason: options.reason!.trim(),
        bypassed_gates: [...new Set(failures.map(failure => failure.gate))],
      }, timestamp);
    }
    db.prepare(`
      UPDATE tasks SET state = 'done', disposition = ?, lease_expires_at = NULL, updated_at = ?
      WHERE swarm_id = ? AND id = ?
    `).run(options.disposition, timestamp, swarmId, slug);
    const closeData: Record<string, unknown> = {
      disposition: options.disposition,
      claim_kind: claimKind,
      not_established: notEstablished,
    };
    if (options.outcome !== undefined) closeData.outcome = options.outcome;
    insertEvent(db, current, 'closed', actor, closeData, timestamp);
    return { task: getTask(db, swarmId, slug) };
  }).immediate() as { task?: Task | null; error?: string };

  if (result.error || !result.task) throw new Error(result.error ?? `Failed to close task "${slug}".`);
  return result.task;
}

function resolveRunTask(
  db: Database.Database,
  swarmId: string,
  taskId: string | undefined,
  cwd: string
): Task {
  if (taskId) {
    validateTaskSlug(taskId);
    const task = getTask(db, swarmId, taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found in this swarm. Run "swarm task list" and retry with --task <slug>.`);
    }
    return task;
  }

  const resolvedCwd = realOrResolved(cwd);
  const candidates = (db.prepare(`
    SELECT * FROM tasks
    WHERE swarm_id = ? AND worktree_path IS NOT NULL AND state <> 'done'
    ORDER BY LENGTH(worktree_path) DESC, id ASC
  `).all(swarmId) as Task[]).filter(task =>
    task.worktree_path !== null && isSameOrInside(resolvedCwd, realOrResolved(task.worktree_path))
  );
  if (candidates.length === 0) {
    throw new Error(`Cannot infer a task for "swarm run" from cwd "${cwd}". Pass --task <slug> or run from under a recorded task worktree.`);
  }
  const longest = candidates[0].worktree_path?.length ?? 0;
  const equallySpecific = candidates.filter(task => (task.worktree_path?.length ?? 0) === longest);
  if (equallySpecific.length > 1) {
    throw new Error(`Cannot infer a unique task for "swarm run" from cwd "${cwd}" (${equallySpecific.map(task => task.id).join(', ')}). Pass --task <slug>.`);
  }
  return candidates[0];
}

function nextRunLogPath(task: Task): string {
  const dir = path.join(swarmHome(), 'evidence', task.swarm_id, task.id);
  fs.mkdirSync(dir, { recursive: true });
  let maxSequence = 0;
  for (const entry of fs.readdirSync(dir)) {
    const match = /^run-(\d+)\.log$/.exec(entry);
    if (match) maxSequence = Math.max(maxSequence, Number(match[1]));
  }
  return path.join(dir, `run-${String(maxSequence + 1).padStart(3, '0')}.log`);
}

export function boundedRunSummary(output: string): string {
  const normalized = output.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.length === 0 ? [] : normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const limit = RUN_SUMMARY_HEAD_LINES + RUN_SUMMARY_TAIL_LINES;
  if (lines.length <= limit) return lines.join('\n');
  const omitted = lines.length - limit;
  return [
    ...lines.slice(0, RUN_SUMMARY_HEAD_LINES),
    `... [output truncated: ${omitted} line${omitted === 1 ? '' : 's'} omitted] ...`,
    ...lines.slice(-RUN_SUMMARY_TAIL_LINES),
  ].join('\n');
}

export function runTaskCommand(
  db: Database.Database,
  swarmId: string,
  actor: string,
  argv: string[],
  options: RunTaskCommandOptions = {}
): RunTaskCommandResult {
  if (argv.length === 0 || !argv[0]) {
    throw new Error('swarm run requires a command after --. Usage: swarm run [--task <slug>] -- <cmd> [args...]');
  }
  const invocationCwd = path.resolve(options.cwd ?? process.cwd());
  const task = resolveRunTask(db, swarmId, options.taskId, invocationCwd);
  const commandCwd = task.worktree_path ?? invocationCwd;
  if (task.worktree_path && !fs.existsSync(task.worktree_path)) {
    throw new Error(`Task "${task.id}" worktree does not exist at "${task.worktree_path}". Restore/restart the task worktree or run a no-worktree task with --task.`);
  }

  const logPath = nextRunLogPath(task);
  const logFd = fs.openSync(logPath, 'wx');
  const started = Date.now();
  let exitCode = 0;
  try {
    try {
      execFileSync(argv[0], argv.slice(1), {
        cwd: commandCwd,
        stdio: ['inherit', logFd, logFd],
      });
    } catch (error: unknown) {
      const failure = error as { status?: number | null; code?: string; signal?: string; message?: string };
      if (typeof failure.status === 'number') {
        exitCode = failure.status;
      } else {
        exitCode = failure.code === 'ENOENT' ? 127 : 126;
        fs.writeSync(logFd, `swarm run could not execute ${argv[0]}: ${failure.message ?? failure.code ?? failure.signal ?? 'unknown error'}\n`);
      }
    }
  } finally {
    fs.closeSync(logFd);
  }
  const durationMs = Math.max(0, Date.now() - started);
  insertEvent(db, task, 'run', actor, {
    argv0: argv[0],
    argsCount: argv.length - 1,
    exit: exitCode,
    logPath,
    durationMs,
  });
  const summary = boundedRunSummary(fs.readFileSync(logPath, 'utf-8'));
  return { task, exitCode, logPath, durationMs, summary };
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
