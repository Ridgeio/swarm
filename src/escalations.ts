import { withImmediateTransaction, type SwarmDb } from './db.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sendMessage } from './mailbox.js';
import { getAgent, listAgents } from './registry.js';
import { getTask, taskGitFacts, validateTaskSlug, type Task } from './tasks.js';

const RECENT_EVENT_LIMIT = 12;

interface TaskEventRow {
  id: number;
  epoch: number;
  kind: string;
  actor: string | null;
  data: string | null;
  created_at: string;
}

export interface EscalateOptions {
  question?: string;
  to?: string;
  now?: Date;
  /** Test/integration override; production packets always use os.homedir(). */
  homeDir?: string;
}

export interface EscalationResult {
  task: Task;
  briefPath: string;
  question: string;
  recipient: string | null;
  messageId: number | null;
}

function minuteStamp(date: Date): string {
  const digits = date.toISOString().replace(/[-:]/g, '');
  return `${digits.slice(0, 8)}-${digits.slice(9, 13)}`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function eventData(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function latestCheckpoint(
  db: SwarmDb,
  task: Task
): { path: string | null; body: string | null } {
  const row = db.prepare(`
    SELECT data FROM task_events
    WHERE swarm_id = ? AND task_id = ? AND kind = 'checkpoint'
    ORDER BY id DESC LIMIT 1
  `).get(task.swarm_id, task.id) as { data: string | null } | undefined;
  const parsed = eventData(row?.data ?? null);
  const checkpointPath = typeof parsed?.path === 'string' ? parsed.path : null;
  if (!checkpointPath) return { path: null, body: null };
  try {
    return { path: checkpointPath, body: fs.readFileSync(checkpointPath, 'utf-8') };
  } catch {
    return { path: checkpointPath, body: null };
  }
}

function sectionBody(contents: string, heading: string): string[] {
  const lines = contents.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start === -1) return [];
  const found: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith('## ')) break;
    if (lines[index].trim()) found.push(lines[index].trim());
  }
  return found;
}

function substantiveBlockers(contents: string | null): string | null {
  if (!contents) return null;
  const blockers = sectionBody(contents, 'blockers / landmines')
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(line => {
      const normalized = line.toLowerCase();
      return line.length > 0 && !line.includes('<FILL>') &&
        !['none', 'none noted', 'n/a', 'not recorded'].includes(normalized);
    });
  return blockers.length > 0 ? blockers.join(' ') : null;
}

function resolveQuestion(task: Task, explicit: string | undefined, checkpointBody: string | null): string {
  const question = explicit?.trim() || substantiveBlockers(checkpointBody);
  if (!question) {
    throw new Error(
      `Cannot escalate task "${task.id}": no question was provided and the latest checkpoint has no substantive blockers. ` +
      `Re-run with swarm escalate ${task.id} --question "<text>". See docs/ROUTING.md for the escalation path.`
    );
  }
  return question;
}

function evidenceLines(db: SwarmDb, task: Task): string[] {
  const rows = db.prepare(`
    SELECT id, kind, data, created_at
    FROM task_events
    WHERE swarm_id = ? AND task_id = ? AND kind IN ('close_evidence', 'run')
    ORDER BY id ASC
  `).all(task.swarm_id, task.id) as Array<{
    id: number;
    kind: string;
    data: string | null;
    created_at: string;
  }>;
  if (rows.length === 0) return ['- none recorded'];
  return rows.map(row => {
    const data = eventData(row.data);
    if (row.kind === 'close_evidence') {
      return `- #${row.id} ${String(data?.kind ?? 'unknown')}:${String(data?.ref ?? 'unknown')} ` +
        `[verified: ${String(data?.verified ?? false)}]`;
    }
    return `- #${row.id} run ${String(data?.logPath ?? 'log not recorded')} ` +
      `[exit: ${String(data?.exit ?? 'unknown')}]`;
  });
}

