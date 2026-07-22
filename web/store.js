// Swarm board v2 — store + pure selectors.
// One normalized store; render notifications coalesced to rAF by app.js.
// Every function here is pure and unit-testable without a DOM.

const SINCE_YOU_LEFT_MIN_AWAY_MS = 10 * 60_000;
const STALE_HEARTBEAT_MIN = 10;
export const IDLE_COLLAPSE_THRESHOLD = 3;

export function createStore() {
  const listeners = new Set();
  const state = {
    board: null,          // last BoardData snapshot from the server
    connection: 'connecting', // connecting | live | polling | stale
    lastSeq: 0,
    selection: null,      // { kind: 'agent'|'task', id }
    cursor: null,         // { list: 'needs'|'agents'|'tasks', index }
    lens: 'spans',        // spans | flow (for the selected task)
    paletteOpen: false,
    helpOpen: false,
    digest: null,         // { awayMin, items: [{who, text}] } — computed once on load
    digestDismissed: false,
    flash: null,          // { ok, text } transient inspector feedback
  };

  return {
    get: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    update(patch) {
      Object.assign(state, patch);
      for (const fn of listeners) fn(state);
    },
  };
}

// ── status derivation (P2: tiny vocabulary) ───────────────

export function agentStatus(agent, needsYou, now = Date.now()) {
  const needsRefs = new Set((needsYou ?? []).map(need => need.refId));
  if (needsRefs.has(agent.name) || agent.unackedCount > 0) return 'needs-you';
  const heartbeatAgeMin = ageMinutes(agent.lastHeartbeat, now);
  if (agent.agentType === 'cmux' && heartbeatAgeMin !== null && heartbeatAgeMin > STALE_HEARTBEAT_MIN) {
    return 'stale';
  }
  if (agent.currentTaskId) return 'working';
  return 'idle';
}

const STATUS_RANK = { 'needs-you': 0, stale: 1, working: 2, idle: 3 };

/** Roster with idle-collapse (P3): returns { rows, collapsedIdle } */
export function rosterRows(board, selection, now = Date.now()) {
  if (!board) return { rows: [], collapsedIdle: [] };
  const decorated = board.agents.map(agent => ({
    agent,
    status: agentStatus(agent, board.needsYou, now),
  }));
  decorated.sort((a, b) =>
    (STATUS_RANK[a.status] - STATUS_RANK[b.status]) ||
    a.agent.name.localeCompare(b.agent.name));
  const idle = decorated.filter(row => row.status === 'idle' &&
    !(selection?.kind === 'agent' && selection.id === row.agent.name));
  if (idle.length > IDLE_COLLAPSE_THRESHOLD) {
    return {
      rows: decorated.filter(row => !idle.includes(row)),
      collapsedIdle: idle.map(row => row.agent.name),
    };
  }
  return { rows: decorated, collapsedIdle: [] };
}

// ── timeline semantics (P4: group spans) ──────────────────

const SPAN_GROUPS = [
  { match: kind => kind === 'refused_stale_epoch' || kind.startsWith('refused'), out: 'refused', shape: 'dot' },
  { match: kind => kind === 'handoff' || kind === 'escalated', out: 'handoff', shape: 'dot' },
  { match: kind => kind === 'review_requested' || kind === 'review_verdict', out: 'review', shape: 'bar' },
  { match: kind => kind === 'closed', out: 'closed', shape: 'bar' },
  { match: () => true, out: 'progress', shape: 'bar' },
];

/** Compress a task's raw events into Temporal-style outcome spans. */
export function taskSpans(events) {
  const spans = [];
  for (const event of events) {
    const group = SPAN_GROUPS.find(candidate => candidate.match(event.kind));
    const last = spans[spans.length - 1];
    if (last && last.group === group.out) {
      last.count += 1;
      last.lastAt = event.at;
    } else {
      spans.push({ group: group.out, shape: group.shape, count: 1, firstAt: event.at, lastAt: event.at });
    }
  }
  return spans;
}

export function eventsForTask(board, taskId) {
  return (board?.timeline ?? []).filter(event => event.taskId === taskId);
}

export function eventsForAgent(board, agentName) {
  return (board?.timeline ?? []).filter(event => event.actor === agentName);
}

