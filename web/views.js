// Swarm board v2 — Preact components. Pure render from store state;
// all interaction dispatches through the actions object app.js provides.
import { h, Fragment } from './vendor/preact-10.29.7.module.js';
import { useEffect, useRef, useState } from './vendor/preact-hooks-10.29.7.module.js';
import htm from './vendor/htm-3.1.1.module.js';
import {
  ageLabel, clockLabel, computeDigest, eventsForAgent, eventsForTask,
  flowGraph, lastEventSummary, paletteItems, rosterRows, taskSpans,
} from './store.js';

const html = htm.bind(h);

const NEED_KIND_LABELS = {
  'blocking-question': 'question',
  'merge-req': 'merge-req',
  escalation: 'escalate',
  gate: 'gate',
  'stale-checkpoint': 'stale',
  'unacked-mail': 'mail',
};

export function App({ state, actions }) {
  const { board } = state;
  if (!board) {
    return html`<div class="board">
      <header class="masthead"><h1>Swarm</h1>
        ${Freshness({ connection: state.connection })}
      </header>
      <p class="quiet">Connecting to the swarm daemon…</p>
    </div>`;
  }
  return html`<div class="board">
    ${Masthead({ state })}
    ${state.digest && !state.digestDismissed ? Digest({ state, actions }) : null}
    ${board.unavailable?.length ? html`<div class="error-banner">
      Projection degraded: ${board.unavailable.join(', ')} unavailable.
    </div>` : null}
    ${NeedsYou({ state, actions })}
    ${Roster({ state, actions })}
    ${Lanes({ state, actions })}
    ${state.selection ? Inspector({ state, actions }) : null}
    ${state.paletteOpen ? Palette({ state, actions }) : null}
    ${state.helpOpen ? HelpOverlay({ actions }) : null}
  </div>`;
}

function Masthead({ state }) {
  const { board } = state;
  const activeTasks = board.tasks.filter(task => task.state !== 'done').length;
  return html`<header class="masthead">
    <h1>${board.swarm.name}</h1>
    <span class="counts num">${board.agents.length} agent${board.agents.length === 1 ? '' : 's'} · ${activeTasks} active task${activeTasks === 1 ? '' : 's'}</span>
    <span class="kbd-hint"><kbd>/</kbd> jump · <kbd>?</kbd> help</span>
    ${Freshness({ connection: state.connection })}
  </header>`;
}

function Freshness({ connection }) {
  const cls = connection === 'live' || connection === 'polling'
    ? 'freshness'
    : connection === 'connecting' ? 'freshness is-connecting' : 'freshness is-stale';
  const label = { live: 'live', polling: 'polling', connecting: 'connecting', stale: 'STALE' }[connection] ?? connection;
  return html`<span class=${cls} role="status"><span class="dot"></span>${label}</span>`;
}

function Digest({ state, actions }) {
  const digest = state.digest;
  return html`<section class="digest" aria-label="Since you left">
    <div class="digest-head">
      <span>Since you left (${digest.awayMin}m)</span>
      <button type="button" onClick=${actions.dismissDigest}>dismiss</button>
    </div>
    <ul>
      ${digest.items.map(item => html`<li key=${item.who + item.text}>
        <span class="who">${item.who}</span> · ${item.text}
      </li>`)}
    </ul>
  </section>`;
}

function NeedsYou({ state, actions }) {
  const needs = state.board.needsYou ?? [];
  if (needs.length === 0) return null;
  const cursor = state.cursor?.list === 'needs' ? state.cursor.index : -1;
  return html`<section class="section needs" aria-label="Needs you">
    <div class="section-head"><span>Needs you</span><span class="count-chip num">${needs.length}</span></div>
    <div class="rows">
      ${needs.map((need, index) => html`<button type="button" key=${need.kind + need.refId}
          class=${`row ${index === cursor ? 'is-cursor' : ''}`}
          onClick=${() => actions.jumpToNeed(need)}>
        <span class="kind">${NEED_KIND_LABELS[need.kind] ?? need.kind}</span>
        <span class="label">${need.label}</span>
        <span class="age">↵</span>
      </button>`)}
    </div>
  </section>`;
}

