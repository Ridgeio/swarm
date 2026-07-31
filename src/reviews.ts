import { withImmediateTransaction, type SwarmDb } from './db.js';
import fs from 'fs';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { evidenceLines, latestCheckpoint } from './escalations.js';
import { enqueueDirectMessage, flushMessageOutbox } from './mailbox.js';
import { getAgent, listAgents, type Agent } from './registry.js';
import {
  getTask,
  effectiveClaimKind,
  requireTaskAuthority,
  taskGitFacts,
  validateTaskSlug,
  type Task,
} from './tasks.js';
import { requireActiveAgent } from './authority.js';
import { deriveModelFamily, type ModelFamily } from './model-family.js';
import {
  findLiveReviewerQualification,
  type QualificationBinding,
  type ReviewerQualification,
} from './qualifications.js';

export { deriveModelFamily, MODEL_FAMILY_MAP } from './model-family.js';
export type { ModelFamily } from './model-family.js';

export const REVIEW_PRIORS: Readonly<Record<ModelFamily, string>> = Object.freeze({
  claude: 'missing behavior (top), then semantic intent, error handling',
  openai: 'build breakage (top); note semantic-intent/error-handling are weak for ALL reviewers on this family — rely on tests',
  xai: 'no measured priors — general adversarial review',
  google: 'no measured priors — general adversarial review',
  unknown: 'no measured priors — general adversarial review',
});

export const REVIEW_EXPERIMENTAL_CAVEAT =
  'experimental… still learning how far the effect goes as models improve.';

export interface ReviewOptions {
  to?: string;
  sameFamilyOk?: boolean;
  reason?: string;
  now?: Date;
  /** Test/integration override; production briefs always use os.homedir(). */
  homeDir?: string;
}

export interface ReviewResult {
  task: Task;
  briefPath: string;
  reviewer: string;
  authorFamily: ModelFamily;
  reviewerFamily: ModelFamily;
  messageId: number | null;
  requestId: number;
  qualificationId: number;
}

export interface SubmitReviewVerdictOptions extends QualificationBinding {
  requestId: number;
  verdict: 'pass' | 'block';
  reportPath: string;
  headSha: string;
  treeSha: string;
  qualificationId: number;
  now?: Date;
}

export interface ReviewVerdictResult {
  id: number;
  requestId: number;
  verdict: 'pass' | 'block';
  reportSha256: string;
  headSha: string;
  treeSha: string;
}

