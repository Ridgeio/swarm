import type Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import { CHECKPOINT_STALE_MINUTES } from './tasks.js';
import {
  JANITOR_HEARTBEAT_STALE_MS,
  type JanitorCounters,
} from './janitor.js';

const URGENT_MESSAGE_KINDS = ['gate', 'escalation', 'merge-req'] as const;
export const BOARD_DEFAULT_WATCH_SECONDS = 5;

interface BoardTask {
  id: string;
  state: string;
  owner_agent: string | null;
  lease_epoch: number;
  repo_path: string | null;
  branch: string | null;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
}

interface CheckpointEvent {
  id: number;
  created_at: string;
  data: string | null;
}

interface AgentRow {
  name: string;
  agent_type: string;
  host_agent: string | null;
}

interface JanitorRow {
  last_tick_at: string;
  counters: string;
}

export interface BoardRenderOptions {
  now?: number;
}

export interface BoardWatchOptions {
  render: () => string;
  intervalMs?: number;
  clear?: () => void;
  write?: (value: string) => void;
  wait?: (milliseconds: number) => Promise<void>;
  shouldContinue?: (renderCount: number) => boolean;
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  swarms: ['id', 'name', 'root_path'],
  agents: ['swarm_id', 'name', 'surface_id', 'joined_at', 'agent_type', 'host_agent'],
  messages: ['id', 'swarm_id', 'from_agent', 'body', 'kind', 'superseded_by'],
  message_deliveries: ['message_id', 'swarm_id', 'recipient', 'status', 'acked_at'],
  tasks: [
    'id', 'swarm_id', 'state', 'owner_agent', 'lease_epoch', 'repo_path',
    'branch', 'worktree_path', 'created_at', 'updated_at',
  ],
  task_events: ['id', 'swarm_id', 'task_id', 'kind', 'actor', 'data', 'created_at'],
  janitor_status: ['last_tick_at', 'counters'],
};

function tableColumns(db: Database.Database, table: string): Set<string> | null {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) return null;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map(row => row.name));
}

function hasSchema(db: Database.Database | null, tables: string[]): db is Database.Database {
  if (!db) return false;
  return tables.every(table => {
    const columns = tableColumns(db, table);
    return columns !== null && REQUIRED_COLUMNS[table].every(column => columns.has(column));
  });
}

export function boardHasTable(db: Database.Database | null, table: string): boolean {
  if (!db) return false;
  const columns = tableColumns(db, table);
  const required = REQUIRED_COLUMNS[table] ?? [];
  return columns !== null && required.every(column => columns.has(column));
}

function oneLine(value: string, limit: number = 100): string {
  const flattened = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (flattened.length <= limit) return flattened;
  return `${flattened.slice(0, Math.max(0, limit - 1))}\u2026`;
}

function ageMinutes(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now - timestamp) / 60_000));
}

function ageLabel(iso: string | null | undefined, now: number): string {
  const age = ageMinutes(iso, now);
  return age === null ? 'none' : `${age}m`;
}

function section(title: string, lines: string[]): string {
  const rows = lines.length > 0 ? lines : ['not available'];
  const innerWidth = Math.max(title.length + 3, 20, ...rows.map(row => row.length + 2));
  const top = `\u250c\u2500 ${title} ${'\u2500'.repeat(Math.max(1, innerWidth - title.length - 3))}\u2510`;
  const body = rows.map(row => `\u2502 ${row.padEnd(innerWidth - 1)}\u2502`).join('\n');
  const bottom = `\u2514${'\u2500'.repeat(innerWidth)}\u2518`;
  return `${top}\n${body}\n${bottom}`;
}

