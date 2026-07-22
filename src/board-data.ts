import type { SwarmDb } from './db.js';
import { execFileSync } from 'child_process';
import fs from 'fs';
import {
  CHECKPOINT_STALE_MINUTES,
  effectiveClaimKind,
  type ClaimKind,
  type EvidenceVerification,
} from './tasks.js';
import {
  JANITOR_HEARTBEAT_STALE_MS,
  type JanitorCounters,
} from './janitor.js';

const URGENT_MESSAGE_KINDS = ['gate', 'escalation', 'merge-req'] as const;
const RECENT_DONE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const TIMELINE_LIMIT = 200;
const DEBRIS_TREND_LIMIT = 50;
const GRANT_EXPIRY_SOON_MS = 15 * 60_000;

const REQUIRED_COLUMNS: Record<string, string[]> = {
  swarms: ['id', 'name', 'root_path'],
  agents: [
    'swarm_id', 'name', 'surface_id', 'joined_at', 'last_heartbeat', 'agent_type', 'host_agent',
  ],
  messages: [
    'id', 'swarm_id', 'from_agent', 'body', 'kind', 'superseded_by', 'created_at',
  ],
  message_deliveries: [
    'message_id', 'swarm_id', 'recipient', 'status', 'first_injected_at', 'acked_at',
  ],
  tasks: [
    'id', 'swarm_id', 'title', 'state', 'owner_agent', 'lease_epoch', 'repo_path',
    'branch', 'worktree_path', 'created_at', 'updated_at',
  ],
  task_events: [
    'id', 'swarm_id', 'task_id', 'epoch', 'kind', 'actor', 'data', 'created_at',
  ],
  grants: [
    'id', 'swarm_id', 'op', 'resource', 'granted_to', 'granted_by', 'expires_at', 'revoked_at',
  ],
  janitor_status: ['id', 'last_tick_at', 'counters'],
  janitor_findings: [
    'first_seen_at', 'last_seen_at', 'kind', 'path', 'detail', 'state',
  ],
  janitor_snapshots: ['id', 'tick_at', 'counters'],
};

const BOARD_TABLES = Object.keys(REQUIRED_COLUMNS);

interface RawTask {
  id: string;
  title: string;
  state: string;
  owner_agent: string | null;
  lease_epoch: number;
  repo_path: string | null;
  branch: string | null;
  worktree_path: string | null;
  claim_kind: ClaimKind | null;
  created_at: string;
  updated_at: string;
}

interface RawTaskEvent {
  id: number;
  task_id: string;
  epoch: number;
  kind: string;
  actor: string | null;
  data: string | null;
  created_at: string;
}

interface RawCheckpoint {
  id: number;
  created_at: string;
  data: string | null;
}

interface RawJanitorStatus {
  last_tick_at: string;
  counters: string;
}

export interface BoardAgentData {
  name: string;
  agentType: string;
  host: string;
  joinedAt: string;
  lastHeartbeat: string;
  surfaceKnown: boolean;
  currentTaskId: string | null;
  progressEvidenceAt: string | null;
  unackedCount: number;
  unackedMaxAgeMin: number | null;
}

export interface BoardCheckpointData {
  seq: number;
  ageMin: number;
  nextAction: string;
  path: string | null;
}

export interface BoardGitData {
  dirty: boolean;
  untracked: number;
  unpushed: number;
}

export interface BoardCloseEvidenceData {
  kind: string;
  ref: string;
  verified: EvidenceVerification;
}

export interface BoardGateOverrideData {
  eventId: number;
  reason: string;
  bypassedGates: string[];
  actor: string | null;
  at: string;
}

export interface BoardGrantUsageData {
  eventId: number;
  grantId: number | null;
  op: string;
  resource: string;
  actor: string | null;
  at: string;
}

export interface BoardTaskData {
  id: string;
  title: string;
  state: string;
  owner: string | null;
  leaseEpoch: number;
  repoPath: string | null;
  branch: string | null;
  worktreePath: string | null;
  claimKind: ClaimKind;
  evidence: BoardCloseEvidenceData[];
  notEstablished: string | null;
  overrides: BoardGateOverrideData[];
  grantUsage: BoardGrantUsageData[];
  createdAt: string;
  checkpoint: BoardCheckpointData | null;
  stale: boolean;
  git: BoardGitData | null;
}

