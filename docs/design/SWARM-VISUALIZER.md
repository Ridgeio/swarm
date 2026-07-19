# Swarm Visualizer — design & spec (supersedes the hand-rolled mermaid graph)

Status: PROPOSED (research complete, awaiting Tom's go). Author: Opus-class lead (Sweeper session). Supersedes the hand-rolled mermaid `swarm board --graph` (WI-7c in SWARM-NEXT-V1.md) — that was a proof of concept; this replaces it with mature off-the-shelf OSS per Tom's directive: *"use off-the-shelf open-source libraries/frameworks for node-based visualizations and task UIs — better looking, more capable, less for us to build and maintain."*

Provenance: a two-track research pass (2026-07-19) — a 6-category web-research workflow (React node libs, framework-agnostic graph libs, layout engines, dashboard/table/chart kits, agent-orchestration prior art, delivery+realtime) with a synthesized recommendation and an adversarial critic; plus an independent cross-model alloy panel (Codex + Claude, repo-grounded, web-enabled). Raw outputs: workflow `wf_cebf72ed-162`, alloy run `20260719T135712Z-56a55c`. Grok excluded (4/4 stub-failures this session — routing-table probation applied).

## 1. The decision (and the disagreement it resolves)

**Build v1 as a no-build, single self-contained HTML page — Cytoscape.js for the graph, Apache ECharts for the dashboard charts — served by the CLI and viewed in a cmux browser pane. Graduate to a React SPA only if daily use proves it.**

This is deliberately NOT the "strongest React stack." The research surfaced a genuine split:

- The workflow's synthesis recommended the **full React stack** (React Flow + @dagrejs/dagre + TanStack Table + shadcn/ui + Recharts + vis-timeline + Vite + Hono + SSE + WAL-watch) as most *capable*.
- The workflow's own **adversarial critic** and **both alloy panelists** independently said: for a solo operator with a 4–6 agent fleet whose explicit goal is *less to maintain*, that stack "answers the wrong question" — it removes bespoke viz code but adds ~10–12 libraries, a Vite/React/Tailwind build pipeline, a separate SPA workspace, an embedded HTTP server, SSE, a WAL-file watcher, and two vendored-source component kits (shadcn, Tremor) that get no `npm update` and must be hand-pulled forever. Three of the marquee picks are "bring your own UI assembly" (React Flow ships no layout, TanStack Table is headless, shadcn is copy-paste).

Weighting Tom's actual goal, the light path wins for v1. It still delivers everything mermaid can't (auto-layout, pan/zoom, click-to-inspect, live status recolor, a real dashboard) with a fraction of the surface. The React SPA is documented below as a **v2 graduation** with an explicit trigger, not a v1 target — the same "prove the content is right before investing in the render" discipline the original spec used to defer the graph.

## 2. v1 stack (the plan)

| Layer | Pick | License | Why |
|---|---|---|---|
| Graph engine | **Cytoscape.js 3.x** + **cytoscape-dagre** | MIT | Framework-agnostic vanilla JS → drops into a static HTML file with **no build step**. Real layered DAG auto-layout (cytoscape-dagre), pan/zoom, `onNodeClick`, and stylesheet-driven node styling (state pills/colors) out of the box. Mature (since 2016), actively maintained, TS types. The agnostic-graph survey and both the critic and the Codex panel converged here. |
| Dashboard + charts + timeline | **Apache ECharts 5** | Apache-2.0 | **One** library covers the fleet stat panels, sparklines (checkpoint-age/throughput trends), AND the Temporal-style event timeline — collapsing what the React path spread across Recharts + vis-timeline. Canvas-rendered, fast, themeable, permissive. (Drops vis-timeline entirely — the critic flagged it as maintenance-mode.) |
| Delivery | Self-contained HTML **served by the CLI** on `127.0.0.1`, opened in a **cmux browser pane** | — | Reuses the browser-workspace spawn path already built in `transport.ts` / `board.ts`. Keeps the operator inside cmux beside the agent terminals. A TUI has no analog to a pan/zoom node graph, so TUI-first would force us back into hand-rolling. |
| Data | Poll a JSON endpoint every ~2s (reuse the existing 5s watch loop + the read-only `query_only` connection already in `db.ts`) | — | Ship-today simplicity. **Do not** reach for SQLite `update_hook` — it's in-process only and blind to the other agent CLI processes writing the DB (each agent runs its own `swarm` invocation). WAL-file watching (`fs.watch` on `~/.swarm`) is the upgrade *if* 2s polling feels laggy — not a v1 requirement. |
| Libraries hosting | **Vendor Cytoscape + ECharts locally** (self-hosted JS), not a CDN | — | Fixes the real offline break observed 2026-07-19 (the mermaid `--graph` HTML loaded mermaid from jsdelivr and rendered blank with no network). |

**Shared pure data layer (non-negotiable — the key maintainability move).** Factor the projection both surfaces read from into a pure, read-only `board-data.ts` that returns structured objects (agents, tasks+evidence, ownership edges, handoff/claimed edges, urgent deliveries, debris findings, short history series). The ANSI text board (`renderBoard`) and the JSON endpoint that feeds the web graph both consume it. This keeps the two UIs semantically in sync and preserves today's deterministic, testable, pure-function boundary (mirrors the n8n "thin adapter — keep the domain model separate, map to the graph lib in one small layer" pattern). **If we can't share the data layer, we don't build the second surface.**

## 3. What v1 must show (grounded in prior art, not prettier edges)

The research is unanimous that the win over mermaid is **coordinated views + a time dimension**, not aesthetics. v1 implements:

- **Graph + inspector drawer** (LangGraph Studio / n8n / Langflow): the node stays in the graph; clicking it opens a side panel with the detail — agent (host/model, heartbeat, owned task, progress evidence, unacked messages) or task (state, owner/epoch, checkpoint age + next action, branch/git evidence, event timeline, decisions) or debris (individual `janitor_findings`, not just the counter). Sparklines and state pills live in this panel — **not inside the node** (this is what lets a canvas graph lib suffice and removes the strongest reason to need React).
- **Coordinated selection**: selecting a task highlights its owner and handoff path and filters the event timeline to that task — "open evidence without losing context." This is the single most-cited pattern that beats a static mermaid diagram.
- **Event timeline from `task_events`** (Temporal Web): our append-only event table is workflow history in the same shape. Render it as outcome-colored spans (ECharts), filterable, click-a-span for detail.
- **Live status recolor** (LangGraph Studio / Airflow 3): the same topology recolored as state changes (active/awaiting/stale/done) on each poll — a canvas re-render, not a full re-parse.
- **Dual-pane** (Airflow/Dagster): graph on one side, the urgency-triage fleet table (the existing `renderNeedsYou`/`renderTasks` queries) beside it, with a "only what needs me" filter.
- **The correct graph semantics** (Codex panel): this is **not an execution DAG** — it's a bipartite *ownership* graph (agent→task) plus a *social* handoff graph (agent→agent). No critical-path language. Distinguish `handoff` (intentional transfer, actor→`data.to`) from `claimed` (takeover, `data.previous_owner`→actor) — the current mermaid conflates them. Never visualize ordinary message traffic (P4: that would reward bus chatter over durable work).

## 4. The load-bearing work (do NOT hand-wave this)

Rendering a graph is the easy, solved part. The novel, hard work both the critic and Codex flagged is **`onNodeClick` → focus that agent's cmux terminal tab**. Design it up front against the existing `cmux-transport.ts` / `applescript-transport.ts` machinery and the `surface_id` already stored per agent. Contract: the browser calls one tightly-scoped localhost endpoint that resolves the *registered* `surface_id` and uses `execFile` to focus the surface — **never** a browser-provided command string.

## 5. v2 — graduate to a React SPA ONLY on a real trigger

If v1's static-HTML page proves the content is right AND its limitations become the actual daily pain — persistent selection lost on reload, no non-disruptive incremental updates, coordinated-filtering across three panels feels cramped — then graduate to: **React Flow (`@xyflow/react`, MIT) + @dagrejs/dagre (the SCOPED package; the unscoped `dagre` is the abandoned original) + TanStack Table (MIT, headless) + shadcn/ui + Recharts**, built with Vite/React in a **separate `web/` workspace**, served by **Hono + @hono/node-server** over **SSE** with WAL-file change detection. React Flow is the cross-model consensus for the full version (both panels + the workflow picked it; MIT, xyflow GmbH weekly releases). Do not adopt this speculatively — it is real new surface justified only by proven daily use.

## 6. Risks & traps (from the adversarial critic — bake these in)

- **Packaging collision**: `package.json` has `main: dist/index.js` and `prebuild: rm -rf dist`. A Vite build also defaults to `dist/`. If/when the SPA is built, output to `web/dist`, and encode frontend-build-before-publish ordering + a files allowlist. (v1's single HTML file sidesteps this entirely.)
- **Security beyond bind address**: `127.0.0.1` is necessary but not sufficient — a naive localhost server is reachable via DNS-rebinding from any browser tab and by any local process. Add an **Origin/Host-header allowlist or a random per-session token**. On the shared Tailscale tailnet, never bind `0.0.0.0` (would expose agent/task internals to the whole tailnet).
- **Data is untrusted**: checkpoints, message bodies, decisions, repo paths may contain secrets or prompt-injection content. Render everything as **text**, impose payload size limits, set a CSP, no runtime CDNs, validate all terminal-focus targets server-side.
- **License flags**: avoid **AG Grid Enterprise** (per-dev paid; Community mislabels `(e)` features), **MUI X** open-core, **GoJS/JointJS/ReGraph** commercial, **Grafana** (AGPL — steal the pattern, never embed). If layout ever moves dagre→**elkjs**, note it's **EPL-2.0** (not MIT) and async (Web-Worker) — changes the update loop, don't hot-swap. Install the **scoped** `@dagrejs/dagre` + `@dagrejs/graphlib`, not the abandoned unscoped originals.
- **Testability**: today's board is pure, deterministic, tested functions. Keep the projection layer pure; confine the SPA/SSE/fs.watch (v2) impurity to a thin shell so the data logic stays unit-testable.
- **macOS sleep/wake**: SSE connections and `fs.watch` handles break across sleep and WAL-checkpoint truncation — handle reconnect/re-establish (v2 concern).
- **package.json honesty**: only 2 real runtime deps today (`@a2a-js/sdk`, `better-sqlite3`); move `typescript`/`@types/*` to devDependencies so any new dep is measured against an honest baseline.
- **Prefect anti-pattern** (validates the whole directive): Prefect hand-rolled a bespoke high-performance flow-canvas renderer and accumulated infinite-canvas/blank-graph/high-CPU bugs. At swarm's scale, off-the-shelf is unambiguously right — which is exactly why we're retiring the hand-rolled mermaid.

## 7. Immediate, independent of the above

The current mermaid `swarm board --graph` renders blank offline because it CDN-loads mermaid. Whatever we decide on v1, **self-host that library locally** (vendor the file, replace the CDN URL) — a one-line-scope fix that makes today's graph work offline right now. Low risk, independent of the visualizer decision.

## 8. Build order (when approved)

1. **Fix offline** (§7) — vendor mermaid, independent, immediate.
2. **Factor `board-data.ts`** — pure projection shared by the text board and a new JSON endpoint. No UI change; pure refactor with tests.
3. **v1 graph** — Cytoscape.js + cytoscape-dagre in the self-contained HTML, fed by the JSON endpoint, 2s poll, vendored libs, node click → inspector drawer.
4. **v1 dashboard** — ECharts stat panels + the dual-pane fleet table beside the graph; the event timeline.
5. **Focus-cmux-tab** — the `onNodeClick`→`surface_id`→`execFile` integration (§4).
6. **(Gate) evaluate daily use** — only then consider v2 (§5).

Each step is small, shippable, and reversible; the text board (`renderBoard`) stays as the terminal/degraded fallback forever.
