import type { SwarmDb } from './db.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getTask, validateTaskSlug, type Task } from './tasks.js';

interface TaskEventRow {
  id: number;
  epoch: number;
  kind: string;
  actor: string | null;
  data: string | null;
  created_at: string;
}

export interface HarnessReviewOptions {
  now?: Date;
  homeDir?: string;
}

export interface HarnessReviewResult {
  task: Task;
  briefPath: string;
  rendered: string;
  complete: boolean;
  exitCode: 0 | 2;
}

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function oneLine(value: string, limit: number = 200): string {
  const flattened = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flattened.length <= limit ? flattened : `${flattened.slice(0, limit - 1)}…`;
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

function valueSummary(value: unknown): string {
  if (typeof value === 'string') return oneLine(value, 80);
  return oneLine(JSON.stringify(value), 80);
}

function dataSummary(row: TaskEventRow): string {
  const parsed = eventData(row.data);
  if (!parsed) return row.data ? oneLine(row.data) : '-';
  const entries = Object.entries(parsed).map(([key, value]) => `${key}=${valueSummary(value)}`);
  return entries.length > 0 ? oneLine(entries.join(', ')) : '{}';
}

function checkpointLine(row: TaskEventRow): string {
  const data = eventData(row.data);
  const sequence = Number(data?.sequence);
  const label = Number.isFinite(sequence) && sequence > 0
    ? `#${String(sequence).padStart(3, '0')}`
    : `event #${row.id}`;
  return `- ${label} | ${row.created_at} | ${row.actor ?? 'system'} | ${String(data?.path ?? 'path not recorded')}`;
}

function evidenceLine(row: TaskEventRow): string {
  const data = eventData(row.data);
  if (row.kind === 'close_evidence') {
    return `- #${row.id} | ${String(data?.kind ?? 'unknown')}:${String(data?.ref ?? 'unknown')} | ` +
      `verified=${String(data?.verified ?? false)}`;
  }
  return `- #${row.id} | run | ${String(data?.logPath ?? 'log not recorded')} | ` +
    `exit=${String(data?.exit ?? 'unknown')}`;
}

function eventRows(db: SwarmDb, task: Task): TaskEventRow[] {
  return db.prepare(`
    SELECT id, epoch, kind, actor, data, created_at
    FROM task_events
    WHERE swarm_id = ? AND task_id = ?
    ORDER BY id ASC
  `).all(task.swarm_id, task.id) as unknown as TaskEventRow[];
}

export function renderHarnessReview(task: Task, events: TaskEventRow[]): string {
  const timeline = events.length > 0
    ? events.map(row => `- ${row.created_at} | ${row.kind} | ${row.actor ?? 'system'} | ${dataSummary(row)}`)
    : ['- none recorded'];
  const checkpoints = events.filter(row => row.kind === 'checkpoint');
  const evidence = events.filter(row => row.kind === 'close_evidence' || row.kind === 'run');

  return `# harness review ${task.id}

## timeline
${timeline.join('\n')}

## checkpoints
${(checkpoints.length > 0 ? checkpoints.map(checkpointLine) : ['- none recorded']).join('\n')}

## evidence
${(evidence.length > 0 ? evidence.map(evidenceLine) : ['- none recorded']).join('\n')}
`;
}

function skeleton(rendered: string): string {
  return `${rendered}
## earliest failed handoff
<FILL>

## smallest reversible intervention
<FILL>

## owning boundary (CLI refusal | census | hook | doctrine)
<FILL>

## EXP entry + rerun verdict (retain|revise|remove)
<FILL>
`;
}

export function harnessReviewTask(
  db: SwarmDb,
  swarmId: string,
  slug: string,
  options: HarnessReviewOptions = {}
): HarnessReviewResult {
  validateTaskSlug(slug);
  const task = getTask(db, swarmId, slug);
  if (!task) throw new Error(`Task "${slug}" not found in this swarm.`);

  const rendered = renderHarnessReview(task, eventRows(db, task));
  const now = options.now ?? new Date();
  const briefDir = path.join(options.homeDir ?? os.homedir(), '.swarm', 'briefs', 'harness-reviews');
  fs.mkdirSync(briefDir, { recursive: true });
  const briefPath = path.join(briefDir, `${slug}--${dateStamp(now)}.md`);
  if (!fs.existsSync(briefPath)) fs.writeFileSync(briefPath, skeleton(rendered), 'utf-8');

  const complete = !fs.readFileSync(briefPath, 'utf-8').includes('<FILL>');
  return { task, briefPath, rendered, complete, exitCode: complete ? 0 : 2 };
}