function latestCheckpoint(
  db: Database.Database,
  swarmId: string,
  taskId: string
): CheckpointEvent | null {
  return db.prepare(`
    SELECT id, created_at, data
    FROM task_events
    WHERE swarm_id = ? AND task_id = ? AND kind = 'checkpoint'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(swarmId, taskId) as CheckpointEvent | undefined ?? null;
}

function checkpointPath(event: CheckpointEvent | null): string | null {
  if (!event?.data) return null;
  try {
    const parsed = JSON.parse(event.data) as { path?: unknown };
    return typeof parsed.path === 'string' ? parsed.path : null;
  } catch {
    return null;
  }
}

function readCheckpoint(event: CheckpointEvent | null): string | null {
  const filePath = checkpointPath(event);
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function sectionContents(contents: string, heading: string): string[] {
  const lines = contents.split(/\r?\n/);
  const index = lines.findIndex(line => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (index === -1) return [];
  const found: string[] = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor].trim();
    if (line.startsWith('## ')) break;
    if (line) found.push(line);
  }
  return found;
}

function nextAction(event: CheckpointEvent | null): string {
  const contents = readCheckpoint(event);
  if (!contents) return '(not recorded)';
  const lines = sectionContents(contents, 'next action');
  return lines.length > 0 ? oneLine(lines[0]) : '(not recorded)';
}

function readGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trimEnd();
  } catch {
    return null;
  }
}

function branchFacts(task: BoardTask): string {
  if (!task.branch) return '-';
  if (!task.repo_path) return `${task.branch} (push?/dirty?)`;
  const cwd = task.worktree_path && fs.existsSync(task.worktree_path)
    ? task.worktree_path
    : task.repo_path;
  const status = readGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  const unpushed = readGit(task.repo_path, ['log', task.branch, '--not', '--remotes', '--oneline']);
  const dirty = status === null ? 'dirty?' : status.length > 0 ? 'dirty' : 'clean';
  const pushed = unpushed === null
    ? 'push?'
    : unpushed.length > 0 ? `unpushed:${unpushed.split('\n').filter(Boolean).length}` : 'pushed';
  return `${task.branch} (${pushed}/${dirty})`;
}

function renderNeedsYou(db: Database.Database | null, swarmId: string, now: number): string[] | null {
  if (!hasSchema(db, ['messages', 'message_deliveries', 'tasks', 'task_events', 'janitor_status'])) {
    return null;
  }

  const lines: string[] = [];
  const deliveries = db.prepare(`
    SELECT m.id, m.kind, m.from_agent, m.body, d.recipient
    FROM message_deliveries d
    JOIN messages m ON m.id = d.message_id AND m.swarm_id = d.swarm_id
    WHERE d.swarm_id = ?
      AND d.acked_at IS NULL
      AND d.status <> 'acked'
      AND m.superseded_by IS NULL
      AND m.kind IN (${URGENT_MESSAGE_KINDS.map(() => '?').join(', ')})
    ORDER BY m.id ASC, d.recipient COLLATE NOCASE ASC
  `).all(swarmId, ...URGENT_MESSAGE_KINDS) as Array<{
    id: number;
    kind: string;
    from_agent: string;
    body: string;
    recipient: string;
  }>;
  for (const delivery of deliveries) {
    lines.push(
      `message #${delivery.id} [${delivery.kind}] for ${delivery.recipient} from ${delivery.from_agent} \u2014 ` +
      oneLine(delivery.body, 70)
    );
  }

  const awaitingReview = db.prepare(`
    SELECT id, owner_agent, lease_epoch
    FROM tasks
    WHERE swarm_id = ? AND state = 'awaiting_review'
    ORDER BY updated_at ASC, id ASC
  `).all(swarmId) as Array<{ id: string; owner_agent: string | null; lease_epoch: number }>;
  for (const task of awaitingReview) {
    lines.push(`task ${task.id} awaits review \u2014 ${task.owner_agent ?? 'unowned'}(${task.lease_epoch})`);
  }

  const active = db.prepare(`
    SELECT id, state, owner_agent, lease_epoch, repo_path, branch, worktree_path, created_at, updated_at
    FROM tasks
    WHERE swarm_id = ? AND state = 'active'
    ORDER BY created_at ASC, id ASC
  `).all(swarmId) as BoardTask[];
  for (const task of active) {
    const checkpoint = latestCheckpoint(db, swarmId, task.id);
    const evidenceAt = checkpoint?.created_at ?? task.created_at;
    const age = ageMinutes(evidenceAt, now);
    if (age !== null && age > CHECKPOINT_STALE_MINUTES) {
      const evidence = checkpoint ? `checkpoint ${age}m ago` : `no checkpoint for ${age}m`;
      lines.push(`task ${task.id} stalled \u2014 ${evidence}`);
    }
  }

  const janitor = db.prepare('SELECT last_tick_at, counters FROM janitor_status WHERE id = 1')
    .get() as JanitorRow | undefined;
  if (janitor) {
    const tick = new Date(janitor.last_tick_at).getTime();
    if (Number.isFinite(tick) && now - tick > JANITOR_HEARTBEAT_STALE_MS) {
      lines.push(`janitor heartbeat stale \u2014 tick ${ageLabel(janitor.last_tick_at, now)} ago`);
    }
  }

  return lines.length > 0 ? lines : ['nothing needs you'];
}