function Roster({ state, actions }) {
  const { rows, collapsedIdle } = rosterRows(state.board, state.selection);
  const cursor = state.cursor?.list === 'agents' ? state.cursor.index : -1;
  return html`<section class="section" aria-label="Agents">
    <div class="section-head"><span>Agents</span><span class="count-chip num">${state.board.agents.length}</span></div>
    <div class="rows">
      ${rows.map((row, index) => AgentRow({
        row, state, actions,
        isCursor: index === cursor,
      }))}
      ${collapsedIdle.length > 0 ? html`<button type="button" class="idle-collapse-row"
          onClick=${() => actions.selectAgent(collapsedIdle[0])}>
        <span class="status-dot" style=${{ background: 'var(--idle)' }}></span>
        ${collapsedIdle.length} idle agents — ${collapsedIdle.join(', ')}
      </button>` : null}
    </div>
  </section>`;
}

function AgentRow({ row, state, actions, isCursor }) {
  const { agent, status } = row;
  const selected = state.selection?.kind === 'agent' && state.selection.id === agent.name;
  const summary = lastEventSummary(state.board, agent.name);
  const mail = agent.unackedCount > 0
    ? `✉ ${agent.unackedCount}${agent.unackedMaxAgeMin !== null ? ` (${agent.unackedMaxAgeMin}m)` : ''}`
    : null;
  return html`<button type="button" key=${agent.name}
      class=${`agent-row st-${status} ${selected ? 'is-selected' : ''} ${isCursor ? 'is-cursor' : ''}`}
      onClick=${() => actions.selectAgent(agent.name)}>
    <span class="status-dot"></span>
    <span class="status-word">${status}</span>
    <span class="name">${agent.name}</span>
    ${agent.currentTaskId ? html`<span class="task-ref">${agent.currentTaskId}</span>` : null}
    <span class="summary">${summary ?? ''}</span>
    ${mail ? html`<span class="mail-warn">${mail}</span>` : null}
    <span class="meta num">${agent.agentType} · ${ageLabel(agent.lastHeartbeat)}</span>
  </button>`;
}

function Lanes({ state, actions }) {
  const tasks = state.board.tasks;
  if (tasks.length === 0) {
    return html`<section class="section" aria-label="Tasks">
      <div class="section-head"><span>Tasks</span></div>
      <p class="quiet">No tasks yet — swarm task start &lt;slug&gt; --claim &lt;kind&gt;</p>
    </section>`;
  }
  const cursor = state.cursor?.list === 'tasks' ? state.cursor.index : -1;
  return html`<section class="section" aria-label="Tasks">
    <div class="section-head">
      <span>Tasks</span><span class="count-chip num">${tasks.length}</span>
    </div>
    <div class="rows">
      ${tasks.map((task, index) => Lane({
        task, state, actions,
        isCursor: index === cursor,
      }))}
    </div>
  </section>`;
}