function recentEventLines(db: SwarmDb, task: Task): string[] {
  const rows = db.prepare(`
    SELECT id, epoch, kind, actor, data, created_at
    FROM (
      SELECT id, epoch, kind, actor, data, created_at
      FROM task_events
      WHERE swarm_id = ? AND task_id = ?
      ORDER BY id DESC LIMIT ?
    ) recent
    ORDER BY id ASC
  `).all(task.swarm_id, task.id, RECENT_EVENT_LIMIT) as unknown as TaskEventRow[];
  if (rows.length === 0) return ['- none recorded'];
  return rows.map(row => {
    const data = row.data ? ` — ${oneLine(row.data)}` : '';
    return `- #${row.id} ${row.created_at} ${row.kind} by ${row.actor ?? 'system'} @${row.epoch}${data}`;
  });
}

function riskLine(task: Task): string {
  if (!task.repo_path) {
    return '- Risk: no repository is attached; Git state cannot corroborate this request.';
  }
  const facts = taskGitFacts(task);
  if (facts.unpushed.length || facts.dirtyTracked || facts.untracked) {
    return `- Risk: ${facts.unpushed.length} unpushed commit(s), ${facts.dirtyTracked} dirty tracked file(s), ` +
      `and ${facts.untracked} untracked file(s).`;
  }
  return '- Risk: no unpushed commits, dirty tracked files, or untracked files were detected.';
}

function packetBody(
  db: SwarmDb,
  task: Task,
  checkpoint: { path: string | null; body: string | null },
  question: string
): string {
  const facts = taskGitFacts(task);
  const unpushed = facts.unpushed.length > 0
    ? facts.unpushed.map(line => `  - ${line}`).join('\n')
    : '  - none';
  const checkpointText = checkpoint.body ??
    (checkpoint.path ? `[checkpoint unreadable: ${checkpoint.path}]` : '[no checkpoint recorded]');
  return `# escalation ${task.id}

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

## recent events
${recentEventLines(db, task).join('\n')}

## risk
${riskLine(task)}

## THE question
${question}
`;
}

export async function escalateTask(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  slug: string,
  options: EscalateOptions = {}
): Promise<EscalationResult> {
  validateTaskSlug(slug);
  const task = getTask(db, swarmId, slug);
  if (!task) throw new Error(`Task "${slug}" not found in this swarm.`);
  const checkpoint = latestCheckpoint(db, task);
  const question = resolveQuestion(task, options.question, checkpoint.body);

  let recipient: string | null = null;
  if (options.to) {
    const target = getAgent(db, swarmId, options.to);
    if (!target) throw new Error(`Agent "${options.to}" not found in this swarm. Run "swarm members" and retry --to.`);
    recipient = target.name;
  } else {
    const agents = await listAgents(db, swarmId);
    recipient = agents[0]?.name ?? null;
  }

  const now = options.now ?? new Date();
  const briefDir = path.join(options.homeDir ?? os.homedir(), '.swarm', 'briefs', 'escalations');
  fs.mkdirSync(briefDir, { recursive: true });
  const briefPath = path.join(briefDir, `${slug}--${minuteStamp(now)}.md`);
  fs.writeFileSync(briefPath, packetBody(db, task, checkpoint, question), 'utf-8');

  const updated = withImmediateTransaction(db, () => {
    const current = getTask(db, swarmId, slug);
    if (!current) throw new Error(`Task "${slug}" not found in this swarm.`);
    const createdAt = now.toISOString();
    db.prepare(`
      UPDATE tasks SET state = 'awaiting_review', updated_at = ?
      WHERE swarm_id = ? AND id = ?
    `).run(createdAt, swarmId, slug);
    db.prepare(`
      INSERT INTO task_events (swarm_id, task_id, epoch, kind, actor, data, created_at)
      VALUES (?, ?, ?, 'escalated', ?, ?, ?)
    `).run(swarmId, slug, current.lease_epoch, actor, JSON.stringify({
      brief_path: briefPath,
      question,
      to: recipient,
    }), createdAt);
    return getTask(db, swarmId, slug)!;
  }) as Task;

  let messageId: number | null = null;
  if (recipient) {
    const delivery = await sendMessage(db, swarmId, actor, recipient, briefPath, undefined, 'escalation');
    if (!delivery.delivered && !delivery.queued) {
      throw new Error(`Escalation packet was written to ${briefPath}, but pointer delivery failed: ${delivery.message}`);
    }
    messageId = delivery.messageId ?? null;
  }
  return { task: updated, briefPath, question, recipient, messageId };
}