export interface BoardOwnershipEdge {
  agent: string;
  taskId: string;
}

export interface BoardAgentEdge {
  from: string;
  to: string;
  taskId: string;
  at: string;
}

export interface BoardNeedData {
  kind: string;
  label: string;
  refId: string;
  /** Typed navigation target — the board jumps here on activation. */
  target: { kind: 'agent' | 'task'; id: string } | null;
  /** When the underlying condition arose, when knowable. */
  at: string | null;
}

export interface BoardDebrisFinding {
  kind: string;
  path: string;
  state: string;
  firstSeenAt: string;
  lastSeenAt: string;
  detail: unknown;
}

export interface BoardTimelineEvent {
  /** task_events rowid — the client's since-you-left high-water mark. */
  id: number;
  taskId: string;
  epoch: number;
  kind: string;
  actor: string | null;
  at: string;
  summary: string;
}

export interface BoardDebrisTrendPoint {
  tickAt: string;
  counters: JanitorCounters;
}

export interface BoardData {
  generatedAt: string;
  swarm: { id: string; name: string };
  agents: BoardAgentData[];
  tasks: BoardTaskData[];
  edges: {
    ownership: BoardOwnershipEdge[];
    handoffs: BoardAgentEdge[];
    claims: BoardAgentEdge[];
  };
  needsYou: BoardNeedData[];
  debris: {
    tickAgeMin: number | null;
    counters: JanitorCounters;
    findings: BoardDebrisFinding[];
  };
  debrisTrend?: BoardDebrisTrendPoint[];
  timeline: BoardTimelineEvent[];
  quota: string | null;
  unavailable: string[];
}

export interface CollectBoardDataOptions {
  now?: number;
}

function tableColumns(db: SwarmDb, table: string): Set<string> | null {
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!exists) return null;
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map(row => row.name));
  } catch {
    return null;
  }
}

export function boardHasTable(db: SwarmDb | null, table: string): boolean {
  if (!db) return false;
  const columns = tableColumns(db, table);
  const required = REQUIRED_COLUMNS[table] ?? [];
  return columns !== null && required.every(column => columns.has(column));
}

export function boardAgeMinutes(
  iso: string | null | undefined,
  now: number
): number | null {
  if (!iso) return null;
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now - timestamp) / 60_000));
}

export function boardAgeLabel(
  iso: string | null | undefined,
  now: number
): string {
  const age = boardAgeMinutes(iso, now);
  return age === null ? 'none' : `${age}m`;
}

function flattenLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function oneLine(value: string, limit: number = 100): string {
  const flattened = flattenLine(value);
  if (flattened.length <= limit) return flattened;
  return `${flattened.slice(0, Math.max(0, limit - 1))}\u2026`;
}

export function emptyBoardCounters(): JanitorCounters {
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
  const counters = emptyBoardCounters();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(counters) as Array<keyof JanitorCounters>) {
      if (typeof parsed[key] === 'number' && Number.isFinite(parsed[key])) {
        counters[key] = parsed[key];
      }
    }
  } catch {
    // Historical malformed counters still have a useful heartbeat timestamp.
  }
  return counters;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
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

function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function readCheckpoint(path: string | null): string | null {
  if (!path) return null;
  try {
    return fs.readFileSync(path, 'utf-8');
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

function checkpointNextAction(path: string | null): string {
  const contents = readCheckpoint(path);
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

function taskGit(task: RawTask): BoardGitData | null {
  if (!task.branch || !task.repo_path) return null;
  const cwd = task.worktree_path && fs.existsSync(task.worktree_path)
    ? task.worktree_path
    : task.repo_path;
  const status = readGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  const unpushed = readGit(task.repo_path, ['log', task.branch, '--not', '--remotes', '--oneline']);
  if (status === null || unpushed === null) return null;
  const statusLines = status.split('\n').filter(Boolean);
  const untrackedCount = statusLines.filter(line => line.startsWith('??')).length;
  return {
    dirty: statusLines.some(line => !line.startsWith('??')),
    untracked: untrackedCount,
    unpushed: unpushed.split('\n').filter(Boolean).length,
  };
}

function newestIso(values: Array<string | null | undefined>): string | null {
  const candidates = values
    .filter((value): value is string => value !== null && value !== undefined)
    .map(value => ({ value, timestamp: new Date(value).getTime() }))
    .filter(entry => Number.isFinite(entry.timestamp))
    .sort((left, right) => right.timestamp - left.timestamp);
  return candidates[0]?.value ?? null;
}

function eventSummary(event: RawTaskEvent): string {
  if (!event.data) return event.kind;
  const parsed = parseJsonValue(event.data);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return oneLine(String(parsed), 160) || event.kind;
  }
  const details = Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
    const printable = typeof value === 'string' ? value : JSON.stringify(value);
    return `${key}=${printable ?? String(value)}`;
  });
  return oneLine(details.join(' \u00b7 '), 160) || event.kind;
}