function renderTasks(db: Database.Database | null, swarmId: string, now: number): string[] | null {
  if (!hasSchema(db, ['tasks', 'task_events', 'agents'])) return null;
  const tasks = db.prepare(`
    SELECT id, state, owner_agent, lease_epoch, repo_path, branch, worktree_path, created_at, updated_at
    FROM tasks
    WHERE swarm_id = ? AND state <> 'done'
    ORDER BY
      CASE state WHEN 'awaiting_review' THEN 0 WHEN 'active' THEN 1 WHEN 'open' THEN 2 ELSE 3 END,
      updated_at ASC,
      id ASC
  `).all(swarmId) as BoardTask[];
  if (tasks.length === 0) return ['no non-done tasks'];

  return tasks.map(task => {
    const checkpoint = latestCheckpoint(db, swarmId, task.id);
    const owner = task.owner_agent ?? 'unowned';
    const agent = task.owner_agent
      ? db.prepare(`
          SELECT name, agent_type, host_agent FROM agents
          WHERE swarm_id = ? AND name = ? COLLATE NOCASE
        `).get(swarmId, task.owner_agent) as AgentRow | undefined
      : undefined;
    const host = agent?.host_agent ?? agent?.agent_type ?? 'unknown';
    return `${task.id} | ${task.state} | ${owner}(${task.lease_epoch}) | -/${host} | ` +
      `${checkpoint ? ageLabel(checkpoint.created_at, now) : 'none'} | ${branchFacts(task)} | ${nextAction(checkpoint)}`;
  });
}

function latestProgressAt(db: Database.Database, swarmId: string, agent: string): string | null {
  const taskEvidence = db.prepare(`
    SELECT
      MAX(CASE WHEN kind = 'checkpoint' THEN created_at END) AS checkpoint_at,
      MAX(created_at) AS event_at
    FROM task_events
    WHERE swarm_id = ? AND actor = ? COLLATE NOCASE
  `).get(swarmId, agent) as { checkpoint_at: string | null; event_at: string | null };
  const deliveryEvidence = db.prepare(`
    SELECT MAX(acked_at) AS acked_at
    FROM message_deliveries
    WHERE swarm_id = ? AND recipient = ? COLLATE NOCASE AND acked_at IS NOT NULL
  `).get(swarmId, agent) as { acked_at: string | null };
  const candidates = [taskEvidence.checkpoint_at, taskEvidence.event_at, deliveryEvidence.acked_at]
    .filter((value): value is string => value !== null)
    .map(value => ({ value, timestamp: new Date(value).getTime() }))
    .filter(entry => Number.isFinite(entry.timestamp));
  candidates.sort((left, right) => right.timestamp - left.timestamp);
  return candidates[0]?.value ?? null;
}