function sameName(left: string | null | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function minuteStamp(date: Date): string {
  const digits = date.toISOString().replace(/[-:]/g, '');
  return `${digits.slice(0, 8)}-${digits.slice(9, 13)}`;
}

function openReviewLoads(db: SwarmDb, swarmId: string): Map<string, number> {
  const rows = db.prepare(`
    SELECT e.data
    FROM task_events e
    JOIN tasks t ON t.swarm_id = e.swarm_id AND t.id = e.task_id
    WHERE e.swarm_id = ? AND e.kind = 'review_requested' AND t.state = 'awaiting_review'
  `).all(swarmId) as Array<{ data: string | null }>;
  const loads = new Map<string, number>();
  for (const row of rows) {
    if (!row.data) continue;
    try {
      const reviewer = (JSON.parse(row.data) as { reviewer?: unknown }).reviewer;
      if (typeof reviewer !== 'string') continue;
      const key = reviewer.toLowerCase();
      loads.set(key, (loads.get(key) ?? 0) + 1);
    } catch {
      // Malformed legacy event data does not make routing unavailable.
    }
  }
  return loads;
}

function differentFamilyAgents(agents: Agent[], authorFamily: ModelFamily): Agent[] {
  return agents.filter(agent => deriveModelFamily(agent.host_agent) !== authorFamily);
}

function remoteContainsHead(repoPath: string, head: string): boolean {
  try {
    const output = execFileSync('git', ['-C', repoPath, 'branch', '-r', '--contains', head], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function assertReviewableSource(task: Task): ReturnType<typeof taskGitFacts> {
  const facts = taskGitFacts(task);
  if (effectiveClaimKind(task) !== 'code-merged') return facts;
  if (!task.repo_path || !task.branch || !task.head_sha || !task.tree_sha || !task.author_family) {
    throw new Error(
      `Code task "${task.id}" lacks mandatory repository/branch/head/tree/author-family identity and cannot receive a binding review.`
    );
  }
  if (facts.head === 'unknown' || facts.tree === 'unknown') {
    throw new Error(`Code task "${task.id}" has unknown live head/tree and cannot receive a binding review.`);
  }
  if (facts.branch !== task.branch) {
    throw new Error(
      `Code task "${task.id}" moved from recorded branch ${task.branch} to ${facts.branch}; refuse binding review.`
    );
  }
  if (facts.dirtyTracked > 0 || facts.untracked > 0) {
    throw new Error(
      `Code task "${task.id}" is dirty (${facts.dirtyTracked} tracked, ${facts.untracked} untracked); refuse binding review.`
    );
  }
  if (facts.unpushed.length > 0 || !remoteContainsHead(task.repo_path, facts.head)) {
    throw new Error(`Code task "${task.id}" head ${facts.head} is unpushed or not remotely reachable; refuse binding review.`);
  }
  return facts;
}

function sameFamilyRefusal(
  slug: string,
  reviewer: Agent,
  alternatives: Agent[]
): string {
  const names = alternatives.length > 0
    ? alternatives.map(agent => agent.name).join(', ')
    : 'none currently live';
  return `Refused same-family review for task "${slug}" with reviewer "${reviewer.name}": ` +
    `model inversion requires a reviewer from a different model family. Live different-family members: ${names}. ` +
    `Choose one with --to <agent>, or audit the exception with --to ${reviewer.name} ` +
    `--same-family-ok --reason "<text>".`;
}

function reviewBody(
  db: SwarmDb,
  task: Task,
  authorFamily: ModelFamily,
  qualification: ReviewerQualification
): string {
  const checkpoint = latestCheckpoint(db, task);
  const checkpointText = checkpoint.body ??
    (checkpoint.path ? `[checkpoint unreadable: ${checkpoint.path}]` : '[no checkpoint recorded]');
  const facts = taskGitFacts(task);
  const unpushed = facts.unpushed.length > 0
    ? facts.unpushed.map(line => `  - ${line}`).join('\n')
    : '  - none';
  return `# review ${task.id}

## task state
- state: ${task.state}
- owner: ${task.owner_agent ?? 'unowned'}
- lease epoch: ${task.lease_epoch}
- repository: ${task.repo_path ?? 'none'}
- branch: ${task.branch ?? 'none'}
- exact head: ${facts.head}
- exact tree: ${facts.tree}
- immutable author family: ${authorFamily}
- reviewer qualification: #${qualification.id}, expires ${qualification.expires_at}

## latest checkpoint (verbatim)
${checkpointText}

## evidence
${evidenceLines(db, task).join('\n')}

## git facts
- repo: ${task.repo_path ?? 'none'}
- branch: ${facts.branch}
- head: ${facts.head}
- tree: ${facts.tree}
- dirty tracked: ${facts.dirtyTracked}
- untracked: ${facts.untracked}
- unpushed:
${unpushed}

## INVERSION PRIOR
- author family: ${authorFamily}
- prioritize: ${REVIEW_PRIORS[authorFamily]}
- experimental caveat: ${REVIEW_EXPERIMENTAL_CAVEAT}
`;
}

export async function requestTaskReview(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  slug: string,
  options: ReviewOptions = {}
): Promise<ReviewResult> {
  validateTaskSlug(slug);
  if (options.sameFamilyOk && !options.to) {
    throw new Error(`--same-family-ok requires an explicit reviewer. Re-run with swarm review ${slug} --to <agent> --same-family-ok --reason "<text>".`);
  }
  if (options.sameFamilyOk && !options.reason?.trim()) {
    throw new Error(`--same-family-ok requires --reason "<text>" so the model-inversion exception is audited.`);
  }

  const authority = requireTaskAuthority(db, swarmId, slug, actor, 'review');
  const task = authority.task;
  const facts = assertReviewableSource(task);
  const authorFamily = task.author_family;
  if (!authorFamily || authorFamily === 'unknown') {
    throw new Error(
      `Task "${slug}" has no known immutable author family; an Owner/Lead must rebind legacy provenance before review.`
    );
  }
  const now = options.now ?? new Date();
  const liveAgents = await listAgents(db, swarmId);
  const qualifiedAgents = liveAgents.filter(agent =>
    agent.id !== task.owner_agent_id &&
    findLiveReviewerQualification(db, swarmId, agent.id, now.getTime()) !== null
  );
  const alternatives = differentFamilyAgents(qualifiedAgents, authorFamily);
  let reviewer: Agent;

  if (options.to) {
    const target = liveAgents.find(agent => sameName(agent.name, options.to!));
    if (!target) {
      throw new Error(`Reviewer "${options.to}" is not live in this swarm. Run "swarm members", then retry --to or spawn a reviewer.`);
    }
    if (target.id === task.owner_agent_id) {
      throw new Error(
        `Reviewer "${target.name}" is the exact current task owner registration and cannot review its own task.`
      );
    }
    if (!findLiveReviewerQualification(db, swarmId, target.id, now.getTime())) {
      throw new Error(
        `Reviewer "${target.name}" has no live qualification matching its current registration, worker version, and binary.`
      );
    }
    const reviewerFamily = deriveModelFamily(target.host_agent);
    if (reviewerFamily === authorFamily && !options.sameFamilyOk) {
      throw new Error(sameFamilyRefusal(slug, target, alternatives));
    }
    reviewer = target;
  } else {
    if (alternatives.length === 0) {
      throw new Error(
        `No live qualified cross-family reviewer is available for task "${slug}" (author family: ${authorFamily}). ` +
        `Requalify a different-family reviewer, then re-run swarm review ${slug}.`
      );
    }
    const loads = openReviewLoads(db, swarmId);
    reviewer = alternatives.reduce((best, candidate) => {
      const bestLoad = loads.get(best.name.toLowerCase()) ?? 0;
      const candidateLoad = loads.get(candidate.name.toLowerCase()) ?? 0;
      return candidateLoad < bestLoad ? candidate : best;
    });
  }

  const reviewerFamily = deriveModelFamily(reviewer.host_agent);
  const qualification = findLiveReviewerQualification(db, swarmId, reviewer.id, now.getTime());
  if (!qualification) {
    throw new Error(`Reviewer "${reviewer.name}" qualification expired or drifted before request commit.`);
  }
  const boundTask: Task = { ...task, head_sha: facts.head, tree_sha: facts.tree };
  const briefDir = path.join(options.homeDir ?? os.homedir(), '.swarm', 'briefs', 'reviews');
  fs.mkdirSync(briefDir, { recursive: true });
  const briefPath = path.join(briefDir, `${slug}--${minuteStamp(now)}.md`);
  fs.writeFileSync(briefPath, reviewBody(db, boundTask, authorFamily, qualification), 'utf-8');

  // Recheck the original lease epoch immediately before the state/event mutation.
  requireTaskAuthority(db, swarmId, slug, actor, 'review', authority.epoch);
  const updated = withImmediateTransaction(db, () => {
    const currentActor = requireActiveAgent(db, swarmId, actor, 'request review');
    const currentReviewer = getAgent(db, swarmId, reviewer.name);
    if (!currentReviewer || currentReviewer.id !== reviewer.id) {
      throw new Error(
        `Reviewer "${reviewer.name}" registration changed while the review brief was being prepared. ` +
        `Re-run swarm review ${slug}.`
      );
    }
    const current = getTask(db, swarmId, slug);
    if (
      !current ||
      current.owner_agent_id !== currentActor.id ||
      currentActor.id !== task.owner_agent_id ||
      current.lease_epoch !== authority.epoch
    ) {
      throw new Error(`Task "${slug}" authority changed while the review brief was being prepared. Re-run swarm review ${slug}.`);
    }
    const currentQualification = findLiveReviewerQualification(
      db,
      swarmId,
      reviewer.id,
      now.getTime(),
      undefined,
      qualification.id
    );
    if (!currentQualification) {
      throw new Error(`Reviewer "${reviewer.name}" qualification expired or drifted before request commit.`);
    }
    const currentFacts = assertReviewableSource(current);
    if (currentFacts.head !== facts.head || currentFacts.tree !== facts.tree) {
      throw new Error(`Task "${slug}" head/tree moved while the review brief was being prepared. Re-run swarm review ${slug}.`);
    }
    const createdAt = now.toISOString();
    db.prepare(`
      UPDATE tasks SET state = 'awaiting_review', head_sha = ?, tree_sha = ?, updated_at = ?
      WHERE swarm_id = ? AND id = ?
    `).run(facts.head, facts.tree, createdAt, swarmId, slug);
    const request = db.prepare(`
      INSERT INTO review_requests (
        swarm_id, task_id, task_epoch, requester_agent_id, reviewer_agent_id,
        reviewer_name, author_family, reviewer_family, head_sha, tree_sha,
        qualification_id, brief_path, status, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
    `).run(
      swarmId,
      slug,
      current.lease_epoch,
      currentActor.id,
      reviewer.id,
      reviewer.name,
      authorFamily,
      reviewerFamily,
      facts.head,
      facts.tree,
      qualification.id,
      briefPath,
      createdAt
    );
    const requestId = Number(request.lastInsertRowid);
    if (reviewerFamily === authorFamily && options.sameFamilyOk) {
      db.prepare(`
        INSERT INTO task_events (
          swarm_id, task_id, epoch, kind, actor, actor_agent_id, data, created_at
        ) VALUES (?, ?, ?, 'same_family_review', ?, ?, ?, ?)
      `).run(swarmId, slug, current.lease_epoch, currentActor.name, currentActor.id, JSON.stringify({
        reviewer: reviewer.name,
        reviewer_family: reviewerFamily,
        reason: options.reason!.trim(),
      }), createdAt);
    }
    db.prepare(`
      INSERT INTO task_events (
        swarm_id, task_id, epoch, kind, actor, actor_agent_id, data, created_at
      ) VALUES (?, ?, ?, 'review_requested', ?, ?, ?, ?)
    `).run(swarmId, slug, current.lease_epoch, currentActor.name, currentActor.id, JSON.stringify({
      author_family: authorFamily,
      reviewer: reviewer.name,
      reviewer_agent_id: reviewer.id,
      reviewer_family: reviewerFamily,
      brief_path: briefPath,
      request_id: requestId,
      qualification_id: qualification.id,
      head_sha: facts.head,
      tree_sha: facts.tree,
    }), createdAt);
    const messageId = enqueueDirectMessage(
      db,
      swarmId,
      currentActor.name,
      reviewer.name,
      briefPath,
      {
        createdAt,
        kind: 'gate',
        fromAgentId: currentActor.id,
        recipientAgentId: reviewer.id,
      }
    );
    return { task: getTask(db, swarmId, slug)!, messageId, requestId };
  }) as { task: Task; messageId: number; requestId: number };

  await flushMessageOutbox(db, [updated.messageId]);
  return {
    task: updated.task,
    briefPath,
    reviewer: reviewer.name,
    authorFamily,
    reviewerFamily,
    messageId: updated.messageId,
    requestId: updated.requestId,
    qualificationId: qualification.id,
  };
}

function exactGitSha(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(normalized)) {
    throw new Error(`${field} must be an exact Git object ID.`);
  }
  return normalized;
}

export function submitReviewVerdict(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  slug: string,
  options: SubmitReviewVerdictOptions
): ReviewVerdictResult {
  validateTaskSlug(slug);
  if (!Number.isSafeInteger(options.requestId) || options.requestId <= 0) {
    throw new Error('--request must be a positive review request ID.');
  }
  if (!Number.isSafeInteger(options.qualificationId) || options.qualificationId <= 0) {
    throw new Error('--qualification must be a positive qualification ID.');
  }
  if (!['pass', 'block'].includes(options.verdict)) {
    throw new Error('--verdict must be pass or block.');
  }
  const now = options.now ?? new Date();
  const headSha = exactGitSha(options.headSha, '--head');
  const treeSha = exactGitSha(options.treeSha, '--tree');
  const reportPath = path.resolve(options.reportPath);
  const report = fs.readFileSync(reportPath);
  if (report.length === 0) throw new Error('Typed review report must be non-empty.');
  const reportSha256 = createHash('sha256').update(report).digest('hex');

  return withImmediateTransaction(db, () => {
    const reviewer = requireActiveAgent(db, swarmId, actor, 'submit typed review verdict');
    const request = db.prepare(`
      SELECT * FROM review_requests WHERE swarm_id = ? AND id = ? AND task_id = ?
    `).get(swarmId, options.requestId, slug) as {
      id: number;
      task_epoch: number;
      reviewer_agent_id: string;
      head_sha: string;
      tree_sha: string;
      qualification_id: number;
      status: string;
    } | undefined;
    if (!request) throw new Error(`Review request #${options.requestId} does not bind task "${slug}".`);
    if (request.status !== 'pending') {
      throw new Error(`Review request #${request.id} is ${request.status}; typed verdict slot is closed.`);
    }
    if (request.reviewer_agent_id !== reviewer.id) {
      throw new Error(`Review request #${request.id} belongs to a different immutable reviewer registration.`);
    }
    if (request.qualification_id !== options.qualificationId) {
      throw new Error(`Review request #${request.id} is bound to qualification #${request.qualification_id}.`);
    }
    const qualification = findLiveReviewerQualification(
      db,
      swarmId,
      reviewer.id,
      now.getTime(),
      options,
      options.qualificationId
    );
    if (!qualification) {
      throw new Error(
        `Reviewer ${reviewer.name} qualification #${options.qualificationId} is expired, revoked, binary-drifted, or invocation-mismatched.`
      );
    }
    const task = getTask(db, swarmId, slug);
    if (!task || task.state !== 'awaiting_review') {
      throw new Error(`Task "${slug}" is not awaiting this typed review.`);
    }
    if (task.lease_epoch !== request.task_epoch) {
      throw new Error(`Task "${slug}" lease epoch moved after review request #${request.id}; verdict is stale.`);
    }
    const facts = assertReviewableSource(task);
    if (
      headSha !== request.head_sha ||
      treeSha !== request.tree_sha ||
      task.head_sha !== request.head_sha ||
      task.tree_sha !== request.tree_sha ||
      facts.head !== request.head_sha ||
      facts.tree !== request.tree_sha
    ) {
      throw new Error(
        `Typed verdict for task "${slug}" is not bound to the unchanged live request head/tree; ` +
        `requested ${request.head_sha}/${request.tree_sha}, live ${facts.head}/${facts.tree}.`
      );
    }
    const submittedAt = now.toISOString();
    const inserted = db.prepare(`
      INSERT INTO review_verdicts (
        swarm_id, task_id, request_id, task_epoch, reviewer_agent_id,
        qualification_id, verdict, head_sha, tree_sha, report_path,
        report_sha256, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      swarmId,
      slug,
      request.id,
      task.lease_epoch,
      reviewer.id,
      qualification.id,
      options.verdict,
      headSha,
      treeSha,
      reportPath,
      reportSha256,
      submittedAt
    );
    const verdictId = Number(inserted.lastInsertRowid);
    db.prepare(`
      UPDATE review_requests SET status = ?, resolved_at = ?
      WHERE swarm_id = ? AND id = ? AND status = 'pending'
    `).run(options.verdict === 'pass' ? 'passed' : 'blocked', submittedAt, swarmId, request.id);
    db.prepare(`
      UPDATE tasks SET state = 'active', updated_at = ? WHERE swarm_id = ? AND id = ?
    `).run(submittedAt, swarmId, slug);
    db.prepare(`
      INSERT INTO task_events (
        swarm_id, task_id, epoch, kind, actor, actor_agent_id, data, created_at
      ) VALUES (?, ?, ?, 'review_verdict', ?, ?, ?, ?)
    `).run(
      swarmId,
      slug,
      task.lease_epoch,
      reviewer.name,
      reviewer.id,
      JSON.stringify({
        verdict_id: verdictId,
        request_id: request.id,
        verdict: options.verdict,
        qualification_id: qualification.id,
        head_sha: headSha,
        tree_sha: treeSha,
        report_path: reportPath,
        report_sha256: reportSha256,
      }),
      submittedAt
    );
    return {
      id: verdictId,
      requestId: request.id,
      verdict: options.verdict,
      reportSha256,
      headSha,
      treeSha,
    };
  }) as ReviewVerdictResult;
}