function Lane({ task, state, actions, isCursor }) {
  const selected = state.selection?.kind === 'task' && state.selection.id === task.id;
  const events = eventsForTask(state.board, task.id);
  const spans = taskSpans(events);
  return html`<div key=${task.id}
      class=${`lane ${selected ? 'is-selected' : ''} ${isCursor ? 'is-cursor' : ''}`}
      role="button" tabindex="0"
      onClick=${() => actions.selectTask(task.id)}
      onKeyDown=${event => { if (event.key === 'Enter') actions.selectTask(task.id); }}>
    <div class="lane-head">
      <span class="slug">${task.id}</span>
      <span class=${`chip state-${task.state}`}>${task.state}</span>
      <span class="chip">${task.claimKind}</span>
      ${task.stale ? html`<span class="chip warn">stale ckpt</span>` : null}
      ${task.git && (task.git.dirty || task.git.unpushed > 0) ? html`<span class="chip danger">
        ${task.git.unpushed > 0 ? `${task.git.unpushed}↑` : ''}${task.git.dirty ? ' dirty' : ''}
      </span>` : null}
      <span class="owner">${task.owner ?? 'unowned'}</span>
      <span class="meta num">
        ${task.checkpoint ? `ckpt #${task.checkpoint.seq} · ${task.checkpoint.ageMin}m` : 'no checkpoint'}
      </span>
    </div>
    ${spans.length > 0 ? html`<div class="spans" aria-hidden="true">
      ${spans.map((span, index) => span.shape === 'dot'
        ? html`<${Fragment} key=${index}>
            <span class=${`span-dot sp-${span.group}`}></span>
            ${span.count > 1 ? html`<span class="span-count">×${span.count}</span>` : null}
          <//>`
        : html`<${Fragment} key=${index}>
            <span class=${`span-bar sp-${span.group}`} style=${{ width: `${Math.min(72, 10 + span.count * 8)}px` }}></span>
            ${span.count > 1 ? html`<span class="span-count">×${span.count}</span>` : null}
          <//>`)}
    </div>` : null}
    ${selected && state.lens === 'flow' ? FlowLens({ state, taskId: task.id }) : null}
  </div>`;
}

function FlowLens({ state, taskId }) {
  const graph = flowGraph(state.board, taskId);
  if (!graph || (graph.left.length === 0 && graph.right.length === 0)) {
    return html`<p class="quiet flow-lens">No ownership or handoff edges recorded for this task.</p>`;
  }
  const rowHeight = 34;
  const rows = Math.max(graph.left.length, graph.right.length, 1);
  const height = rows * rowHeight + 16;
  const nodeY = index => 8 + index * rowHeight;
  const box = (x, y, label, key) => html`<g key=${key} class="node">
    <rect x=${x} y=${y} width="150" height="24" rx="4"></rect>
    <text x=${x + 8} y=${y + 16}>${label.length > 18 ? label.slice(0, 17) + '…' : label}</text>
  </g>`;
  const taskY = height / 2 - 12;
  return html`<div class="flow-lens">
    <svg viewBox=${`0 0 560 ${height}`} role="img" aria-label=${`Ownership and handoff flow for ${taskId}`}>
      ${graph.left.map((node, index) => box(4, nodeY(index), node.label, node.id))}
      ${box(205, taskY, taskId, taskId)}
      ${graph.right.map((node, index) => box(406, nodeY(index), node.label, node.id))}
      ${graph.left.map((node, index) => html`<path key=${'l' + node.id}
        class=${`edge ${node.role === 'owner' ? '' : 'handoff'}`}
        d=${`M 154 ${nodeY(index) + 12} C 180 ${nodeY(index) + 12}, 180 ${taskY + 12}, 205 ${taskY + 12}`}></path>`)}
      ${graph.right.map((node, index) => html`<path key=${'r' + node.id}
        class="edge handoff"
        d=${`M 355 ${taskY + 12} C 380 ${taskY + 12}, 380 ${nodeY(index) + 12}, 406 ${nodeY(index) + 12}`}></path>`)}
    </svg>
  </div>`;
}

// ── inspector ─────────────────────────────────────────────

