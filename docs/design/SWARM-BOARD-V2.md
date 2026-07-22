# Swarm Board v2 — design specification

Replaces the v1 served board (Cytoscape graph + right rail + ECharts timeline), which the operator judged a UI/UX failure. v1 is torn down wholesale; no incremental patching. Grounded in the 2026-07 research sweep: `OUT-ui-products.md` (16 shipped products surveyed), `OUT-ui-frontend.md` (stack), plus operator field evidence from the prompteden program.

## Why v1 failed (concrete, not aesthetic)

1. **Graph-first was the wrong primary.** A 3-agent swarm renders as a sparse Cytoscape diagram that answers no operator question. The field's consensus primary is a **status roster + attention queue** (Vercel rows, Warp badges, Claude Code agent panel); graphs are a drill-down lens, not a landing surface.
2. **No attention queue.** "NEEDS YOU" existed as a side-rail list, not as the organizing principle. The single most-documented UX failure in this product class is ambiguous attention (Devin's "falls asleep" backlash); the single most-praised pattern is an explicit inbox of blocking items.
3. **No re-entry story.** The measured cost of running agent fleets is 10–20 min/task of re-orientation (builder.io on Devin). v1 showed current state only — an operator returning after an hour reconstructed history from a timeline chart.
4. **Three disconnected surfaces** (graph / tasks table / timeline) with tab flips between structure and execution — the exact anti-pattern Airflow 3 was rebuilt to fix (merged grid+graph).
5. **Charts over answers.** ECharts mini-charts (task-state donut, debris trend) are dashboard theater: they compress numbers the operator wanted as *rows they can act on*.

## Design principles (from research synthesis)

- **P1 Attention first.** The board's job, in priority order: (1) what needs the human NOW, (2) what changed since they last looked, (3) what is everyone doing, (4) archaeology. Layout and sort order follow that priority everywhere.
- **P2 Tiny status vocabulary.** Agents have exactly four states: `working / needs-you / stale / idle` (agents have no data source for "failed"/"done" — those are TASK outcomes, which keep their own chip vocabulary). One color each, used identically in every view; status is always hue + text, never hue alone, at every width. (Amended post-review r1: the original five-state list mixed agent and task vocabularies.)
- **P3 Idle-collapse.** Idle agents collapse to one "N idle" row when >3; working/failed/selected rows never collapse (Claude Code agent-panel mechanics, copied deliberately).
- **P4 Semantic compression on timelines.** Task events group into outcome-colored spans (started→checkpoints→closed = one bar; refusals = attempt-count badge; instantaneous events = dots) — Temporal's group-span model. Raw events one click below.
- **P5 One surface, two lenses.** Structure (who owns what, handoffs) and execution (what's happening) are toggled lenses over the same selection state, never separate pages. Selecting a task in ANY lens selects it everywhere.
- **P6 Deep-linkable state.** Every filter/selection lives in the URL hash. Losing filter state on share is a documented LangSmith complaint.
- **P7 Keyboard-first.** `/` palette (jump to agent/task), `j/k` row navigation, `Enter` drill-down, `Esc` back, `?` help. Sub-100ms interactions; all rendering local.
- **P8 Re-entry digest.** On load/focus after >10 min away, a "since you left" strip: tasks that moved state, new needs-you items, closes, failures. Dismissable, one line each.
- **P9 Honest liveness.** Every agent row carries last-heartbeat age; every headless/pull-only seat shows unread-mail age. Staleness is rendered, never hidden (field evidence: the Ops seat limbo — a handoff sat unread 1.5h with no signal to anyone).

## Information architecture

Object model stays minimal: **agents, tasks, messages, events** (no new concepts — LangSmith's dense taxonomy is the named anti-pattern).

```
┌──────────────────────────────────────────────────────────────┐
│ header: swarm name · counts · freshness dot · since-you-left │
├──────────────────────────────────────────────────────────────┤
│ NEEDS YOU (attention queue — always first, hidden when empty)│
│  · one row per blocking item: kind, who, age, jump-to        │
├──────────────────────────────────────────────────────────────┤
│ AGENTS (roster)                                              │
│  · row: status-dot name task-slug last-event-summary age     │
│  · idle-collapse per P3; failed/needs-you sort to top        │
├──────────────────────────────────────────────────────────────┤
│ TASKS (swimlanes, the primary work surface)                  │
│  · one lane per active task: state chip, owner, claim kind,  │
│    checkpoint age, branch/unpushed badge, event group-spans  │
│  · lens toggle on the same selection: [flow] shows ownership │
│    /handoff/review edges as a small inline dag for the       │
│    SELECTED task only (not a fleet-wide canvas)              │
├──────────────────────────────────────────────────────────────┤
│ inspector drawer (right, slides over): selected agent/task — │
│  full event feed (virtualized), checkpoint text, evidence,   │
│  actions (focus terminal, copy slug, copy send-command)      │
└──────────────────────────────────────────────────────────────┘
```

Mobile/narrow (<700px): sections stack; roster and lanes become cards; inspector becomes full-screen sheet.

## Live updates

SSE (`/api/events`): server pushes `snapshot` (full board JSON, on connect and on reconnect) then incremental `change` events (agent heartbeat, task event, message, janitor tick). Client applies deltas; EventSource auto-reconnect gives resilience for free. Poll fallback at 5s if SSE unavailable. (Event-sourced substrate per OpenHands lesson; the task_events table is already append-only — the server tails rowids.)

## Visual language

Dark-first, terminal-adjacent: monospace numerals, high-contrast status hues on a near-black ground, generous row density (Vercel-style), zero decorative chrome, no charts unless a chart answers an operator question better than rows do. Light theme via `prefers-color-scheme`. All assets vendored (CSP unchanged: no external hosts).

## Cut from v1 (deliberately)

- Fleet-wide Cytoscape canvas (replaced by per-task inline flow lens) — cuts 480KB of vendor JS.
- ECharts (timeline group-spans render as plain DOM/SVG; debris trend becomes a janitor row) — cuts 1MB.
- Mermaid stays CLI-side only (`board --graph` file output), not in the served board.

## Stack

(From OUT-ui-frontend.md; recorded after that report landed — see Addendum A.)

## Server changes

- Keep: token+Host+CSP guard, `/api/board` snapshot, `/api/focus-agent`.
- Add: `/api/events` (SSE), `since you left` computed server-side from last-seen cursor (client sends its high-water event id).
- board-data.ts projection extended with: per-agent last-event summary, needs-you item kinds (blocking question, review request, escalation, failure, stale-heartbeat), unread-mail age per agent.

## Acceptance

- Operator answers "what needs me / what changed / what's everyone doing" in <5s each from a cold tab.
- Board legible at 1440px, 1024px, 700px, and 390px.
- No interaction >100ms; initial render <300ms on the mini.
- Keyboard-only operation possible for every read path.
- 283+ tests stay green; new tests: SSE endpoint, needs-you projection kinds, since-you-left cursor math.

## Addendum A — stack (locked 2026-07-22, per OUT-ui-frontend.md)

- **UI:** Preact 10.29.x + HTM 3.1.1, vendored browser ES modules, no build step, no JSX. One normalized store; render notifications batched to requestAnimationFrame.
- **Transport (snapshot-stream contract, amended post-review r1):** ONE SSE stream (`/api/events`), authenticated by an HttpOnly SameSite=Strict cookie minted by the `/` page (EventSource cannot set headers; the token never appears in URLs). Every frame is a FULL self-superseding board snapshot — deliberately NOT a delta/replay protocol: at fleet scale (<50 agents) a coalesced snapshot every ≥1s is smaller than the machinery to patch, and reconnect correctness is simply "adopt the next snapshot". `streamId` = server epoch (daemon restart detection); `seq` is per-connection and strictly monotonic (stale-duplicate guard only). Comment heartbeats ~12s; slow clients are disconnected rather than buffered; change detection covers every projected source (task events, messages, deliveries/acks, agent heartbeats and membership, grants, janitor ticks) and only advances its high-water mark on successful emits. Polling fallback (2s visible / 20s hidden, single generation, no overlap) engages when EventSource is missing, throws, closes, or goes silent past the 45s watchdog. The `after=<seq>` replay-ring design is the documented escalation if fleet size ever makes full snapshots expensive.
- **CSS:** hand-written dark-first tokens (Open Props borrowed as reference, not vendored wholesale); system fonts; 26px fixed rows; tabular numerals; `color-scheme`; status = hue + text/icon (never hue alone); `prefers-reduced-motion` honored.
- **Timeline:** CSS Grid swimlanes (chronology) — NOT a graph widget. Per-task flow lens: hand-laid SVG (<10 nodes, 3-column layered); d3-dag is the named escalation if topology grows.
- **Feed:** hand-rolled fixed-row virtualizer (spacer + translateY, rAF-coalesced passive scroll, keyed by event id, ring-buffer bounded); tail-follow releases when scrolled up ("N new events" resume chip); log text rendered as text nodes only (no innerHTML); TanStack Virtual is the named escalation for variable-height rows.
- **CSP (tightened from v1):** default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'. No inline anything; virtualizer positions via DOM style properties (allowed under style-src-attr 'none').
- **Vendoring:** vendor-lock manifest with upstream URL + SHA-256 per artifact; release script scans built assets for http(s):// references; no service worker.
- **Authorship (model inversion):** claude authors; codex (gpt-5.6-sol xhigh) adversarial-reviews with the claude-author prior (hunt missing behavior first).

## Known limits (accepted post-review r1, revisit if felt)

- Feed anchor preservation across head-eviction of the 200-event window is not
  implemented (appended-count tracking is): a scrolled-up reader can see a
  one-row shift when the window slides. Escalation: anchor by top-visible
  event id.
- Cursor navigation (j/k) skips the collapsed-idle row; native Tab reaches it.
- Digest scope is the 200-event window; a very long absence shows needs-you
  items plus the newest events only (truncation is not yet labeled).
