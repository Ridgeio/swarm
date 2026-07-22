// Swarm board v2 — bootstrap: store wiring, transport, keyboard, URL hash.
import { h, render } from './vendor/preact-10.29.7.module.js';
import {
  createStore, computeDigest, loadLastSeen, saveLastSeen, maxEventId, rosterRows,
} from './store.js';
import { connectLive, postFocusAgent, readToken } from './api.js';
import { App } from './views.js';

const store = createStore();
const token = readToken();

// ── selection <-> URL hash (P6) ───────────────────────────

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return null;
  const [kind, ...rest] = raw.split(':');
  const id = decodeURIComponent(rest.join(':'));
  return (kind === 'agent' || kind === 'task') && id ? { kind, id } : null;
}

function writeHash(selection) {
  const next = selection ? `#${selection.kind}:${encodeURIComponent(selection.id)}` : '';
  if (location.hash !== next) history.replaceState(null, '', next || location.pathname + location.search);
}

// ── actions ───────────────────────────────────────────────

let flashTimer = 0;
function flash(ok, text) {
  clearTimeout(flashTimer);
  store.update({ flash: { ok, text } });
  flashTimer = setTimeout(() => store.update({ flash: null }), 2_500);
}

const actions = {
  selectAgent(name) {
    store.update({ selection: { kind: 'agent', id: name }, flash: null });
    writeHash(store.get().selection);
  },
  selectTask(id) {
    store.update({ selection: { kind: 'task', id }, flash: null });
    writeHash(store.get().selection);
  },
  closeInspector() {
    store.update({ selection: null, flash: null });
    writeHash(null);
  },
  toggleLens() {
    store.update({ lens: store.get().lens === 'flow' ? 'spans' : 'flow' });
  },
  jumpToNeed(need) {
    const board = store.get().board;
    if (board?.agents.some(agent => agent.name === need.refId)) actions.selectAgent(need.refId);
    else if (board?.tasks.some(task => task.id === need.refId)) actions.selectTask(need.refId);
  },
  async focusAgent(name) {
    const result = await postFocusAgent(token, name);
    flash(result.ok, result.message);
  },
  async copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      flash(true, 'Copied.');
    } catch {
      flash(false, 'Clipboard unavailable.');
    }
  },
  openPalette() { store.update({ paletteOpen: true }); },
  closePalette() { store.update({ paletteOpen: false }); },
  paletteChoose(item) {
    store.update({ paletteOpen: false });
    if (item.kind === 'agent') actions.selectAgent(item.id);
    else actions.selectTask(item.id);
  },
  openHelp() { store.update({ helpOpen: true }); },
  closeHelp() { store.update({ helpOpen: false }); },
  dismissDigest() { store.update({ digestDismissed: true }); },
};

// ── keyboard (P7) ─────────────────────────────────────────

const SECTION_ORDER = ['needs', 'agents', 'tasks'];

function listLength(list) {
  const state = store.get();
  if (!state.board) return 0;
  if (list === 'needs') return state.board.needsYou?.length ?? 0;
  if (list === 'agents') return rosterRows(state.board, state.selection).rows.length;
  return state.board.tasks.length;
}

function moveCursor(delta) {
  const state = store.get();
  let cursor = state.cursor;
  if (!cursor) {
    const first = SECTION_ORDER.find(list => listLength(list) > 0);
    if (!first) return;
    cursor = { list: first, index: 0 };
  } else {
    const length = listLength(cursor.list);
    const next = cursor.index + delta;
    if (next < 0 || next >= length) {
      // Cross section boundary.
      const direction = delta > 0 ? 1 : -1;
      let sectionIndex = SECTION_ORDER.indexOf(cursor.list) + direction;
      while (sectionIndex >= 0 && sectionIndex < SECTION_ORDER.length) {
        const list = SECTION_ORDER[sectionIndex];
        const listLen = listLength(list);
        if (listLen > 0) {
          cursor = { list, index: direction > 0 ? 0 : listLen - 1 };
          store.update({ cursor });
          return;
        }
        sectionIndex += direction;
      }
      return;
    }
    cursor = { list: cursor.list, index: next };
  }
  store.update({ cursor });
}

function nextSection() {
  const state = store.get();
  const current = state.cursor ? SECTION_ORDER.indexOf(state.cursor.list) : -1;
  for (let step = 1; step <= SECTION_ORDER.length; step += 1) {
    const list = SECTION_ORDER[(current + step + SECTION_ORDER.length) % SECTION_ORDER.length];
    if (listLength(list) > 0) {
      store.update({ cursor: { list, index: 0 } });
      return;
    }
  }
}

function activateCursor() {
  const state = store.get();
  if (!state.cursor || !state.board) return;
  const { list, index } = state.cursor;
  if (list === 'needs') {
    const need = state.board.needsYou[index];
    if (need) actions.jumpToNeed(need);
  } else if (list === 'agents') {
    const row = rosterRows(state.board, state.selection).rows[index];
    if (row) actions.selectAgent(row.agent.name);
  } else {
    const task = state.board.tasks[index];
    if (task) actions.selectTask(task.id);
  }
}

document.addEventListener('keydown', event => {
  const state = store.get();
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
  if (typing) return;
  if (state.paletteOpen || state.helpOpen) {
    if (event.key === 'Escape') { actions.closePalette(); actions.closeHelp(); }
    return;
  }
  switch (event.key) {
    case '/': actions.openPalette(); event.preventDefault(); break;
    case '?': actions.openHelp(); break;
    case 'j': case 'ArrowDown': moveCursor(1); event.preventDefault(); break;
    case 'k': case 'ArrowUp': moveCursor(-1); event.preventDefault(); break;
    case 'Tab': nextSection(); event.preventDefault(); break;
    case 'Enter': activateCursor(); break;
    case 'f': if (state.selection?.kind === 'task') actions.toggleLens(); break;
    case 'Escape': actions.closeInspector(); break;
    default: break;
  }
});

// ── transport wiring ──────────────────────────────────────

const lastSeen = loadLastSeen(localStorage);
let digestComputed = false;

connectLive({
  token,
  onBoard(board) {
    const patch = { board };
    if (!digestComputed) {
      digestComputed = true;
      patch.digest = computeDigest(board, lastSeen);
      const initial = parseHash();
      if (initial) patch.selection = initial;
    }
    store.update(patch);
    saveLastSeen(localStorage, maxEventId(board));
  },
  onStatus(connection) {
    if (connection !== store.get().connection) store.update({ connection });
  },
});

window.addEventListener('hashchange', () => {
  const selection = parseHash();
  if (selection) store.update({ selection });
});

// ── render loop (one paint per frame) ─────────────────────

const root = document.getElementById('app');
let scheduled = false;
function paint() {
  scheduled = false;
  render(h(App, { state: store.get(), actions }), root);
}
store.subscribe(() => {
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(paint);
  }
});
paint();