export function Inspector({ state, actions }) {
  const { selection, board } = state;
  const isAgent = selection.kind === 'agent';
  const agent = isAgent ? board.agents.find(candidate => candidate.name === selection.id) : null;
  const task = !isAgent ? board.tasks.find(candidate => candidate.id === selection.id) : null;
  if (!agent && !task) return null;
  const events = isAgent ? eventsForAgent(board, selection.id) : eventsForTask(board, selection.id);
  return html`<${Fragment}>
    <button type="button" class="inspector-scrim" aria-label="Close inspector" onClick=${actions.closeInspector}></button>
    <aside class="inspector" aria-label="Inspector">
      <div class="inspector-head">
        <h2>${selection.id}</h2>
        ${task ? html`<span class=${`chip state-${task.state}`}>${task.state}</span>` : null}
        <button type="button" class="close" aria-label="Close" onClick=${actions.closeInspector}>×</button>
      </div>
      <div class="inspector-actions">
        ${agent && agent.agentType === 'cmux' ? html`<button type="button" class="action"
            onClick=${() => actions.focusAgent(agent.name)}>Focus terminal</button>` : null}
        <button type="button" class="action"
            onClick=${() => actions.copyText(isAgent ? `swarm send ${selection.id} ""` : selection.id)}>
          ${isAgent ? 'Copy send command' : 'Copy slug'}
        </button>
        ${task ? html`<button type="button" class="action" onClick=${actions.toggleLens}>
          Lens: ${state.lens === 'flow' ? 'flow' : 'spans'}
        </button>` : null}
        ${state.flash ? html`<span class=${`flash ${state.flash.ok ? 'ok' : 'err'}`}>${state.flash.text}</span>` : null}
      </div>
      <div class="inspector-body">
        ${agent ? AgentDetail({ agent }) : TaskDetail({ task })}
        <h3>Events (${events.length})</h3>
        ${EventFeed({ events })}
      </div>
    </aside>
  <//>`;
}

function AgentDetail({ agent }) {
  return html`<dl>
    <dt>Type</dt><dd>${agent.agentType} / ${agent.host}</dd>
    <dt>Joined</dt><dd class="num">${ageLabel(agent.joinedAt)} ago</dd>
    <dt>Heartbeat</dt><dd class="num">${ageLabel(agent.lastHeartbeat)} ago</dd>
    <dt>Task</dt><dd>${agent.currentTaskId ?? '—'}</dd>
    <dt>Unread mail</dt><dd class="num">${agent.unackedCount}${agent.unackedMaxAgeMin !== null ? ` (oldest ${agent.unackedMaxAgeMin}m)` : ''}</dd>
  </dl>`;
}

function TaskDetail({ task }) {
  return html`<${Fragment}>
    <dl>
      <dt>Title</dt><dd>${task.title}</dd>
      <dt>Owner</dt><dd>${task.owner ?? 'unowned'} @${task.leaseEpoch}</dd>
      <dt>Claim</dt><dd>${task.claimKind}</dd>
      ${task.branch ? html`<dt>Branch</dt><dd>${task.branch}</dd>` : null}
      ${task.git ? html`<dt>Git</dt><dd class="num">
        ${task.git.unpushed}↑ unpushed${task.git.dirty ? ' · dirty' : ''}${task.git.untracked ? ` · ${task.git.untracked} untracked` : ''}
      </dd>` : null}
      ${task.notEstablished ? html`<dt>Not established</dt><dd>${task.notEstablished}</dd>` : null}
    </dl>
    ${task.checkpoint?.nextAction ? html`<${Fragment}>
      <h3>Next action (ckpt #${task.checkpoint.seq}, ${task.checkpoint.ageMin}m ago)</h3>
      <pre>${task.checkpoint.nextAction}</pre>
    <//>` : null}
    ${task.evidence.length > 0 ? html`<${Fragment}>
      <h3>Evidence</h3>
      <pre>${task.evidence.map(item => `${item.kind}: ${item.ref} [${item.verified}]`).join('\n')}</pre>
    <//>` : null}
  <//>`;
}

// ── fixed-row virtualizer (26px rows, hand-rolled) ────────

const ROW_H = 26;
const OVERSCAN = 6;

export function EventFeed({ events }) {
  const viewportRef = useRef(null);
  const [range, setRange] = useState({ start: 0, end: 40 });
  const [following, setFollowing] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const frame = useRef(0);

  const recompute = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const start = Math.max(0, Math.floor(viewport.scrollTop / ROW_H) - OVERSCAN);
    const end = Math.min(events.length, Math.ceil((viewport.scrollTop + viewport.clientHeight) / ROW_H) + OVERSCAN);
    setRange({ start, end });
    const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < ROW_H * 1.5;
    setFollowing(atBottom);
    if (atBottom) setPendingCount(0);
  };

  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(recompute);
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (following) {
      viewport.scrollTop = viewport.scrollHeight;
    } else {
      setPendingCount(count => count + 1);
    }
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length]);

  const resume = () => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
    setFollowing(true);
    setPendingCount(0);
  };

  const visible = events.slice(range.start, range.end);
  return html`<div class="feed" ref=${viewportRef} onScroll=${onScroll} tabindex="0"
      role="log" aria-label="Event feed">
    <div class="spacer" style=${{ height: `${events.length * ROW_H}px` }}>
      ${visible.map((event, offset) => {
        const index = range.start + offset;
        const kindClass = event.kind.startsWith('review') ? 'ev-review'
          : event.kind.startsWith('refused') ? 'ev-refused'
          : ['closed', 'checkpoint', 'handoff', 'escalated'].includes(event.kind) ? `ev-${event.kind}` : '';
        return html`<div class="feed-row" key=${event.id ?? index}
            style=${{ transform: `translateY(${index * ROW_H}px)` }}>
          <span class="t">${clockLabel(event.at)}</span>
          <span class=${`k ${kindClass}`}>${event.kind}</span>
          <span class="s">${event.actor ?? 'system'} · ${event.summary}</span>
        </div>`;
      })}
    </div>
    ${!following && pendingCount > 0 ? html`<button type="button" class="feed-resume" onClick=${resume}>
      ${pendingCount} new — resume
    </button>` : null}
  </div>`;
}

