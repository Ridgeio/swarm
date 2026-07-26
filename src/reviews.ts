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

// Canonical definitions live in model-family.ts (shared with the registry); re-exported
// here so existing importers of these names keep working.
export {
  agentModelFamily,
  deriveModelFamily,
  MODEL_FAMILIES,
  MODEL_FAMILY_MAP,
  parseModelFamily,
  type ModelFamily,
} from './model-family.js';
import { agentModelFamily, deriveModelFamily, type ModelFamily } from './model-family.js';

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

/**
 * Candidates that actually PROVE inversion. An agent of unknown family is excluded:
 * "unknown !== claude" is true for the wrong reason — it says nothing about what the
 * agent is, only that we failed to find out. Counting it would let the cross-family
 * control be satisfied by a seat that may well be the same family as the author,
 * which is the one thing the control exists to prevent.
 */
function differentFamilyAgents(agents: Agent[], authorFamily: ModelFamily): Agent[] {
  return agents.filter(agent => {
    const family = agentModelFamily(agent);
    return family !== 'unknown' && family !== authorFamily;
  });
}

function unknownFamilyAgents(agents: Agent[]): Agent[] {
  return agents.filter(agent => agentModelFamily(agent) === 'unknown');
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

/**
 * How to make a specific agent's family known. An A2A agent re-registers with its
 * endpoint; a local agent has no such command — telling it to run `register-a2a` would
 * either fail on the missing --endpoint or convert a live local seat into an A2A row.
 */
function declareFamilyHint(agent: Agent): string {
  if (agent.agent_type === 'a2a') {
    return `re-register it with a declared family: swarm register-a2a ${agent.name} ` +
      `--endpoint ${agent.endpoint_url ?? '<url>'} --family <claude|openai|xai|google> --force`;
  }
  return `have "${agent.name}" rejoin from a terminal whose harness is detected ` +
    `(swarm join ${agent.name}) so its family is recorded`;
}

function unknownFamilyRefusal(
  slug: string,
  reviewer: Agent,
  alternatives: Agent[]
): string {
  const names = alternatives.length > 0
    ? alternatives.map(agent => agent.name).join(', ')
    : 'none currently live';
  return `Refused review for task "${slug}" with reviewer "${reviewer.name}": its model family is UNKNOWN, ` +
    `so routing to it would not establish inversion — it may be the same family as the author. ` +
    `To fix, ${declareFamilyHint(reviewer)}; or pick a known different-family reviewer (${names}); ` +
    `or audit the exception with --to ${reviewer.name} --same-family-ok --reason "<text>".`;
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
  const authorFamily = author ? agentModelFamily(author) : 'unknown';
  const liveAgents = await listAgents(db, swarmId);
  const alternatives = differentFamilyAgents(liveAgents, authorFamily);
  const unknowns = unknownFamilyAgents(liveAgents);
  let reviewer: Agent;
  // Which refusal --same-family-ok actually suppressed; null when nothing was bypassed.
  // EVERY bypassed gate is recorded. A single slot let a later gate overwrite an earlier
  // one, so an override that tripped both unknown gates was filed under one name.
  const overriddenGates: Array<'same-family' | 'unknown-reviewer' | 'unknown-author'> = [];

  // An unknown AUTHOR family makes inversion unprovable in the other direction too:
  // "different from unknown" is not a statement about anything.
  if (authorFamily === 'unknown' && options.sameFamilyOk) {
    overriddenGates.push('unknown-author');
  }
  if (authorFamily === 'unknown' && !options.sameFamilyOk) {
    throw new Error(
      `Cannot establish model inversion for task "${slug}": the author's model family is UNKNOWN` +
      `${author ? ` ("${author.name}" declares no family and has no detected harness)` : ' (no owner recorded)'}. ` +
      `${author ? `To fix, ${declareFamilyHint(author)}; or ` : ''}` +
      `audit the exception with --to <agent> --same-family-ok --reason "<text>".`
    );
  }

  if (options.to) {
    const target = liveAgents.find(agent => sameName(agent.name, options.to!));
    if (!target) {
      throw new Error(`Reviewer "${options.to}" is not live in this swarm. Run "swarm members", then retry --to or spawn a reviewer.`);
    }
    const reviewerFamily = agentModelFamily(target);
    // Unknown is refused as loudly as same-family: an unverified inversion recorded as
    // satisfied is worse than no review, because it stops anyone looking for a real one.
    if (reviewerFamily === 'unknown') {
      if (!options.sameFamilyOk) throw new Error(unknownFamilyRefusal(slug, target, alternatives));
      overriddenGates.push('unknown-reviewer');
    }
    // `unknown === unknown` is NOT same-family — it is two things nobody measured, and
    // recording it as family equality would assert a fact never established. That is the
    // same "true for the wrong reason" error this whole change exists to remove, so it
    // must not be reintroduced in the audit trail itself.
    if (reviewerFamily !== 'unknown' && reviewerFamily === authorFamily) {
      if (!options.sameFamilyOk) throw new Error(sameFamilyRefusal(slug, target, alternatives));
      overriddenGates.push('same-family');
    }
    reviewer = target;
  } else {
    if (alternatives.length === 0) {
      const unknownNote = unknowns.length > 0
        ? ` ${unknowns.length} live agent(s) have an UNKNOWN family and do not count: ` +
          `${unknowns.map(a => a.name).join(', ')} — declare with --family to make them eligible.`
        : '';
      throw new Error(
        `No live cross-family reviewer is available for task "${slug}" (author family: ${authorFamily}).` +
        `${unknownNote} Spawn a reviewer from a different model family, then re-run swarm review ${slug}.`
      );
    }
    const loads = openReviewLoads(db, swarmId);
    reviewer = alternatives.reduce((best, candidate) => {
      const bestLoad = loads.get(best.name.toLowerCase()) ?? 0;
      const candidateLoad = loads.get(candidate.name.toLowerCase()) ?? 0;
      return candidateLoad < bestLoad ? candidate : best;
    });
  }

  const reviewerFamily = agentModelFamily(reviewer);
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
    // Audit EVERY use of the override, not only the same-family one. Gating this on
    // family equality left the two unknown-family bypasses unrecorded: the ledger row
    // was byte-identical to a legitimate cross-family review and the mandatory --reason
    // was validated and then discarded, so an auditor counting exceptions saw zero while
    // the control had in fact been bypassed. Kind stays `same_family_review` so existing
    // auditors keep matching; `gate` says which refusal was overridden.
    if (overriddenGates.length > 0) {
      db.prepare(`
        INSERT INTO task_events (swarm_id, task_id, epoch, kind, actor, data, created_at)
        VALUES (?, ?, ?, 'same_family_review', ?, ?, ?)
      `).run(swarmId, slug, current.lease_epoch, actor, JSON.stringify({
        // `gate` is kept alongside `gates` so existing auditors reading the scalar keep
        // working: promising compatibility and then changing the payload shape would
        // make them silently read undefined. `gates` is the complete list.
        gate: overriddenGates[0],
        gates: overriddenGates,
        reviewer: reviewer.name,
        reviewer_family: reviewerFamily,
        author_family: authorFamily,
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