export function lastEventSummary(board, agentName) {
  const events = eventsForAgent(board, agentName);
  const last = events[events.length - 1];
  return last ? `${last.kind} ${last.taskId}` : null;
}

// ── since-you-left digest (P8) ────────────────────────────

const LAST_SEEN_KEY = 'swarm-board-last-seen';

export function loadLastSeen(storage) {
  try {
    const raw = storage.getItem(LAST_SEEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.at === 'number' && typeof parsed?.maxEventId === 'number' ? parsed : null;
  } catch { return null; }
}

export function saveLastSeen(storage, maxEventId, at = Date.now()) {
  try { storage.setItem(LAST_SEEN_KEY, JSON.stringify({ at, maxEventId })); } catch { /* private mode */ }
}

export function maxEventId(board) {
  return (board?.timeline ?? []).reduce((max, event) => Math.max(max, event.id ?? 0), 0);
}

const DIGEST_KINDS = new Set(['closed', 'handoff', 'escalated', 'refused_stale_epoch', 'started', 'review_requested']);

export function computeDigest(board, lastSeen, now = Date.now()) {
  if (!board || !lastSeen) return null;
  if (now - lastSeen.at < SINCE_YOU_LEFT_MIN_AWAY_MS) return null;
  const fresh = (board.timeline ?? []).filter(event =>
    (event.id ?? 0) > lastSeen.maxEventId && DIGEST_KINDS.has(event.kind));
  const needs = board.needsYou ?? [];
  if (fresh.length === 0 && needs.length === 0) return null;
  const items = fresh.slice(-8).map(event => ({
    who: event.actor ?? 'system',
    text: `${event.kind.replace(/_/g, ' ')} — ${event.taskId}`,
  }));
  for (const need of needs.slice(0, 4)) {
    items.push({ who: need.kind, text: need.label });
  }
  return { awayMin: Math.round((now - lastSeen.at) / 60_000), items };
}

// ── flow lens (P5): per-task nodes/edges, hand layout ─────

/** Layered 3-column layout: sources → task → handoff/review parties. */
export function flowGraph(board, taskId) {
  if (!board) return null;
  const task = board.tasks.find(candidate => candidate.id === taskId);
  if (!task) return null;
  const left = [];
  const right = [];
  if (task.owner) left.push({ id: task.owner, label: task.owner, role: 'owner' });
  for (const handoff of board.edges.handoffs.filter(edge => edge.taskId === taskId)) {
    if (!left.some(node => node.id === handoff.from)) left.push({ id: handoff.from, label: handoff.from, role: 'handoff-from' });
    if (handoff.to !== task.owner && !right.some(node => node.id === handoff.to)) {
      right.push({ id: handoff.to, label: handoff.to, role: 'handoff-to' });
    }
  }
  for (const claim of board.edges.claims.filter(edge => edge.taskId === taskId)) {
    if (!left.some(node => node.id === claim.from) && !right.some(node => node.id === claim.from)) {
      right.push({ id: claim.from, label: claim.from, role: 'claimant' });
    }
  }
  const edges = [
    ...left.map(node => ({ from: node.id, to: taskId, kind: node.role === 'owner' ? 'owns' : 'handoff' })),
    ...right.map(node => ({ from: taskId, to: node.id, kind: 'handoff' })),
  ];
  return { task, left, right, edges };
}

// ── palette (P7) ──────────────────────────────────────────

export function paletteItems(board, query) {
  if (!board) return [];
  const needle = query.trim().toLowerCase();
  const items = [
    ...board.agents.map(agent => ({ kind: 'agent', id: agent.name, label: agent.name })),
    ...board.tasks.map(task => ({ kind: 'task', id: task.id, label: `${task.id} — ${task.title}` })),
  ];
  if (!needle) return items.slice(0, 12);
  return items
    .filter(item => item.label.toLowerCase().includes(needle))
    .slice(0, 12);
}

// ── shared helpers ────────────────────────────────────────

export function ageMinutes(iso, now = Date.now()) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.round((now - then) / 60_000));
}

export function ageLabel(iso, now = Date.now()) {
  const minutes = ageMinutes(iso, now);
  if (minutes === null) return '—';
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

export function clockLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = value => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