function renderFleet(db: Database.Database | null, swarmId: string, now: number): string[] | null {
  if (!hasSchema(db, ['agents', 'tasks', 'task_events', 'messages', 'message_deliveries'])) return null;
  const agents = db.prepare(`
    SELECT name, agent_type, host_agent
    FROM agents
    WHERE swarm_id = ?
    ORDER BY name COLLATE NOCASE ASC
  `).all(swarmId) as AgentRow[];
  if (agents.length === 0) return ['no registered agents'];

  return agents.map(agent => {
    const task = db.prepare(`
      SELECT id FROM tasks
      WHERE swarm_id = ? AND owner_agent = ? COLLATE NOCASE AND state <> 'done'
      ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'awaiting_review' THEN 1 ELSE 2 END,
               updated_at DESC, id ASC
      LIMIT 1
    `).get(swarmId, agent.name) as { id: string } | undefined;
    const unacked = db.prepare(`
      SELECT COUNT(*) AS count
      FROM message_deliveries d
      JOIN messages m ON m.id = d.message_id AND m.swarm_id = d.swarm_id
      WHERE d.swarm_id = ? AND d.recipient = ? COLLATE NOCASE
        AND d.acked_at IS NULL AND d.status <> 'acked' AND m.superseded_by IS NULL
    `).get(swarmId, agent.name) as { count: number };
    const host = agent.host_agent ?? agent.agent_type;
    return `${agent.name} | ${host} | ${task?.id ?? '-'} | progress ${ageLabel(latestProgressAt(db, swarmId, agent.name), now)} | ` +
      `${unacked.count} unacked`;
  });
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

function parseCounters(raw: string): JanitorCounters {
  const counters = emptyCounters();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(counters) as Array<keyof JanitorCounters>) {
      if (typeof parsed[key] === 'number' && Number.isFinite(parsed[key])) {
        counters[key] = parsed[key];
      }
    }
  } catch {
    // Malformed historical counters degrade to zeroes; the heartbeat still renders.
  }
  return counters;
}

function quotaLine(db: Database.Database, swarmId: string): string {
  const event = db.prepare(`
    SELECT e.id, e.created_at, e.data
    FROM task_events e
    JOIN tasks t ON t.swarm_id = e.swarm_id AND t.id = e.task_id
    WHERE e.swarm_id = ? AND substr(t.id, 1, 8) = 'program-' AND e.kind = 'checkpoint'
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT 1
  `).get(swarmId) as CheckpointEvent | undefined;
  const contents = readCheckpoint(event ?? null);
  if (!contents) return 'quota: not recorded';
  const quota = sectionContents(contents, 'quota')
    .map(line => line.replace(/^[-*]\s*/, ''))
    .filter(Boolean);
  return quota.length > 0 ? `quota: ${oneLine(quota.join(' | '), 140)}` : 'quota: not recorded';
}

function renderDebrisAndQuota(db: Database.Database | null, swarmId: string, now: number): string[] | null {
  if (!hasSchema(db, ['janitor_status', 'tasks', 'task_events'])) return null;
  const row = db.prepare('SELECT last_tick_at, counters FROM janitor_status WHERE id = 1')
    .get() as JanitorRow | undefined;
  const debris = row
    ? (() => {
        const counters = parseCounters(row.counters);
        return `debris: worktrees ${counters.worktrees} (${counters.detachedHeads} detached) | ` +
          `unpushed ${counters.unpushedCommits} | strays ${counters.tempStrays} | junk ${counters.junkDirs} | ` +
          `tick ${ageLabel(row.last_tick_at, now)} ago`;
      })()
    : 'debris: not recorded';
  return [debris, quotaLine(db, swarmId)];
}

/** Render one read-only snapshot. This function performs no database or file writes. */
export function renderBoard(
  db: Database.Database | null,
  swarmId: string,
  options: BoardRenderOptions = {}
): string {
  const now = options.now ?? Date.now();
  const needsYou = renderNeedsYou(db, swarmId, now);
  const tasks = renderTasks(db, swarmId, now);
  const fleet = renderFleet(db, swarmId, now);
  const debris = renderDebrisAndQuota(db, swarmId, now);
  return [
    section('NEEDS YOU', needsYou ?? ['not available']),
    section('TASKS', tasks ?? ['not available']),
    section('FLEET', fleet ?? ['not available']),
    section('DEBRIS + QUOTA', debris ?? ['not available']),
  ].join('\n');
}

/** Re-render until the injected exit condition fails (normally Ctrl-C exits the process). */
export async function watchBoard(options: BoardWatchOptions): Promise<number> {
  const intervalMs = options.intervalMs ?? BOARD_DEFAULT_WATCH_SECONDS * 1_000;
  const clear = options.clear ?? (() => process.stdout.write('\x1b[2J\x1b[H'));
  const write = options.write ?? (value => process.stdout.write(value));
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const shouldContinue = options.shouldContinue ?? (() => true);
  let renderCount = 0;

  while (shouldContinue(renderCount)) {
    clear();
    write(`${options.render()}\n`);
    renderCount += 1;
    if (!shouldContinue(renderCount)) break;
    await wait(intervalMs);
  }
  return renderCount;
}