function addUnavailable(unavailable: Set<string>, ...tables: string[]): void {
  for (const table of tables) unavailable.add(table);
}

/**
 * Build the shared, deterministic board projection. The supplied connection is
 * only queried; database writes and migrations are deliberately out of scope.
 */
export function collectBoardData(
  db: SwarmDb | null,
  swarmId: string,
  options: CollectBoardDataOptions = {}
): BoardData {
  const requestedNow = options.now ?? Date.now();
  const now = Number.isFinite(requestedNow) ? requestedNow : Date.now();
  const unavailable = new Set<string>();
  for (const table of BOARD_TABLES) {
    if (!boardHasTable(db, table)) unavailable.add(table);
  }
  const database = db;
  const available = (...tables: string[]): boolean =>
    database !== null && tables.every(table => !unavailable.has(table));

  let swarmName = swarmId;
  if (available('swarms')) {
    try {
      const swarm = database!.prepare('SELECT name FROM swarms WHERE id = ?').get(swarmId) as
        { name: string } | undefined;
      swarmName = swarm?.name ?? swarmId;
    } catch {
      addUnavailable(unavailable, 'swarms');
    }
  }

  let rawTasks: RawTask[] = [];
  if (available('tasks')) {
    try {
      const cutoff = new Date(now - RECENT_DONE_WINDOW_MS).toISOString();
      const claimColumn = tableColumns(database!, 'tasks')?.has('claim_kind')
        ? 'claim_kind'
        : 'NULL AS claim_kind';
      rawTasks = database!.prepare(`
        SELECT id, title, state, owner_agent, lease_epoch, repo_path, branch,
               worktree_path, ${claimColumn}, created_at, updated_at
        FROM tasks
        WHERE swarm_id = ? AND (state <> 'done' OR updated_at >= ?)
        ORDER BY
          CASE state WHEN 'awaiting_review' THEN 0 WHEN 'active' THEN 1 WHEN 'open' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
          updated_at ASC,
          id ASC
      `).all(swarmId, cutoff) as unknown as RawTask[];
    } catch {
      addUnavailable(unavailable, 'tasks');
      rawTasks = [];
    }
  }

  const tasks: BoardTaskData[] = rawTasks.map(task => {
    let checkpoint: BoardCheckpointData | null = null;
    const evidence: BoardCloseEvidenceData[] = [];
    const overrides: BoardGateOverrideData[] = [];
    const grantUsage: BoardGrantUsageData[] = [];
    let notEstablished: string | null = null;
    if (available('task_events')) {
      try {
        const event = database!.prepare(`
          SELECT id, created_at, data
          FROM task_events
          WHERE swarm_id = ? AND task_id = ? AND kind = 'checkpoint'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `).get(swarmId, task.id) as RawCheckpoint | undefined;
        if (event) {
          const parsed = parseJsonObject(event.data);
          const path = typeof parsed?.path === 'string' ? parsed.path : null;
          const sequence = typeof parsed?.sequence === 'number' && Number.isFinite(parsed.sequence)
            ? parsed.sequence
            : event.id;
          checkpoint = {
            seq: sequence,
            ageMin: boardAgeMinutes(event.created_at, now) ?? 0,
            nextAction: checkpointNextAction(path),
            path,
          };
        }
        const closeEvents = database!.prepare(`
          SELECT id, task_id, epoch, kind, actor, data, created_at
          FROM task_events
          WHERE swarm_id = ? AND task_id = ?
            AND kind IN ('close_evidence', 'closed', 'gate_override', 'grant_used')
          ORDER BY id ASC
        `).all(swarmId, task.id) as unknown as RawTaskEvent[];
        for (const event of closeEvents) {
          const data = parseJsonObject(event.data);
          if (event.kind === 'close_evidence') {
            if (typeof data?.kind !== 'string' || typeof data.ref !== 'string') continue;
            const rawVerified = data.verified;
            const verified: EvidenceVerification = typeof rawVerified === 'boolean' ||
              typeof rawVerified === 'number' || rawVerified === 'unverified'
              ? rawVerified
              : false;
            evidence.push({ kind: data.kind, ref: data.ref, verified });
          } else if (event.kind === 'closed') {
            notEstablished = typeof data?.not_established === 'string'
              ? data.not_established
              : notEstablished;
          } else if (event.kind === 'gate_override') {
            overrides.push({
              eventId: event.id,
              reason: typeof data?.reason === 'string' ? data.reason : 'not recorded',
              bypassedGates: Array.isArray(data?.bypassed_gates)
                ? data.bypassed_gates.filter((gate): gate is string => typeof gate === 'string')
                : [],
              actor: event.actor,
              at: event.created_at,
            });
          } else if (event.kind === 'grant_used') {
            grantUsage.push({
              eventId: event.id,
              grantId: typeof data?.grant_id === 'number' ? data.grant_id : null,
              op: typeof data?.op === 'string' ? data.op : 'unknown',
              resource: typeof data?.resource === 'string' ? data.resource : 'unknown',
              actor: typeof data?.actor === 'string' ? data.actor : event.actor,
              at: event.created_at,
            });
          }
        }
      } catch {
        addUnavailable(unavailable, 'task_events');
      }
    }
    const evidenceAge = checkpoint?.ageMin ?? boardAgeMinutes(task.created_at, now);
    return {
      id: task.id,
      title: task.title,
      state: task.state,
      owner: task.owner_agent,
      leaseEpoch: task.lease_epoch,
      repoPath: task.repo_path,
      branch: task.branch,
      worktreePath: task.worktree_path,
      claimKind: effectiveClaimKind(task),
      evidence,
      notEstablished,
      overrides,
      grantUsage,
      createdAt: task.created_at,
      checkpoint,
      stale: task.state === 'active' && evidenceAge !== null && evidenceAge > CHECKPOINT_STALE_MINUTES,
      git: taskGit(task),
    };
  });

  let agents: BoardAgentData[] = [];
  if (available('agents')) {
    try {
      const rows = database!.prepare(`
        SELECT name, agent_type, host_agent, surface_id, joined_at, last_heartbeat
        FROM agents
        WHERE swarm_id = ?
        ORDER BY name COLLATE NOCASE ASC
      `).all(swarmId) as Array<{
        name: string;
        agent_type: string;
        host_agent: string | null;
        surface_id: string | null;
        joined_at: string;
        last_heartbeat: string;
      }>;
      agents = rows.map(agent => {
        let currentTaskId: string | null = null;
        if (available('tasks')) {
          try {
            const current = database!.prepare(`
              SELECT id FROM tasks
              WHERE swarm_id = ? AND owner_agent = ? COLLATE NOCASE AND state <> 'done'
              ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'awaiting_review' THEN 1 ELSE 2 END,
                       updated_at DESC, id ASC
              LIMIT 1
            `).get(swarmId, agent.name) as { id: string } | undefined;
            currentTaskId = current?.id ?? null;
          } catch {
            addUnavailable(unavailable, 'tasks');
          }
        }

        let taskEvidenceAt: string | null = null;
        if (available('task_events')) {
          try {
            const evidence = database!.prepare(`
              SELECT MAX(created_at) AS event_at
              FROM task_events
              WHERE swarm_id = ? AND actor = ? COLLATE NOCASE
            `).get(swarmId, agent.name) as { event_at: string | null };
            taskEvidenceAt = evidence.event_at;
          } catch {
            addUnavailable(unavailable, 'task_events');
          }
        }

        let ackedAt: string | null = null;
        if (available('message_deliveries')) {
          try {
            const evidence = database!.prepare(`
              SELECT MAX(acked_at) AS acked_at
              FROM message_deliveries
              WHERE swarm_id = ? AND recipient = ? COLLATE NOCASE AND acked_at IS NOT NULL
            `).get(swarmId, agent.name) as { acked_at: string | null };
            ackedAt = evidence.acked_at;
          } catch {
            addUnavailable(unavailable, 'message_deliveries');
          }
        }

        let unackedCount = 0;
        let unackedMaxAgeMin: number | null = null;
        if (available('messages', 'message_deliveries')) {
          try {
            const unacked = database!.prepare(`
              SELECT COUNT(*) AS count,
                     MIN(COALESCE(d.first_injected_at, m.created_at)) AS oldest_at
              FROM message_deliveries d
              JOIN messages m ON m.id = d.message_id AND m.swarm_id = d.swarm_id
              WHERE d.swarm_id = ? AND d.recipient = ? COLLATE NOCASE
                AND d.acked_at IS NULL AND d.status <> 'acked' AND m.superseded_by IS NULL
            `).get(swarmId, agent.name) as { count: number; oldest_at: string | null };
            unackedCount = unacked.count;
            unackedMaxAgeMin = unacked.count > 0
              ? boardAgeMinutes(unacked.oldest_at, now)
              : null;
          } catch {
            addUnavailable(unavailable, 'messages', 'message_deliveries');
          }
        }

        return {
          name: agent.name,
          agentType: agent.agent_type,
          host: agent.host_agent ?? agent.agent_type,
          joinedAt: agent.joined_at,
          lastHeartbeat: agent.last_heartbeat,
          surfaceKnown: Boolean(agent.surface_id),
          currentTaskId,
          progressEvidenceAt: newestIso([taskEvidenceAt, ackedAt]),
          unackedCount,
          unackedMaxAgeMin,
        };
      });
    } catch {
      addUnavailable(unavailable, 'agents');
      agents = [];
    }
  }

  const ownership = tasks
    .filter((task): task is BoardTaskData & { owner: string } => task.owner !== null)
    .map(task => ({ agent: task.owner, taskId: task.id }));
  const handoffs: BoardAgentEdge[] = [];
  const claims: BoardAgentEdge[] = [];
  if (available('task_events')) {
    try {
      const edgeEvents = database!.prepare(`
        SELECT id, task_id, epoch, kind, actor, data, created_at
        FROM task_events
        WHERE swarm_id = ? AND kind IN ('handoff', 'claimed')
        ORDER BY id ASC
      `).all(swarmId) as unknown as RawTaskEvent[];
      for (const event of edgeEvents) {
        const data = parseJsonObject(event.data);
        if (event.kind === 'handoff') {
          const to = typeof data?.to === 'string' ? data.to : null;
          if (event.actor && to) {
            handoffs.push({ from: event.actor, to, taskId: event.task_id, at: event.created_at });
          }
        } else {
          const from = typeof data?.previous_owner === 'string' ? data.previous_owner : null;
          if (from && event.actor) {
            claims.push({ from, to: event.actor, taskId: event.task_id, at: event.created_at });
          }
        }
      }
    } catch {
      addUnavailable(unavailable, 'task_events');
    }
  }

  const needsYou: BoardNeedData[] = [];
  if (available('messages', 'message_deliveries', 'agents')) {
    try {
      const deliveries = database!.prepare(`
        SELECT m.id, m.kind, m.from_agent, m.body, m.created_at, COALESCE(d.recipient, m.to_agent) AS recipient
        FROM messages m
        LEFT JOIN message_deliveries d
          ON m.id = d.message_id AND m.swarm_id = d.swarm_id
        WHERE m.swarm_id = ?
          AND COALESCE(d.recipient, m.to_agent) IS NOT NULL
          AND COALESCE(d.recipient, m.to_agent) COLLATE NOCASE IN (
            SELECT name FROM agents WHERE swarm_id = ?
          )
          AND d.acked_at IS NULL
          AND COALESCE(d.status, 'pending') <> 'acked'
          AND m.superseded_by IS NULL
          AND m.kind IN (${URGENT_MESSAGE_KINDS.map(() => '?').join(', ')})
        ORDER BY m.id ASC, d.recipient COLLATE NOCASE ASC
      `).all(swarmId, swarmId, ...URGENT_MESSAGE_KINDS) as Array<{
        id: number;
        kind: string;
        from_agent: string;
        body: string;
        created_at: string;
        recipient: string;
      }>;
      for (const delivery of deliveries) {
        needsYou.push({
          kind: delivery.kind,
          label: `message #${delivery.id} [${delivery.kind}] for ${delivery.recipient} from ${delivery.from_agent} \u2014 ` +
            flattenLine(delivery.body),
          refId: String(delivery.id),
          target: { kind: 'agent', id: delivery.recipient },
          at: delivery.created_at,
        });
      }
    } catch {
      addUnavailable(unavailable, 'messages', 'message_deliveries', 'agents');
    }
  }

  if (available('grants')) {
    try {
      const nowIso = new Date(now).toISOString();
      const soonIso = new Date(now + GRANT_EXPIRY_SOON_MS).toISOString();
      const grants = database!.prepare(`
        SELECT id, op, resource, granted_to, expires_at
        FROM grants
        WHERE swarm_id = ? AND revoked_at IS NULL
          AND expires_at > ? AND expires_at < ?
        ORDER BY expires_at ASC, id ASC
      `).all(swarmId, nowIso, soonIso) as Array<{
        id: number;
        op: string;
        resource: string;
        granted_to: string | null;
        expires_at: string;
      }>;
      for (const grant of grants) {
        const expiresIn = Math.max(0, Math.floor((new Date(grant.expires_at).getTime() - now) / 60_000));
        needsYou.push({
          kind: 'grant_expiring',
          label: `grant #${grant.id} ${grant.op} on ${grant.resource} expires in ${expiresIn}m — ` +
            `to ${grant.granted_to ?? 'any'}`,
          refId: String(grant.id),
          target: tasks.some(task => task.id === grant.resource)
            ? { kind: 'task', id: grant.resource }
            : null,
          at: null,
        });
      }
    } catch {
      addUnavailable(unavailable, 'grants');
    }
  }

  if (available('tasks')) {
    for (const task of tasks.filter(task => task.state === 'awaiting_review')) {
      needsYou.push({
        kind: 'awaiting_review',
        label: `task ${task.id} awaits review \u2014 ${task.owner ?? 'unowned'}(${task.leaseEpoch})`,
        refId: task.id,
        target: { kind: 'task', id: task.id },
        at: null,
      });
    }
    const activeByCreatedAt = tasks
      .filter(task => task.state === 'active' && task.stale)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    for (const task of activeByCreatedAt) {
      const evidence = task.checkpoint
        ? `checkpoint ${task.checkpoint.ageMin}m ago`
        : `no checkpoint for ${boardAgeMinutes(task.createdAt, now) ?? 0}m`;
      needsYou.push({
        kind: 'stalled',
        label: `task ${task.id} stalled \u2014 ${evidence}`,
        refId: task.id,
        target: { kind: 'task', id: task.id },
        at: task.checkpoint?.path ? null : task.createdAt,
      });
    }
  }

  let janitor: RawJanitorStatus | null = null;
  let counters = emptyBoardCounters();
  let tickAgeMin: number | null = null;
  if (available('janitor_status')) {
    try {
      janitor = database!.prepare('SELECT last_tick_at, counters FROM janitor_status WHERE id = 1')
        .get() as RawJanitorStatus | undefined ?? null;
      if (janitor) {
        counters = parseCounters(janitor.counters);
        tickAgeMin = boardAgeMinutes(janitor.last_tick_at, now);
        const tick = new Date(janitor.last_tick_at).getTime();
        if (Number.isFinite(tick) && now - tick > JANITOR_HEARTBEAT_STALE_MS) {
          needsYou.push({
            kind: 'janitor_stale',
            label: `janitor heartbeat stale \u2014 tick ${boardAgeLabel(janitor.last_tick_at, now)} ago`,
            refId: 'janitor',
            target: null,
            at: janitor.last_tick_at,
          });
        }
      }
    } catch {
      addUnavailable(unavailable, 'janitor_status');
      janitor = null;
    }
  }

  let findings: BoardDebrisFinding[] = [];
  if (available('janitor_findings')) {
    try {
      const rows = database!.prepare(`
        SELECT kind, path, state, first_seen_at, last_seen_at, detail
        FROM janitor_findings
        ORDER BY kind ASC, path ASC
      `).all() as Array<{
        kind: string;
        path: string;
        state: string;
        first_seen_at: string;
        last_seen_at: string;
        detail: string;
      }>;
      findings = rows.map(row => ({
        kind: row.kind,
        path: row.path,
        state: row.state,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        detail: parseJsonValue(row.detail),
      }));
      for (const finding of findings.filter(item => item.state === 'hold')) {
        const detail = finding.detail && typeof finding.detail === 'object' && !Array.isArray(finding.detail)
          ? finding.detail as Record<string, unknown>
          : {};
        if (finding.kind === 'worker-epoch-change') {
          needsYou.push({
            kind: finding.kind,
            label: `worker epoch ${String(detail.host ?? 'unknown')} changed ` +
              `${String(detail.from ?? 'unknown')} → ${String(detail.to ?? 'unknown')} — ` +
              `requalify via ${String(detail.runbook ?? 'docs/runbooks/requalify-worker.md')}`,
            refId: finding.path,
            target: null,
            at: finding.lastSeenAt,
          });
        } else if (finding.kind === 'control-retest-due') {
          needsYou.push({
            kind: finding.kind,
            label: `control ${String(detail.id ?? finding.path)} retest due ${String(detail.retest_by ?? 'unknown')}`,
            refId: finding.path,
            target: null,
            at: finding.lastSeenAt,
          });
        } else if (finding.kind === 'controls-file-invalid') {
          needsYou.push({
            kind: finding.kind,
            label: `controls registry invalid — ${finding.path}`,
            refId: finding.path,
            target: null,
            at: finding.lastSeenAt,
          });
        }
      }
    } catch {
      addUnavailable(unavailable, 'janitor_findings');
      findings = [];
    }
  }

  let debrisTrend: BoardDebrisTrendPoint[] | undefined;
  if (available('janitor_snapshots')) {
    try {
      const snapshots = database!.prepare(`
        SELECT tick_at, counters
        FROM (
          SELECT id, tick_at, counters
          FROM janitor_snapshots
          ORDER BY id DESC
          LIMIT ?
        ) recent
        ORDER BY id ASC
      `).all(DEBRIS_TREND_LIMIT) as Array<{ tick_at: string; counters: string }>;
      debrisTrend = snapshots.map(snapshot => ({
        tickAt: snapshot.tick_at,
        counters: parseCounters(snapshot.counters),
      }));
    } catch {
      addUnavailable(unavailable, 'janitor_snapshots');
      debrisTrend = undefined;
    }
  }

  let quota: string | null = null;
  if (available('tasks', 'task_events')) {
    try {
      const event = database!.prepare(`
        SELECT e.id, e.created_at, e.data
        FROM task_events e
        JOIN tasks t ON t.swarm_id = e.swarm_id AND t.id = e.task_id
        WHERE e.swarm_id = ? AND substr(t.id, 1, 8) = 'program-' AND e.kind = 'checkpoint'
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 1
      `).get(swarmId) as RawCheckpoint | undefined;
      const parsed = parseJsonObject(event?.data ?? null);
      const checkpointPath = typeof parsed?.path === 'string' ? parsed.path : null;
      const contents = readCheckpoint(checkpointPath);
      if (contents) {
        const lines = sectionContents(contents, 'quota')
          .map(line => line.replace(/^[-*]\s*/, ''))
          .filter(Boolean);
        quota = lines.length > 0 ? oneLine(lines.join(' | '), 140) : null;
      }
    } catch {
      addUnavailable(unavailable, 'tasks', 'task_events');
    }
  }

  let timeline: BoardTimelineEvent[] = [];
  if (available('task_events')) {
    try {
      const events = database!.prepare(`
        SELECT id, task_id, epoch, kind, actor, data, created_at
        FROM (
          SELECT id, task_id, epoch, kind, actor, data, created_at
          FROM task_events
          WHERE swarm_id = ?
          ORDER BY id DESC
          LIMIT ?
        ) recent
        ORDER BY id ASC
      `).all(swarmId, TIMELINE_LIMIT) as unknown as RawTaskEvent[];
      timeline = events.map(event => ({
        id: event.id,
        taskId: event.task_id,
        epoch: event.epoch,
        kind: event.kind,
        actor: event.actor,
        at: event.created_at,
        summary: eventSummary(event),
      }));
    } catch {
      addUnavailable(unavailable, 'task_events');
      timeline = [];
    }
  }

  const result: BoardData = {
    generatedAt: new Date(now).toISOString(),
    swarm: { id: swarmId, name: swarmName },
    agents,
    tasks,
    edges: { ownership, handoffs, claims },
    needsYou,
    debris: { tickAgeMin, counters, findings },
    timeline,
    quota,
    unavailable: BOARD_TABLES.filter(table => unavailable.has(table)),
  };
  if (debrisTrend !== undefined) result.debrisTrend = debrisTrend;
  return result;
}