// ── palette + help ────────────────────────────────────────

export function Palette({ state, actions }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);
  // The autofocus attribute only applies during parser-inserted mounts;
  // a dynamically mounted dialog must focus imperatively.
  useEffect(() => { inputRef.current?.focus(); }, []);
  const items = paletteItems(state.board, query);
  const clamped = Math.min(cursor, Math.max(0, items.length - 1));
  const onKeyDown = event => {
    if (event.key === 'ArrowDown') { setCursor(clamped + 1 < items.length ? clamped + 1 : 0); event.preventDefault(); }
    else if (event.key === 'ArrowUp') { setCursor(clamped - 1 >= 0 ? clamped - 1 : items.length - 1); event.preventDefault(); }
    else if (event.key === 'Enter' && items[clamped]) { actions.paletteChoose(items[clamped]); }
    else if (event.key === 'Escape') { actions.closePalette(); }
  };
  return html`<${Fragment}>
    <button type="button" class="palette-scrim" aria-label="Close palette" onClick=${actions.closePalette}></button>
    <div class="palette" role="dialog" aria-label="Jump to agent or task">
      <input ref=${inputRef} placeholder="Jump to agent or task…" value=${query}
        onInput=${event => { setQuery(event.target.value); setCursor(0); }}
        onKeyDown=${onKeyDown} />
      <ul>
        ${items.length === 0 ? html`<li class="empty">No matches.</li>` : null}
        ${items.map((item, index) => html`<li key=${item.kind + item.id} class=${index === clamped ? 'is-cursor' : ''}>
          <button type="button" onClick=${() => actions.paletteChoose(item)}>
            <span class="kind-tag">${item.kind}</span>
            <span>${item.label}</span>
          </button>
        </li>`)}
      </ul>
    </div>
  <//>`;
}

export function HelpOverlay({ actions }) {
  return html`<button type="button" class="help-overlay" onClick=${actions.closeHelp} aria-label="Close help">
    <div class="help-card" role="dialog" aria-label="Keyboard shortcuts">
      <h2>Keyboard</h2>
      <table><tbody>
        <tr><td>/</td><td>jump palette</td></tr>
        <tr><td>j / k</td><td>move cursor</td></tr>
        <tr><td>Enter</td><td>open inspector</td></tr>
        <tr><td>Tab</td><td>next section</td></tr>
        <tr><td>f</td><td>toggle flow lens</td></tr>
        <tr><td>Esc</td><td>close / back</td></tr>
        <tr><td>?</td><td>this help</td></tr>
      </tbody></table>
    </div>
  </button>`;
}

export { computeDigest };
