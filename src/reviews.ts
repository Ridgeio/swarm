import { withImmediateTransaction, type SwarmDb } from './db.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { evidenceLines, latestCheckpoint } from './escalations.js';
import { sendMessage } from './mailbox.js';
import { getAgent, listAgents, type Agent } from './registry.js';
import {
  getTask,
  requireTaskAuthority,
  taskGitFacts,
  validateTaskSlug,
  type Task,
} from './tasks.js';

export type ModelFamily = 'claude' | 'openai' | 'xai' | 'google' | 'unknown';

export const MODEL_FAMILY_MAP: Readonly<Record<string, ModelFamily>> = Object.freeze({
  'claude-code': 'claude',
  codex: 'openai',
  grok: 'xai',
  gemini: 'google',
});

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
}

export function deriveModelFamily(hostAgent: string | null | undefined): ModelFamily {
  return hostAgent ? MODEL_FAMILY_MAP[hostAgent] ?? 'unknown' : 'unknown';
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
  authorFamily: ModelFamily
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

## latest checkpoint (verbatim)
${checkpointText}

## evidence
${evidenceLines(db, task).join('\n')}

## git facts
- repo: ${task.repo_path ?? 'none'}
- branch: ${facts.branch}
- head: ${facts.head}
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
  const author = task.owner_agent ? getAgent(db, swarmId, task.owner_agent) : null;
  const authorFamily = deriveModelFamily(author?.host_agent);
  const liveAgents = await listAgents(db, swarmId);
  const alternatives = differentFamilyAgents(liveAgents, authorFamily);
  let reviewer: Agent;

  if (options.to) {
    const target = liveAgents.find(agent => sameName(agent.name, options.to!));
    if (!target) {
      throw new Error(`Reviewer "${options.to}" is not live in this swarm. Run "swarm members", then retry --to or spawn a reviewer.`);
    }
    const reviewerFamily = deriveModelFamily(target.host_agent);
    if (reviewerFamily === authorFamily && !options.sameFamilyOk) {
      throw new Error(sameFamilyRefusal(slug, target, alternatives));
    }
    reviewer = target;
  } else {
    if (alternatives.length === 0) {
      throw new Error(
        `No live cross-family reviewer is available for task "${slug}" (author family: ${authorFamily}). ` +
        `Spawn a reviewer from a different model family, then re-run swarm review ${slug}.`
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
  const now = options.now ?? new Date();
  const briefDir = path.join(options.homeDir ?? os.homedir(), '.swarm', 'briefs', 'reviews');
  fs.mkdirSync(briefDir, { recursive: true });
  const briefPath = path.join(briefDir, `${slug}--${minuteStamp(now)}.md`);
  fs.writeFileSync(briefPath, reviewBody(db, task, authorFamily), 'utf-8');

  // Recheck the original lease epoch immediately before the state/event mutation.
  requireTaskAuthority(db, swarmId, slug, actor, 'review', authority.epoch);
  const updated = withImmediateTransaction(db, () => {
    const current = getTask(db, swarmId, slug);
    if (!current || !sameName(current.owner_agent, actor) || current.lease_epoch !== authority.epoch) {
      throw new Error(`Task "${slug}" authority changed while the review brief was being prepared. Re-run swarm review ${slug}.`);
    }
    const createdAt = now.toISOString();
    db.prepare(`
      UPDATE tasks SET state = 'awaiting_review', updated_at = ?
      WHERE swarm_id = ? AND id = ?
    `).run(createdAt, swarmId, slug);
    if (reviewerFamily === authorFamily && options.sameFamilyOk) {
      db.prepare(`
        INSERT INTO task_events (swarm_id, task_id, epoch, kind, actor, data, created_at)
        VALUES (?, ?, ?, 'same_family_review', ?, ?, ?)
      `).run(swarmId, slug, current.lease_epoch, actor, JSON.stringify({
        reviewer: reviewer.name,
        reviewer_family: reviewerFamily,
        reason: options.reason!.trim(),
      }), createdAt);
    }
    db.prepare(`
      INSERT INTO task_events (swarm_id, task_id, epoch, kind, actor, data, created_at)
      VALUES (?, ?, ?, 'review_requested', ?, ?, ?)
    `).run(swarmId, slug, current.lease_epoch, actor, JSON.stringify({
      author_family: authorFamily,
      reviewer: reviewer.name,
      reviewer_family: reviewerFamily,
      brief_path: briefPath,
    }), createdAt);
    return getTask(db, swarmId, slug)!;
  }) as Task;

  const delivery = await sendMessage(db, swarmId, actor, reviewer.name, briefPath, undefined, 'gate');
  if (!delivery.delivered && !delivery.queued) {
    throw new Error(`Review brief was written to ${briefPath}, but pointer delivery failed: ${delivery.message}`);
  }
  return {
    task: updated,
    briefPath,
    reviewer: reviewer.name,
    authorFamily,
    reviewerFamily,
    messageId: delivery.messageId ?? null,
  };
}
