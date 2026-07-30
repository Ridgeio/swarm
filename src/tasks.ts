import { withImmediateTransaction, type SwarmDb } from './db.js';
import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectHost } from './hooks.js';
import { sendMessage } from './mailbox.js';
import { getAgent } from './registry.js';
import { findLiveGrant, parseGrantTtl, recordGrantUsed, type Grant } from './grants.js';

export const TASK_LEASE_HOURS = 24;
export const HANDOFF_FRESH_MINUTES = 60;
export const HANDOFF_OFFER_DEFAULT_TTL = '15m';
export const HANDOFF_OFFER_MAX_TTL_MS = 24 * 60 * 60 * 1000;
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

export interface GitFacts {
  head: string;
  branch: string;
  dirtyTracked: number;
  untracked: number;
  unpushed: string[];
}

export interface DefaultBranchTarget {
  ref: string;
  sha: string;
  resolution: 'origin-head' | 'remote-head' | 'main' | 'master';
}

export interface MergedVerification {
  sourceSha: string;
  targetRef: string;
  targetSha: string;
}

export interface CloseTaskResult extends Task {
  close_verification?: MergedVerification;
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

export interface ReopenTaskOptions {
  reason: string;
  takeover?: boolean;
}

export interface ReopenTaskResult {
  task: Task;
  previousOwner: string | null;
  priorDisposition: TaskDisposition | null;
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

export type HandoffOfferStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'expired'
  | 'invalidated';

export type HandoffPickupStatus =
  | 'queued'
  | 'pushed-unconfirmed'
  | 'pending'
  | 'injected'
  | 'acked'
  | 'not-recorded';

export interface HandoffOffer {
  id: number;
  swarm_id: string;
  task_id: string;
  from_agent: string;
  to_agent: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  source_epoch: number;
  brief_path: string;
  charter_sha256: string;
  status: HandoffOfferStatus;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  message_id: number | null;
  accepted_epoch: number | null;
}

export interface HandoffOfferView extends HandoffOffer {
  pickup_status: HandoffPickupStatus;
  first_injected_at: string | null;
  acked_at: string | null;
}

export interface OfferTaskHandoffOptions {
  staleOk?: boolean;
  ttl?: string;
  now?: number;
}

export interface HandoffOfferResult {
  offer: HandoffOffer;
  task: Task;
  briefPath: string;
  stale: boolean;
  message: string;
}

export interface HandoffOfferResolutionResult {
  offer: HandoffOffer;
  task: Task;
  message: string;
}

export interface ResolveHandoffOfferOptions {
  offerId?: number;
  reason?: string;
  now?: number;
}

export interface HandoffSweepResult {
  expired: HandoffOffer[];
  invalidated: HandoffOffer[];
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

export type GitQueryRunner = (cwd: string, args: string[]) => string | null;

function normalizeRemoteTrackingRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (trimmed.startsWith('refs/remotes/')) return trimmed.slice('refs/remotes/'.length);
  if (trimmed.startsWith('refs/heads/')) return `origin/${trimmed.slice('refs/heads/'.length)}`;
  if (trimmed.startsWith('origin/')) return trimmed;
  return null;
}

function resolveLocalTarget(
  repoPath: string,
  ref: string,
  resolution: DefaultBranchTarget['resolution'],
  git: GitQueryRunner
): DefaultBranchTarget | null {
  const sha = git(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`])?.trim();
  return sha ? { ref, sha, resolution } : null;
}

/** Resolve origin's default branch without guessing until both HEAD mechanisms fail. */
export function resolveDefaultBranchTarget(
  repoPath: string,
  git: GitQueryRunner = tryGit
): DefaultBranchTarget | null {
  const localHead = git(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  const localHeadRef = localHead ? normalizeRemoteTrackingRef(localHead) : null;
  if (localHeadRef) {
    const target = resolveLocalTarget(repoPath, localHeadRef, 'origin-head', git);
    if (target) return target;
  }

  const remoteHead = git(repoPath, ['ls-remote', '--symref', 'origin', 'HEAD']);
  const remoteSymref = remoteHead
    ?.split('\n')
    .map(line => /^ref:\s+(refs\/heads\/[^\s]+)\s+HEAD$/.exec(line.trim()))
    .find((match): match is RegExpExecArray => match !== null)?.[1];
  const remoteHeadRef = remoteSymref ? normalizeRemoteTrackingRef(remoteSymref) : null;
  if (remoteHeadRef) {
    const target = resolveLocalTarget(repoPath, remoteHeadRef, 'remote-head', git);
    if (target) return target;
  }

  return resolveLocalTarget(repoPath, 'origin/main', 'main', git)
    ?? resolveLocalTarget(repoPath, 'origin/master', 'master', git);
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

export function getTask(db: SwarmDb, swarmId: string, slug: string): Task | null {
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

function assertRepoWorktreeAllowed(db: SwarmDb, repoPath: string): string {
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
  db: SwarmDb,
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
  db: SwarmDb,
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

function latestActorEpoch(db: SwarmDb, task: Task, actor: string): number | null {
  const row = db.prepare(`
    SELECT epoch FROM task_events
    WHERE swarm_id = ? AND task_id = ? AND actor = ? COLLATE NOCASE
      AND kind IN ('started', 'claimed', 'reopened', 'handoff_accepted')
    ORDER BY id DESC LIMIT 1
  `).get(task.swarm_id, task.id, actor) as { epoch: number } | undefined;
  return row?.epoch ?? null;
}

function staleAuthorityMessage(task: Task, actor: string, verb: string, presentedEpoch: number | null): string {
  const owner = task.owner_agent ?? 'nobody';
  const action = verb === 'reopen'
    ? `Re-run "swarm task reopen ${task.id} --reason \"<text>\" --takeover" to claim a fresh epoch before retrying.`
    : sameName(task.owner_agent, actor)
      ? `Run "swarm task start ${task.id}" to refresh your lease before retrying.`
      : `Run "swarm task start ${task.id} --takeover" to claim it before retrying.`;
  return `Refused stale task authority for "${task.id}" (${verb}): owner is "${owner}" at lease epoch ${task.lease_epoch}, but ${actor} holds ${presentedEpoch === null ? 'no task epoch' : `epoch ${presentedEpoch}`}. ${action}`;
}

function checkAuthority(
  db: SwarmDb,
  swarmId: string,
  slug: string,
  actor: string,
  verb: string,
  expectedEpoch?: number
): AuthorityCheck {
  return withImmediateTransaction(db, () => {
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
  }) as AuthorityCheck;
}

export function requireTaskAuthority(
  db: SwarmDb,
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
  db: SwarmDb,
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

  const result = withImmediateTransaction(db, () => {
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
  }) as StartTaskResult;

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

export async function reopenTask(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  slug: string,
  options: ReopenTaskOptions
): Promise<ReopenTaskResult> {
  validateTaskSlug(slug);
  const reason = options.reason?.trim();
  if (!reason) throw new Error(`Task reopen requires --reason "<text>" for "${slug}".`);

  const prior = getTask(db, swarmId, slug);
  if (!prior) throw new Error(`Task "${slug}" not found in this swarm.`);
  if (!['done', 'abandoned'].includes(prior.state)) {
    throw new Error(`Task "${slug}" is ${prior.state}; reopen only accepts done or abandoned tasks.`);
  }
  if (!options.takeover) requireTaskAuthority(db, swarmId, slug, actor, 'reopen');

  const result = withImmediateTransaction(db, () => {
    const current = getTask(db, swarmId, slug);
    if (!current) return { error: `Task "${slug}" not found in this swarm.` };
    if (!['done', 'abandoned'].includes(current.state)) {
      return { error: `Task "${slug}" is ${current.state}; reopen only accepts done or abandoned tasks.` };
    }

    if (!options.takeover) {
      const presentedEpoch = latestActorEpoch(db, current, actor);
      if (!sameName(current.owner_agent, actor) || presentedEpoch !== current.lease_epoch) {
        insertEvent(db, current, 'refused_stale_epoch', actor, {
          verb: 'reopen',
          owner_agent: current.owner_agent,
          current_epoch: current.lease_epoch,
          presented_epoch: presentedEpoch,
        });
        return { error: staleAuthorityMessage(current, actor, 'reopen', presentedEpoch) };
      }
    }

    const previousOwner = current.owner_agent;
    const priorDisposition = current.disposition;
    const timestamp = nowIso();
    db.prepare(`
      UPDATE tasks
      SET state = 'active', owner_agent = ?, lease_epoch = ?, lease_expires_at = ?,
          disposition = NULL, updated_at = ?
      WHERE swarm_id = ? AND id = ?
    `).run(actor, current.lease_epoch + 1, leaseExpiry(), timestamp, swarmId, slug);
    const reopened = getTask(db, swarmId, slug);
    if (!reopened) return { error: `Failed to reopen task "${slug}".` };
    insertEvent(db, reopened, 'reopened', actor, {
      reason,
      prior_disposition: priorDisposition,
      previous_owner: previousOwner,
      takeover: options.takeover === true,
    }, timestamp);
    return { task: reopened, previousOwner, priorDisposition };
  }) as ReopenTaskResult & { error?: string };

  if (result.error || !result.task) throw new Error(result.error ?? `Failed to reopen task "${slug}".`);
  if (options.takeover && result.previousOwner && !sameName(result.previousOwner, actor)) {
    await sendMessage(
      db,
      swarmId,
      actor,
      result.previousOwner,
      `Task ${slug} was reopened and taken over by ${actor} at lease epoch ${result.task.lease_epoch}. Your prior task authority is fenced; inspect the ledger before continuing.`,
      undefined,
      'handoff'
    );
  }
  return result;
}

export function taskGitFacts(task: Task): GitFacts {
  if (!task.repo_path) {
    return { head: 'unknown', branch: task.branch ?? 'unknown', dirtyTracked: 0, untracked: 0, unpushed: [] };
  }
  const hasTaskWorktree = !!task.worktree_path && fs.existsSync(task.worktree_path);
  const cwd = hasTaskWorktree ? task.worktree_path! : task.repo_path;
  // A reopened historical close may point at a worktree that was already
  // removed. The durable task branch remains the source of truth; using the
  // operator checkout's HEAD here could falsely verify an unrelated default-
  // branch commit as the task commit.
  const headRef = hasTaskWorktree ? 'HEAD' : task.branch ?? 'HEAD';
  const head = tryGit(cwd, ['rev-parse', headRef]) ?? 'unknown';
  const branch = hasTaskWorktree
    ? tryGit(cwd, ['branch', '--show-current']) || task.branch || 'detached'
    : task.branch || tryGit(cwd, ['branch', '--show-current']) || 'detached';
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

function recordedCheckpointPaths(db: SwarmDb, task: Task): Set<string> {
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
  db: SwarmDb,
  swarmId: string,
  actor: string,
  slug: string,
  notes?: string
): CheckpointResult {
  validateTaskSlug(slug);
  const authority = requireTaskAuthority(db, swarmId, slug, actor, 'checkpoint');
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
  const updatedTask = withImmediateTransaction(db, () => {
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
  }) as { task?: Task | null; error?: string };
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

export const CLAIM_EVIDENCE_KINDS: Record<ClaimKind, readonly EvidenceKind[]> = {
  'code-merged': EVIDENCE_KINDS,
  'journey-works': ['journey'],
  'deploy-healthy': ['deploy-health'],
  analysis: ['report'],
  decision: ['decision', 'report'],
  probe: ['report'],
};

export function claimCloseRequirements(claimKind: ClaimKind): string {
  // code-merged accepts optional typed evidence, but its required close proof is
  // the Git gate set. Every evidence-bearing claim renders from the same map the
  // close validator consumes, so help/output cannot drift from enforcement.
  return claimKind === 'code-merged'
    ? 'git gates only'
    : CLAIM_EVIDENCE_KINDS[claimKind].join(', ');
}

interface GateFailure {
  gate: string;
  message: string;
}

interface GitGateReview {
  failures: GateFailure[];
  mergedVerification?: MergedVerification;
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
  db: SwarmDb,
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

function reviewGitGates(
  task: Task,
  facts: GitFacts,
  claimKind: ClaimKind,
  disposition: TaskDisposition,
  preservedArchive: boolean,
  forcedDiscard: boolean
): GitGateReview {
  if (!task.repo_path) return { failures: [] };
  const failures: GateFailure[] = [];
  let mergedVerification: MergedVerification | undefined;
  if (!preservedArchive && !forcedDiscard &&
      (facts.unpushed.length > 0 || facts.dirtyTracked > 0 || facts.untracked > 0)) {
    if (facts.unpushed.length > 0) failures.push({ gate: 'git-unpushed', message: '' });
    if (facts.dirtyTracked > 0) failures.push({ gate: 'git-dirty-tracked', message: '' });
    if (facts.untracked > 0) failures.push({ gate: 'git-untracked', message: '' });
    failures[0].message =
      `Cannot close task "${task.id}": unpushed commits: ${facts.unpushed.length}, dirty tracked files: ${facts.dirtyTracked}, untracked files: ${facts.untracked}. ` +
      'Push and clean the branch, create a verified rescue then use --disposition archive, or use --disposition discard --force-discard.';
  }
  if (claimKind === 'code-merged' && disposition === 'merged') {
    if (!task.branch || facts.head === 'unknown') {
      failures.push({
        gate: 'git-default-branch-reachability',
        message: `Cannot close task "${task.id}" as merged: no named source commit is recorded. Start it with an attached repository and named task branch, then merge it through the default branch.`,
      });
    } else {
      const target = resolveDefaultBranchTarget(task.repo_path);
      if (!target) {
        failures.push({
          gate: 'git-default-branch-reachability',
          message: `Cannot close task "${task.id}" as merged: source SHA ${facts.head}; default target ref and target SHA could not be resolved. ` +
            'Set origin/HEAD or fetch origin/main or origin/master, then retry.',
        });
      } else if (tryGit(task.repo_path, ['merge-base', '--is-ancestor', facts.head, target.sha]) === null) {
        failures.push({
          gate: 'git-default-branch-reachability',
          message: `Cannot close task "${task.id}" as merged: source SHA ${facts.head}; target ref ${target.ref}; target SHA ${target.sha}. ` +
            `The commit is not on the target branch. Merge and push it to ${target.ref}, then retry.`,
        });
      } else {
        mergedVerification = {
          sourceSha: facts.head,
          targetRef: target.ref,
          targetSha: target.sha,
        };
      }
    }
  } else if (disposition === 'pr' || disposition === 'merged') {
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
  return { failures, mergedVerification };
}

function closeGrantCommand(op: 'merge' | 'override', slug: string): string {
  return `swarm grant create --op ${op} --resource ${slug} --ttl 2h`;
}

function missingCloseGrantMessage(
  task: Task,
  actor: string,
  op: 'merge' | 'override'
): string {
  const scope = op === 'merge'
    ? `task slug "${task.id}" or branch "${task.branch ?? 'none'}"`
    : `task slug "${task.id}"`;
  return `Refused task close for "${task.id}": ${actor} requires a live ${op} grant matching ${scope}. ` +
    `Request authorization: swarm escalate ${task.id} --question "<one line>". ` +
    `Operator remedy: ${closeGrantCommand(op, task.id)}. See docs/ROUTING.md for the grant/escalation decision path.`;
}

function requireCloseGrant(
  db: SwarmDb,
  task: Task,
  actor: string,
  op: 'merge' | 'override',
  now?: number
): Grant {
  const resources = op === 'merge'
    ? [task.id, ...(task.branch ? [task.branch] : [])]
    : [task.id];
  const match = findLiveGrant(db, task.swarm_id, { op, resources, actor, now });
  if (!match) throw new Error(missingCloseGrantMessage(task, actor, op));
  return match.grant;
}

export async function closeTask(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  slug: string,
  options: CloseTaskOptions
): Promise<CloseTaskResult> {
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

  const authority = requireTaskAuthority(db, swarmId, slug, actor, 'close');
  const task = authority.task;
  const claimKind = effectiveClaimKind(task);
  if (options.override) requireCloseGrant(db, task, actor, 'override');
  if (claimKind === 'code-merged' && options.disposition === 'merged') {
    requireCloseGrant(db, task, actor, 'merge');
  }
  const forcedDiscard = options.disposition === 'discard' && options.forceDiscard === true;
  // A forced discard declares the work void. Requiring claim-shaped proof for
  // voided work creates evidence theater, so the audited discard bypasses the
  // entire evidence matrix just as it already bypasses preservation/git gates.
  const evidenceReview: EvidenceReview = forcedDiscard
    ? { evidence: [], failures: [] }
    : await reviewCloseEvidence(
      db,
      task,
      claimKind,
      options.evidence ?? [],
      options.outcome,
      options.deployHealthCheck ?? defaultDeployHealthCheck
    );
  const facts = taskGitFacts(task);
  const preservedArchive = options.disposition === 'archive' && hasVerifiedRescue(task);
  const gitReview = reviewGitGates(
    task,
    facts,
    claimKind,
    options.disposition,
    preservedArchive,
    forcedDiscard
  );
  const failures = [...evidenceReview.failures, ...gitReview.failures];
  const defaultBranchFailure = gitReview.failures.find(
    failure => failure.gate === 'git-default-branch-reachability'
  );
  // A merged disposition is a statement about the default branch, not a
  // preservation convenience. Even an override must not remove the worktree
  // or record merged until that concrete source→target comparison passes.
  if (defaultBranchFailure) throw new Error(defaultBranchFailure.message);
  if (!options.override && failures.length > 0) {
    throw new Error(failures.find(failure => failure.message)?.message ?? `Cannot close task "${slug}": a close gate failed.`);
  }

  const result = withImmediateTransaction(db, () => {
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

    const grantsUsed: Grant[] = [];
    try {
      if (options.override) grantsUsed.push(requireCloseGrant(db, current, actor, 'override'));
      if (effectiveClaimKind(current) === 'code-merged' && options.disposition === 'merged') {
        grantsUsed.push(requireCloseGrant(db, current, actor, 'merge'));
      }
    } catch (error: unknown) {
      return { error: error instanceof Error ? error.message : String(error) };
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
    for (const grant of grantsUsed) {
      recordGrantUsed(db, current, grant, actor, timestamp);
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
  }) as { task?: Task | null; error?: string };

  if (result.error || !result.task) throw new Error(result.error ?? `Failed to close task "${slug}".`);
  return gitReview.mergedVerification
    ? { ...result.task, close_verification: gitReview.mergedVerification }
    : result.task;
}

function resolveRunTask(
  db: SwarmDb,
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
  `).all(swarmId) as unknown as Task[]).filter(task =>
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
  db: SwarmDb,
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

function latestCheckpoint(db: SwarmDb, task: Task): { event: TaskEvent; path: string } | null {
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

function sha256(contents: string): string {
  return createHash('sha256').update(contents, 'utf-8').digest('hex');
}

export function parseHandoffOfferTtl(value: string): number {
  const durationMs = parseGrantTtl(value);
  if (durationMs > HANDOFF_OFFER_MAX_TTL_MS) {
    throw new Error(
      `Invalid handoff --ttl "${value}". Handoff offers must expire within 1d so abandoned offers dead-letter promptly.`
    );
  }
  return durationMs;
}

function getHandoffOffer(db: SwarmDb, swarmId: string, offerId: number): HandoffOffer | null {
  return db.prepare('SELECT * FROM handoff_offers WHERE swarm_id = ? AND id = ?')
    .get(swarmId, offerId) as HandoffOffer | undefined ?? null;
}

function pendingHandoffOffer(
  db: SwarmDb,
  swarmId: string,
  taskId: string,
  actor: string,
  role: 'sender' | 'recipient',
  offerId?: number
): HandoffOffer | null {
  const partyColumn = role === 'sender' ? 'from_agent' : 'to_agent';
  const params: Array<string | number> = [swarmId, taskId, actor];
  let idClause = '';
  if (offerId !== undefined) {
    idClause = 'AND id = ?';
    params.push(offerId);
  }
  return db.prepare(`
    SELECT * FROM handoff_offers
    WHERE swarm_id = ? AND task_id = ?
      AND ${partyColumn} = ? COLLATE NOCASE
      ${idClause}
    ORDER BY id DESC
    LIMIT 1
  `).get(...params) as HandoffOffer | undefined ?? null;
}

function transitionStaleHandoffOffer(
  db: SwarmDb,
  offer: HandoffOffer,
  status: 'expired' | 'invalidated',
  task: Task | null,
  resolvedAt: string,
  detail: Record<string, unknown>
): HandoffOffer | null {
  const changed = db.prepare(`
    UPDATE handoff_offers
    SET status = ?, resolved_at = ?, resolved_by = NULL
    WHERE swarm_id = ? AND id = ? AND status = 'pending'
  `).run(status, resolvedAt, offer.swarm_id, offer.id);
  if (Number(changed.changes) === 0) return null;
  if (task) {
    insertEvent(
      db,
      task,
      status === 'expired' ? 'handoff_offer_expired' : 'handoff_offer_invalidated',
      null,
      {
        offer_id: offer.id,
        from: offer.from_agent,
        to: offer.to_agent,
        source_epoch: offer.source_epoch,
        charter_sha256: offer.charter_sha256,
        ...detail,
      },
      resolvedAt
    );
  }
  return getHandoffOffer(db, offer.swarm_id, offer.id);
}

/**
 * Deterministically resolves offers that can no longer be accepted. The source
 * owner keeps the task lease throughout: expiry is a dead letter, not a
 * best-effort authority transfer.
 */
export function sweepHandoffOffers(
  db: SwarmDb,
  swarmId: string,
  now: number = Date.now()
): HandoffSweepResult {
  if (!Number.isFinite(now)) throw new Error('Handoff sweep time must be finite.');
  const at = new Date(now).toISOString();
  const pending = db.prepare(`
    SELECT * FROM handoff_offers
    WHERE swarm_id = ? AND status = 'pending'
    ORDER BY id ASC
  `).all(swarmId) as unknown as HandoffOffer[];
  const result: HandoffSweepResult = { expired: [], invalidated: [] };

  for (const offer of pending) {
    const transitioned = withImmediateTransaction(db, () => {
      const current = getHandoffOffer(db, swarmId, offer.id);
      if (!current || current.status !== 'pending') return null;
      const task = getTask(db, swarmId, current.task_id);
      if (
        !task ||
        !sameName(task.owner_agent, current.from_agent) ||
        task.lease_epoch !== current.source_epoch
      ) {
        return transitionStaleHandoffOffer(db, current, 'invalidated', task, at, {
          reason: 'source task authority changed before acceptance',
          current_owner: task?.owner_agent ?? null,
          current_epoch: task?.lease_epoch ?? null,
        });
      }
      if (current.expires_at <= at) {
        return transitionStaleHandoffOffer(db, current, 'expired', task, at, {
          reason: 'recipient did not accept before the pickup deadline',
        });
      }
      return null;
    }) as HandoffOffer | null;
    if (!transitioned) continue;
    if (transitioned.status === 'expired') result.expired.push(transitioned);
    if (transitioned.status === 'invalidated') result.invalidated.push(transitioned);
  }
  return result;
}

export function listHandoffOffers(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  taskId?: string
): HandoffOfferView[] {
  if (taskId) validateTaskSlug(taskId);
  const params: string[] = [swarmId, actor, actor];
  if (taskId) params.push(taskId);
  return db.prepare(`
    SELECT
      o.*,
      CASE
        WHEN o.message_id IS NULL THEN 'not-recorded'
        WHEN d.status IS NOT NULL THEN d.status
        WHEN m.delivered = 0 THEN 'queued'
        ELSE 'pushed-unconfirmed'
      END AS pickup_status,
      d.first_injected_at,
      d.acked_at
    FROM handoff_offers o
    LEFT JOIN messages m
      ON m.id = o.message_id
      AND m.swarm_id = o.swarm_id
    LEFT JOIN message_deliveries d
      ON d.message_id = o.message_id
      AND d.swarm_id = o.swarm_id
      AND d.recipient = o.to_agent COLLATE NOCASE
    WHERE o.swarm_id = ?
      AND (o.from_agent = ? COLLATE NOCASE OR o.to_agent = ? COLLATE NOCASE)
      ${taskId ? 'AND o.task_id = ?' : ''}
    ORDER BY o.id DESC
  `).all(...params) as unknown as HandoffOfferView[];
}

export function getHandoffOfferHookLines(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  now: number = Date.now()
): string[] {
  sweepHandoffOffers(db, swarmId, now);
  const cutoff = new Date(now - 24 * 60 * 60_000).toISOString();
  return listHandoffOffers(db, swarmId, actor)
    .filter(offer =>
      offer.status === 'pending' ||
      (
        ['expired', 'invalidated', 'declined'].includes(offer.status) &&
        (offer.resolved_at ?? offer.created_at) >= cutoff
      )
    )
    .slice(0, 5)
    .map(offer => {
      if (offer.status === 'pending') {
        const minutes = Math.max(0, Math.ceil((new Date(offer.expires_at).getTime() - now) / 60_000));
        if (sameName(offer.to_agent, actor)) {
          return `Handoff offer #${offer.id}: ${offer.task_id} from ${offer.from_agent}; ${minutes}m to accept — swarm handoff accept ${offer.task_id} --offer ${offer.id}`;
        }
        return `Handoff offer #${offer.id}: ${offer.task_id} to ${offer.to_agent}; pickup ${offer.pickup_status}; ${minutes}m remaining — swarm handoff status ${offer.task_id}`;
      }
      if (sameName(offer.from_agent, actor)) {
        return `Handoff DEAD LETTER #${offer.id}: ${offer.task_id} is ${offer.status}; your source lease was not transferred — swarm handoff status ${offer.task_id}`;
      }
      return `Handoff offer #${offer.id}: ${offer.task_id} is ${offer.status}; no lease transfer occurred.`;
    });
}

export async function offerTaskHandoff(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  slug: string,
  targetName: string,
  options: OfferTaskHandoffOptions = {}
): Promise<HandoffOfferResult> {
  validateTaskSlug(slug);
  sweepHandoffOffers(db, swarmId, options.now ?? Date.now());
  const source = getAgent(db, swarmId, actor);
  if (!source) throw new Error(`Source agent "${actor}" is not registered in this swarm.`);
  const target = getAgent(db, swarmId, targetName);
  if (!target) throw new Error(`Agent "${targetName}" not found in this swarm.`);
  if (sameName(target.name, actor)) throw new Error('Cannot offer a task handoff to yourself.');

  const authority = requireTaskAuthority(db, swarmId, slug, actor, 'handoff offer');
  const task = authority.task;
  const checkpoint = latestCheckpoint(db, task);
  if (!checkpoint || !fs.existsSync(checkpoint.path)) {
    throw new Error(`Task "${slug}" has no readable checkpoint. Run "swarm task checkpoint ${slug}" before offering a handoff.`);
  }
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('Handoff offer time must be finite.');
  const ageMinutes = Math.floor((now - new Date(checkpoint.event.created_at).getTime()) / 60_000);
  const stale = ageMinutes > HANDOFF_FRESH_MINUTES;
  if (stale && !options.staleOk) {
    throw new Error(`Task "${slug}" checkpoint is ${ageMinutes}m old; handoff requires one within ${HANDOFF_FRESH_MINUTES}m. Checkpoint now or re-run with --stale-ok.`);
  }
  const ttl = options.ttl ?? HANDOFF_OFFER_DEFAULT_TTL;
  const ttlMs = parseHandoffOfferTtl(ttl);
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();

  const facts = taskGitFacts(task);
  const title = `${stale ? 'STALE ' : ''}${task.title.replace(/[\r\n]+/g, ' ')}`;
  const checkpointBody = fs.readFileSync(checkpoint.path, 'utf-8');
  const briefDir = path.join(swarmHome(), 'briefs', 'handoff-offers');
  fs.mkdirSync(briefDir, { recursive: true });
  const briefPath = path.join(
    briefDir,
    `${slug}--${minuteStamp(new Date(now))}--${randomUUID()}.md`
  );
  const brief = `# ${title}

## handoff contract
- from: ${actor}
- to: ${target.name}
- source registration id: ${source.id}
- recipient registration id: ${target.id}
- source lease epoch: ${task.lease_epoch}
- pickup deadline: ${expiresAt}
- acceptance command: swarm handoff accept ${task.id}
- authority rule: the source owner retains the lease until the named recipient accepts this exact charter

## task facts
- slug: ${task.id}
- state: ${task.state}
- owner: ${task.owner_agent ?? 'unowned'}
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
  const charterSha256 = sha256(brief);
  fs.writeFileSync(briefPath, brief, { encoding: 'utf-8', flag: 'wx' });

  const offered = withImmediateTransaction(db, () => {
    const current = getTask(db, swarmId, slug);
    if (!current || !sameName(current.owner_agent, actor) || current.lease_epoch !== authority.epoch) {
      if (current) {
        insertEvent(db, current, 'refused_stale_epoch', actor, {
          verb: 'handoff offer',
          owner_agent: current.owner_agent,
          current_epoch: current.lease_epoch,
          presented_epoch: authority.epoch,
        });
        return { error: staleAuthorityMessage(current, actor, 'handoff offer', authority.epoch) };
      }
      return { error: `Task "${slug}" not found in this swarm.` };
    }
    const existing = db.prepare(`
      SELECT id FROM handoff_offers
      WHERE swarm_id = ? AND task_id = ? AND status = 'pending'
    `).get(swarmId, slug) as { id: number } | undefined;
    if (existing) {
      return {
        error:
          `Task "${slug}" already has pending handoff offer #${existing.id}. ` +
          `Accept, decline, cancel, or let it expire before creating another.`,
      };
    }
    const inserted = db.prepare(`
      INSERT INTO handoff_offers (
        swarm_id, task_id, from_agent, to_agent, from_agent_id, to_agent_id, source_epoch,
        brief_path, charter_sha256, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      swarmId,
      slug,
      actor,
      target.name,
      source.id,
      target.id,
      authority.epoch,
      briefPath,
      charterSha256,
      createdAt,
      expiresAt
    );
    const offer = getHandoffOffer(db, swarmId, Number(inserted.lastInsertRowid));
    if (!offer) return { error: `Failed to create a handoff offer for "${slug}".` };
    insertEvent(db, current, 'handoff_offered', actor, {
      offer_id: offer.id,
      to: target.name,
      from_agent_id: source.id,
      to_agent_id: target.id,
      source_epoch: authority.epoch,
      brief_path: briefPath,
      charter_sha256: charterSha256,
      expires_at: expiresAt,
      stale,
      checkpoint_age_minutes: ageMinutes,
    }, createdAt);
    return { offer };
  }) as { offer?: HandoffOffer; error?: string };
  if (offered.error || !offered.offer) {
    throw new Error(
      `${offered.error ?? `Failed to offer task "${slug}".`} Unreferenced charter preserved at ${briefPath}.`
    );
  }

  const body =
    `Handoff offer #${offered.offer.id} for ${slug}; accept by ${expiresAt} with ` +
    `swarm handoff accept ${slug} --offer ${offered.offer.id}; ` +
    `charter sha256=${charterSha256}; brief=${briefPath.replace(/[\r\n]+/g, ' ')}`;
  const delivery = await sendMessage(db, swarmId, actor, target.name, body, undefined, 'handoff');
  if (!delivery.delivered && !delivery.queued) {
    withImmediateTransaction(db, () => {
      const currentOffer = getHandoffOffer(db, swarmId, offered.offer!.id);
      const currentTask = getTask(db, swarmId, slug);
      if (currentOffer?.status === 'pending') {
        transitionStaleHandoffOffer(
          db,
          currentOffer,
          'invalidated',
          currentTask,
          new Date(options.now ?? Date.now()).toISOString(),
          { reason: `recipient pointer could not be recorded: ${delivery.message}` }
        );
      }
    });
    throw new Error(`Handoff offer was not activated because pointer delivery failed: ${delivery.message}`);
  }
  db.prepare(`
    UPDATE handoff_offers SET message_id = ?
    WHERE swarm_id = ? AND id = ? AND status = 'pending'
  `).run(delivery.messageId ?? null, swarmId, offered.offer.id);
  const offer = getHandoffOffer(db, swarmId, offered.offer.id) ?? offered.offer;
  return {
    offer,
    task,
    briefPath,
    stale,
    message: delivery.message,
  };
}

function verifyHandoffCharter(offer: HandoffOffer): string | null {
  if (!fs.existsSync(offer.brief_path)) return 'charter file is missing';
  try {
    const digest = sha256(fs.readFileSync(offer.brief_path, 'utf-8'));
    return digest === offer.charter_sha256
      ? null
      : `charter digest mismatch (expected ${offer.charter_sha256}, got ${digest})`;
  } catch (error: unknown) {
    return `charter could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function acceptTaskHandoff(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  slug: string,
  options: ResolveHandoffOfferOptions = {}
): Promise<HandoffOfferResolutionResult> {
  validateTaskSlug(slug);
  const now = options.now ?? Date.now();
  sweepHandoffOffers(db, swarmId, now);
  const selected = pendingHandoffOffer(db, swarmId, slug, actor, 'recipient', options.offerId);
  if (!selected) {
    throw new Error(`No handoff offer for task "${slug}" is addressed to ${actor}.`);
  }
  if (selected.status !== 'pending') {
    throw new Error(`Handoff offer #${selected.id} is ${selected.status}; it cannot transfer a lease.`);
  }

  const resolved = withImmediateTransaction(db, () => {
    const offer = getHandoffOffer(db, swarmId, selected.id);
    const task = getTask(db, swarmId, slug);
    if (!offer || offer.status !== 'pending') {
      return { error: `Handoff offer #${selected.id} is no longer pending.` };
    }
    if (!task) return { error: `Task "${slug}" not found in this swarm.` };
    const acceptedAt = new Date(now).toISOString();
    const recipient = getAgent(db, swarmId, actor);
    if (!recipient || (offer.to_agent_id !== null && recipient.id !== offer.to_agent_id)) {
      transitionStaleHandoffOffer(db, offer, 'invalidated', task, acceptedAt, {
        reason: 'named recipient registration changed before acceptance',
        expected_recipient_agent_id: offer.to_agent_id,
        current_recipient_agent_id: recipient?.id ?? null,
      });
      return {
        error:
          `Handoff offer #${offer.id} was invalidated because ${actor}'s agent registration changed. ` +
          'The source owner must issue a fresh offer.',
      };
    }
    if (offer.expires_at <= acceptedAt) {
      transitionStaleHandoffOffer(db, offer, 'expired', task, acceptedAt, {
        reason: 'recipient acceptance arrived after the pickup deadline',
      });
      return { error: `Handoff offer #${offer.id} expired at ${offer.expires_at}; the source lease was not transferred.` };
    }
    if (!sameName(task.owner_agent, offer.from_agent) || task.lease_epoch !== offer.source_epoch) {
      transitionStaleHandoffOffer(db, offer, 'invalidated', task, acceptedAt, {
        reason: 'source task authority changed before acceptance',
        current_owner: task.owner_agent,
        current_epoch: task.lease_epoch,
      });
      return { error: `Handoff offer #${offer.id} was invalidated because task authority changed.` };
    }
    const charterError = verifyHandoffCharter(offer);
    if (charterError) {
      transitionStaleHandoffOffer(db, offer, 'invalidated', task, acceptedAt, {
        reason: charterError,
      });
      return {
        error:
          `Handoff offer #${offer.id} was invalidated: ${charterError}. ` +
          `The source lease was not transferred.`,
      };
    }

    const nextEpoch = task.lease_epoch + 1;
    db.prepare(`
      UPDATE tasks
      SET owner_agent = ?, lease_epoch = ?, lease_expires_at = ?, updated_at = ?
      WHERE swarm_id = ? AND id = ?
    `).run(actor, nextEpoch, leaseExpiry(), acceptedAt, swarmId, slug);
    db.prepare(`
      UPDATE handoff_offers
      SET status = 'accepted', resolved_at = ?, resolved_by = ?, accepted_epoch = ?
      WHERE swarm_id = ? AND id = ? AND status = 'pending'
    `).run(acceptedAt, actor, nextEpoch, swarmId, offer.id);
    const nextTask = getTask(db, swarmId, slug);
    const nextOffer = getHandoffOffer(db, swarmId, offer.id);
    if (!nextTask || !nextOffer) return { error: `Failed to accept handoff offer #${offer.id}.` };
    insertEvent(db, nextTask, 'handoff_accepted', actor, {
      offer_id: offer.id,
      from: offer.from_agent,
      to: actor,
      from_agent_id: offer.from_agent_id,
      to_agent_id: recipient.id,
      source_epoch: offer.source_epoch,
      accepted_epoch: nextEpoch,
      brief_path: offer.brief_path,
      charter_sha256: offer.charter_sha256,
    }, acceptedAt);
    return { task: nextTask, offer: nextOffer };
  }) as { task?: Task; offer?: HandoffOffer; error?: string };
  if (resolved.error || !resolved.task || !resolved.offer) {
    throw new Error(resolved.error ?? `Failed to accept handoff offer #${selected.id}.`);
  }

  const delivery = await sendMessage(
    db,
    swarmId,
    actor,
    selected.from_agent,
    `Accepted handoff offer #${selected.id} for ${slug}; lease epoch is now ${resolved.task.lease_epoch}; charter sha256=${selected.charter_sha256}.`,
    undefined,
    'ack'
  );
  return {
    offer: resolved.offer,
    task: resolved.task,
    message:
      delivery.delivered || delivery.queued
        ? delivery.message
        : `Acceptance is durable; sender notification was not recorded: ${delivery.message}`,
  };
}

export async function declineTaskHandoff(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  slug: string,
  options: ResolveHandoffOfferOptions = {}
): Promise<HandoffOfferResolutionResult> {
  validateTaskSlug(slug);
  const now = options.now ?? Date.now();
  sweepHandoffOffers(db, swarmId, now);
  const selected = pendingHandoffOffer(db, swarmId, slug, actor, 'recipient', options.offerId);
  if (!selected) throw new Error(`No handoff offer for task "${slug}" is addressed to ${actor}.`);
  if (selected.status !== 'pending') {
    throw new Error(`Handoff offer #${selected.id} is ${selected.status}; it cannot be declined.`);
  }
  const resolvedAt = new Date(now).toISOString();
  const reason = options.reason?.replace(/\s+/g, ' ').trim() || 'recipient declined';
  const result = withImmediateTransaction(db, () => {
    const offer = getHandoffOffer(db, swarmId, selected.id);
    const task = getTask(db, swarmId, slug);
    if (!offer || offer.status !== 'pending') return { error: `Handoff offer #${selected.id} is no longer pending.` };
    if (!task) return { error: `Task "${slug}" not found in this swarm.` };
    const recipient = getAgent(db, swarmId, actor);
    if (!recipient || (offer.to_agent_id !== null && recipient.id !== offer.to_agent_id)) {
      transitionStaleHandoffOffer(db, offer, 'invalidated', task, resolvedAt, {
        reason: 'named recipient registration changed before decline',
        expected_recipient_agent_id: offer.to_agent_id,
        current_recipient_agent_id: recipient?.id ?? null,
      });
      return {
        error:
          `Handoff offer #${offer.id} was invalidated because ${actor}'s agent registration changed.`
      };
    }
    db.prepare(`
      UPDATE handoff_offers
      SET status = 'declined', resolved_at = ?, resolved_by = ?
      WHERE swarm_id = ? AND id = ? AND status = 'pending'
    `).run(resolvedAt, actor, swarmId, offer.id);
    insertEvent(db, task, 'handoff_declined', actor, {
      offer_id: offer.id,
      from: offer.from_agent,
      to: offer.to_agent,
      source_epoch: offer.source_epoch,
      charter_sha256: offer.charter_sha256,
      reason,
    }, resolvedAt);
    return { offer: getHandoffOffer(db, swarmId, offer.id), task };
  }) as { offer?: HandoffOffer | null; task?: Task; error?: string };
  if (result.error || !result.offer || !result.task) {
    throw new Error(result.error ?? `Failed to decline handoff offer #${selected.id}.`);
  }
  const delivery = await sendMessage(
    db,
    swarmId,
    actor,
    selected.from_agent,
    `Declined handoff offer #${selected.id} for ${slug}; source lease remains unchanged; reason=${reason}.`,
    undefined,
    'ack'
  );
  return {
    offer: result.offer,
    task: result.task,
    message:
      delivery.delivered || delivery.queued
        ? delivery.message
        : `Decline is durable; sender notification was not recorded: ${delivery.message}`,
  };
}

export function cancelTaskHandoff(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  slug: string,
  options: ResolveHandoffOfferOptions = {}
): HandoffOfferResolutionResult {
  validateTaskSlug(slug);
  const now = options.now ?? Date.now();
  sweepHandoffOffers(db, swarmId, now);
  const selected = pendingHandoffOffer(db, swarmId, slug, actor, 'sender', options.offerId);
  if (!selected) throw new Error(`No handoff offer for task "${slug}" was sent by ${actor}.`);
  if (selected.status !== 'pending') {
    throw new Error(`Handoff offer #${selected.id} is ${selected.status}; it cannot be cancelled.`);
  }
  const source = getAgent(db, swarmId, actor);
  if (!source || (selected.from_agent_id !== null && source.id !== selected.from_agent_id)) {
    throw new Error(
      `Handoff offer #${selected.id} belongs to a different ${actor} registration; ` +
      'let it expire or have the original source registration cancel it.'
    );
  }
  const authority = requireTaskAuthority(db, swarmId, slug, actor, 'handoff cancel', selected.source_epoch);
  const resolvedAt = new Date(now).toISOString();
  const reason = options.reason?.replace(/\s+/g, ' ').trim() || 'sender cancelled';
  const result = withImmediateTransaction(db, () => {
    const offer = getHandoffOffer(db, swarmId, selected.id);
    const task = getTask(db, swarmId, slug);
    if (!offer || offer.status !== 'pending') return { error: `Handoff offer #${selected.id} is no longer pending.` };
    if (!task || !sameName(task.owner_agent, actor) || task.lease_epoch !== authority.epoch) {
      return { error: task ? staleAuthorityMessage(task, actor, 'handoff cancel', authority.epoch) : `Task "${slug}" not found.` };
    }
    db.prepare(`
      UPDATE handoff_offers
      SET status = 'cancelled', resolved_at = ?, resolved_by = ?
      WHERE swarm_id = ? AND id = ? AND status = 'pending'
    `).run(resolvedAt, actor, swarmId, offer.id);
    insertEvent(db, task, 'handoff_cancelled', actor, {
      offer_id: offer.id,
      from: offer.from_agent,
      to: offer.to_agent,
      source_epoch: offer.source_epoch,
      charter_sha256: offer.charter_sha256,
      reason,
    }, resolvedAt);
    return { offer: getHandoffOffer(db, swarmId, offer.id), task };
  }) as { offer?: HandoffOffer | null; task?: Task; error?: string };
  if (result.error || !result.offer || !result.task) {
    throw new Error(result.error ?? `Failed to cancel handoff offer #${selected.id}.`);
  }
  return { offer: result.offer, task: result.task, message: 'Cancellation recorded.' };
}

export async function handoffTask(
  db: SwarmDb,
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

  const authority = requireTaskAuthority(db, swarmId, slug, actor, 'handoff');
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

  const transferred = withImmediateTransaction(db, () => {
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
  }) as { task?: Task; error?: string };
  if (transferred.error || !transferred.task) throw new Error(transferred.error ?? `Failed to hand off task "${slug}".`);

  const body = `Handoff ${slug}: ${briefPath.replace(/[\r\n]+/g, ' ')} — ${title}`;
  const delivery = await sendMessage(db, swarmId, actor, target.name, body, undefined, 'handoff');
  if (!delivery.delivered && !delivery.queued) {
    throw new Error(`Task authority transferred, but handoff pointer delivery failed: ${delivery.message}`);
  }
  return { task: transferred.task, briefPath, stale, message: delivery.message };
}

export function recordDecision(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  body: string,
  taskId?: string,
  supersedes?: number
): DecisionResult {
  const text = body.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Decision text cannot be empty.');
  if (taskId) validateTaskSlug(taskId);
  const authority = taskId
    ? requireTaskAuthority(db, swarmId, taskId, actor, 'record decision')
    : null;
  const actorAgentId = getAgent(db, swarmId, actor)?.id ?? null;
  return withImmediateTransaction(db, () => {
    let task: Task | null = null;
    if (taskId && authority) {
      task = getTask(db, swarmId, taskId);
      if (!task || !sameName(task.owner_agent, actor) || task.lease_epoch !== authority.epoch) {
        if (task) {
          insertEvent(db, task, 'refused_stale_epoch', actor, {
            verb: 'record decision',
            owner_agent: task.owner_agent,
            current_epoch: task.lease_epoch,
            presented_epoch: authority.epoch,
          });
        }
        throw new Error(
          task
            ? staleAuthorityMessage(task, actor, 'record decision', authority.epoch)
            : `Task "${taskId}" not found in this swarm.`
        );
      }
    }
    if (supersedes !== undefined) {
      const previous = db.prepare(`
        SELECT id, made_by, task_id FROM decisions
        WHERE id = ? AND swarm_id = ?
      `).get(supersedes, swarmId) as {
        id: number;
        made_by: string;
        task_id: string | null;
      } | undefined;
      if (!previous) throw new Error(`Decision #${supersedes} does not exist in this swarm.`);
      if (!sameName(previous.made_by, actor)) {
        throw new Error(
          `Decision #${supersedes} was made by ${previous.made_by}; only that authenticated author may supersede it.`
        );
      }
      if ((previous.task_id ?? null) !== (taskId ?? null)) {
        throw new Error(
          `Decision #${supersedes} belongs to ${previous.task_id ? `task "${previous.task_id}"` : 'program scope'}; ` +
          'a superseding decision must keep the same scope.'
        );
      }
    }
    const createdAt = nowIso();
    const result = db.prepare(`
      INSERT INTO decisions (
        swarm_id, task_id, body, made_by, actor_agent_id, task_epoch,
        supersedes, status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(
      swarmId,
      taskId ?? null,
      text,
      actor,
      actorAgentId,
      authority?.epoch ?? null,
      supersedes ?? null,
      createdAt
    );
    const decisionId = Number(result.lastInsertRowid);
    if (supersedes !== undefined) {
      db.prepare("UPDATE decisions SET status = 'superseded' WHERE id = ? AND swarm_id = ?")
        .run(supersedes, swarmId);
    }
    if (task) {
      insertEvent(db, task, 'decision_recorded', actor, {
        decision_id: decisionId,
        actor_agent_id: actorAgentId,
        task_epoch: authority!.epoch,
        supersedes: supersedes ?? null,
      }, createdAt);
    }
    return { id: decisionId };
  }) as DecisionResult;
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
  db: SwarmDb,
  swarmId: string,
  actor: string,
  at: Date = new Date()
): string[] {
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE swarm_id = ? AND owner_agent = ? COLLATE NOCASE AND state = 'active'
    ORDER BY updated_at ASC, id ASC
  `).all(swarmId, actor) as unknown as Task[];

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
