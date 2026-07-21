# SWARM-NEXT v2 — closing the harness-engineering gaps

Status: APPROVED FOR BUILD (Tom, 2026-07-20). Author: Fable-class lead. Source: docs/design/HARNESS-ENGINEERING-REVIEW.md (critic-verified gaps + reconsiderations). Folds three long-open items (sender auth, TODO-ARCH 5.4; janitor destructive-phase preconditions; node:sqlite) into one coherent tranche.

Build phases T1 → T2 → T3/4 → T5, each a separate reviewed commit. Conventions unchanged from V1 specs: additive migrations in migrate(); COLLATE NOCASE names; execFileSync only; actionable refusals (name the violated invariant, the target, the recovery command); tests per acceptance criterion; keep index.ts thin; never weaken transport sanitization.

**Honest trust-model note (applies to T2):** this is a single-machine, single-operator system. Grants and sender auth here buy *records, expiry, scope, and audit* — not cryptographic separation from a malicious local process. The spec says so plainly rather than pretending otherwise.

---

## T1 — Claim-typed close evidence + `swarm run` + audited override  (M)

**Gap:** close proves bytes-delivered, not outcomes; non-code work has no honest close; hard gates have no escape hatch. ("A green check proves only its assertion.")

1. **Claim kinds.** `tasks` gains `claim_kind TEXT` (additive). Values: `code-merged | journey-works | deploy-healthy | analysis | decision | probe`. `task start --claim <kind>`; default `code-merged` when a repo is attached, `analysis` with `--no-worktree`. Legacy NULL rows are treated as `code-merged`. `task list/show` and the board projection surface it.
2. **Evidence contract at close.** New required argument for non-`code-merged` claims: `--evidence <kind>:<ref>` (repeatable). Kind→claim matrix, refused on mismatch with a message naming the expected kinds:
   - `code-merged`: existing git gates unchanged (unpushed/dirty/untracked refusal + remote reachability for pr/merged). `--evidence` optional extra.
   - `journey-works`: ≥1 of `journey:<path>` (file must exist) or `journey:<url>` (recorded verbatim). Intent: a browsed-journey log/screenshot/recording.
   - `deploy-healthy`: `deploy-health:<url>` (recorded; CLI performs one best-effort HEAD/GET and records the status code alongside — network failure records `unverified`, never blocks) or `deploy-health:<path>` to a health-check log.
   - `analysis`: `report:<path>` (exists, non-empty).
   - `decision`: `decision:<id>` (row must exist in `decisions`) or `report:<path>`.
   - `probe`: `report:<path>`, or `--outcome inconclusive` (recorded honestly; a probe may legitimately establish nothing).
   Evidence rows are recorded as `task_events` kind=`close_evidence` (one per item, data = {kind, ref, verified}).
3. **Mandatory "not established" field.** Close requires `--not-established "<text>"` (what this evidence does NOT prove; `"none"` accepted but must be typed). Stored in the close event data and shown in `task show` + board inspector. This is the honesty ratchet: every close states its evidence ceiling.
4. **Non-code git-gate bypass:** claims without an attached repo skip git gates cleanly (verify current taskGitFacts null-repo path); claims WITH a repo still enforce them regardless of claim kind (code hygiene is orthogonal to the outcome claim).
5. **`swarm run [--task <slug>] -- <cmd> [args...]`** — the context-safe evidence wrapper:
   - Task resolution: `--task`, else infer from cwd being under a task's worktree_path; refuse with guidance if neither.
   - Runs the command (execFile semantics — first arg is the binary, no shell) with cwd = the task worktree (or cwd if no worktree), streaming full stdout+stderr to `~/.swarm/evidence/<swarm>/<task>/run-NNN.log` (NNN zero-padded sequence).
   - Prints: first 15 + last 25 lines of combined output (marked as truncated when applicable), the log path, and the true exit status; exits with the child's exit code.
   - Records `task_events` kind=`run` (data: argv[0], args count, exit, logPath, durationMs).
   - The evidence dir path is exactly what `--evidence journey:<path>`/`report:<path>` will typically reference.
6. **Audited override.** `task close ... --override --reason "<text>"` bypasses evidence/git gates: refused without `--reason`; records `task_events` kind=`gate_override` (data: reason, gates bypassed list). T2 tightens this to also require a live grant — build the event shape now.
7. Board/inspector: task detail shows claim kind, evidence list with verified flags, not-established text, and any override event prominently.

**Acceptance.** Per-claim-kind close matrices (right evidence accepted, wrong kind refused with expected-kinds message, missing file refused); not-established required (absent → refusal naming the flag); probe --outcome inconclusive path; legacy NULL claim behaves as code-merged; `swarm run` captures full log + bounded summary + true exit code (nonzero propagation tested), task inference from worktree cwd, refusal outside; override refused without reason, event recorded with gates list; deploy-health HEAD failure records unverified without blocking; board projection carries the new fields.

---

## T2 — Typed grants, escalation packets, sender auth  (M)

**Gap:** merge/prod/spend approvals are ad-hoc chat — unbounded, unrecorded, unexpirable. Sender identity is honor-system (TODO-ARCH 5.4, `SWARM_AGENT_NAME` spoofing).

1. **Grants table** (additive): `grants(id INTEGER PK, swarm_id, op TEXT, resource TEXT, granted_to TEXT COLLATE NOCASE NULL /*any*/, granted_by TEXT, note TEXT, created_at, expires_at, revoked_at NULL)`. Ops: `merge | prod | spend | override | custom:<name>`.
   - `swarm grant create --op <op> --resource <r> --ttl <dur> [--to <agent>] [--note <t>]` — records granted_by from the invoking identity; prints id + expiry.
   - `swarm grant list [--live]` / `swarm grant revoke <id>`. Every grant *use* records `task_events` kind=`grant_used` (grant id, op, resource, actor).
   - Resource matching: exact string, or grant resource `*`, or prefix match when the grant resource ends with `*` (e.g. `swarm/Foreman/*`).
2. **Enforcement chokepoints** (refuse-at-boundary, actionable message includes the exact `swarm grant create` command to fix):
   - `task close --disposition merged` (claim `code-merged`) requires a live `merge` grant matching the task slug OR branch.
   - `task close --override` now ALSO requires a live `override` grant matching the task slug (upgrades T1; reason still required).
   - Future prod/spend paths document the same check (no current CLI surface).
3. **`swarm escalate <task-slug> [--question "<text>"]`** — the decision-ready packet (the request side of a grant):
   - Generates `~/.swarm/briefs/escalations/<slug>--<yyyymmdd-HHMM>.md` from ledger state: current state/owner/epoch, latest checkpoint verbatim, evidence list, git facts, recent events, risk line, and THE question (from --question or the checkpoint's blockers section; refuse if neither yields one — an escalation without a question is noise).
   - Sends a pointer-only message kind=`escalation` to the lead/operator seat (resolve: agent named in `--to`, else the swarm's first-joined active agent, else print the path for manual delivery). Sets task state `awaiting_review`, event `escalated`.
4. **Sender auth (pragmatic).** `join` mints a `session_token` (random 32-hex) stored on the agents row (additive column) AND in the local session marker (tty session file / cmux surface record — mirror where identity already lives). Identity-resolving verbs (`send`, `broadcast`, `ack`, `task *`, `grant create`, `escalate`) verify the stored token matches the session's; mismatch → refuse with "identity could not be authenticated for <name> — rejoin with swarm join". `SWARM_AGENT_NAME` alone (headless path) additionally requires `SWARM_SESSION_TOKEN` env when the row has a token. A2A rows keep endpoint-based identity (documented). Closes TODO-ARCH 5.4 at the records-and-audit level per the trust-model note.
5. Board: NEEDS YOU surfaces live escalations (kind filter) and expiring-soon grants (<15 min); inspector shows grant usage on tasks.

**Acceptance.** Grant CRUD + expiry + revoke; resource matching table (exact/star/prefix); close-as-merged refused without live grant (message contains the create command) and succeeds with one, recording grant_used; override requires override-grant + reason; escalate builds the packet from a populated fixture, refuses without a derivable question, sends pointer-only, sets awaiting_review; token minted at join, verb refuses on token mismatch, headless env-token path, legacy rows (NULL token) grandfathered until next join; A2A unaffected; board projection additions.

---

## T3 — Worker-epoch registry + control retirement  (S)

**Gap:** all four CLIs ship monthly; routing/doctrine/EXP verdicts silently assume a dead epoch. P5 is a ratchet — no retirement path for standing controls.

1. **Epoch capture.** `agents` gains `worker_version TEXT` (additive): at join, best-effort capture — detectHost() + `<cli> --version` via execFileSync (claude/codex/grok/gemini binaries; 2s timeout; failure → NULL, never blocks join). Stored raw.
2. **Census check (janitor).** Track last-seen version per host_agent in a small `janitor_kv` table (or reuse findings): when a joining agent's version differs from the last recorded for that host, upsert finding kind=`worker-epoch-change` (detail: host, from, to) state=`hold`, surfaced in NEEDS YOU. The finding's remedy is procedural: docs/runbooks/requalify-worker.md (Fable-authored): rerun 2-3 golden journeys, revisit model-routing bands, run one subtraction test.
3. **Control registry.** `docs/controls.md` (Fable-seeded): a markdown table of standing controls — id, mechanism, guards-against, `retest_by` (ISO date), retirement condition. Janitor parses the table (strict `| id | ... | YYYY-MM-DD |` row regex; unparseable rows → one finding kind=`controls-file-invalid`) and flags rows past retest_by as kind=`control-retest-due` findings. This makes "tuned once, runs forever" mechanically visible.
4. **Subtraction EXP class** — doc template in experiments.md (Fable-scope): disable one control for a bounded window; the guard metric is the failure class it protects against; verdict retain/revise/retire.

**Acceptance.** Version captured at join (fixture with stubbed binary), NULL-safe; epoch-change finding fires once per transition and not on same-version rejoins; controls.md fixture with an overdue row → finding; invalid row → controls-file-invalid finding, no crash; NEEDS YOU shows both kinds.

---

## T4 — S-basket: observers hardened, agent-facing help, harness-review  (S)

1. **`query_only` observers.** Audit every read-path DB open (board server, board/graph render, stats): the read-only opener must set `PRAGMA query_only = ON` in addition to `readonly: true` (belt over suspenders — converts observe-only doctrine into refusal). Janitor keeps its writable handle for its OWN tables only; add a test asserting a janitor tick performs no writes outside `janitor_*` tables (compare table checksums).
2. **`swarm help --agent`** — compact capability catalog: one line per command grouped by lifecycle (join/identity, messaging, tasks+evidence, grants/escalation, board, janitor, rescue), ≤60 chars per line, zero prose. This is the joiner's map; the org docs stay the law.
3. **`swarm harness-review <task-slug>`** — the bounded improvement loop:
   - Prints the task's full event timeline (formatted: time, kind, actor, one-line data summary) + checkpoints list + evidence list.
   - Writes `~/.swarm/briefs/harness-reviews/<slug>--<date>.md` skeleton: `## earliest failed handoff` / `## smallest reversible intervention` / `## owning boundary (CLI refusal | census | hook | doctrine)` / `## EXP entry + rerun verdict (retain|revise|remove)` — each `<FILL>`-gated (exit 2 until completed, mirroring checkpoint discipline).
   - Prints the instruction to file the intervention as an EXP entry with a due date.

**Acceptance.** query_only enforced (write attempt through a read handle throws; janitor non-janitor-table checksum test); help --agent lists every registered CLI command exactly once (test cross-checks against the command switch); harness-review renders a populated timeline, writes the skeleton, exit-2 gate until filled.

---

## T5 — node:sqlite campaign with ratchet  (L, LAST, separate commit)

**Gap:** better-sqlite3 ABI breaks take down all coordination at once (TROUBLESHOOTING); half-finished migrations leave two eras as competing prompts — so this is a one-sweep campaign, not a gradual one.

1. Swap `better-sqlite3` → `node:sqlite` (`DatabaseSync`) across src/ in ONE change: prepare/run/get/all mappings; `.transaction()` helpers become explicit BEGIN IMMEDIATE/COMMIT/ROLLBACK wrappers (implement a small `withImmediateTransaction(db, fn)` in db.ts); `pragma()` calls become `exec('PRAGMA ...')`; readonly open uses `{ readOnly: true }` + `PRAGMA query_only`. Type surface: replace the `Database.Database` type imports with a local `SwarmDb` type alias exported from db.ts so the swap is one file's types.
2. Node engine floor: package.json `engines.node >= 24` (machine runs 25.9; bin/swarm's pinned-node mechanism unchanged).
3. **Ratchet:** a test (not a hook) that fails if `better-sqlite3` appears in package.json dependencies or any src/ import — the campaign cannot silently regress. Remove the dep; keep one TROUBLESHOOTING note for downgrade recovery.
4. Full suite green is the campaign's proof; the A2A/server/binary paths are the risk areas — run every test file, no skips beyond the known sandbox environmental ones.

**Acceptance.** All existing tests green on node:sqlite; ratchet test fails when a better-sqlite3 import is reintroduced (fixture); WAL/busy_timeout/foreign_keys pragmas verified applied; transactions still IMMEDIATE where they were.

---

## T6 — Model-inversion review routing  (S/M) — added 2026-07-21

**Source:** Greptile, "Model Inversion" (greptile.com/blog/model-inversion). Evidence: across 500 PRs/model, cross-model review beat same-model review in BOTH directions (Claude-authored: GPT 62.0% recall vs Opus 53.7%; Codex-authored: Opus 60.0% vs GPT 50.5%). Mechanism: "the types of bugs a model introduces most often are the same types it's more likely to miss during review." Category priors: Claude-authored → missing-behavior is the top hunt (GPT 69.0% vs Opus 63.3%); Codex-authored → build breakage (Opus 82.4% vs GPT 58.8%); semantic-intent/error-handling in Codex code are weak for BOTH (27.4%/22.6% ties — tests, not reviewers, must catch those). Caveat verbatim: "experimental… still learning how far the effect goes as models improve." This upgrades our existing cross-family rule (model-routing.md rule 3) from convention to enforced routing with priors.

1. **`swarm review <task-slug> [--to <agent>]`** — the review-request verb (sibling of escalate):
   - Resolves the AUTHOR model family from the task owner's `agents.host_agent` (claude-code|codex|grok|gemini → family claude|openai|xai|google; unknown → 'unknown').
   - `--to` given: refuse when the reviewer's family EQUALS the author's — message cites model inversion, lists live different-family members, and offers `--same-family-ok` (audited via task_events kind=`same_family_review` with a reason flag... require `--reason`). No `--to`: pick the live agent of a different family with the fewest open reviews (fallback: print that no cross-family reviewer is live and suggest spawning one).
   - Generates a review brief beside the escalation packets (`~/.swarm/briefs/reviews/<slug>--<ts>.md`): task state, checkpoint, evidence list, git facts, PLUS an **inversion prior block**: author family + the category priors table row for that family ("author: claude-family — prioritize: missing behavior; also semantic-intent/error-handling per baseline"). Priors live in a small exported map (REVIEW_PRIORS) so doctrine and code share one source.
   - Sends pointer-only kind=`gate` message to the reviewer; records task_events kind=`review_requested` (author_family, reviewer, reviewer_family); sets state `awaiting_review`.
2. Board: awaiting_review already surfaces; the inspector shows review_requested events with families.
3. Doctrine: model-routing.md rule 3 rewritten as "Model inversion (enforced)" with the numbers + caveat + source; org-template reviewer role references `swarm review`.

**Acceptance.** Family derivation per host; same-family refusal names live alternatives + requires reason on override (audited); auto-pick prefers different family; brief contains the correct prior block per author family; pointer-only message; events recorded; no reviewer live → actionable message, no state change.

## T7 — Automatic update awareness  (S) — added 2026-07-21

"Is this device current?" must not depend on anyone remembering `version --check`.

1. **Janitor tick step `checkSwarmVersion`** (observe tick): `git ls-remote origin master` on the swarm repo (execFile, 5s timeout — a pure network READ: preserves the tick's no-writes-outside-~/.swarm property; do NOT fetch). Cache {local_sha (rev-parse HEAD), remote_sha, checked_at, status: current|update-available|unknown} in janitor_kv. Any failure → status unknown, never fails the tick.
2. **Hook banner**: when cache says update-available, append one line: `swarm update available — cd <repo> && git pull && npm install && npm run build` (absolute repo path). Nothing when current/unknown (no noise).
3. **On every start**: `swarm join` prints the same line immediately from cache when update-available; when cache is absent or older than 6h, join spawns the detached janitor tick (existing spawnJanitorTick helper) so the cache refreshes without blocking the join. `swarm version --check` unchanged (full fetch + ahead/behind counts for explicit runs).
4. Tests: cache write from a stubbed ls-remote (current/differs/failure→unknown); banner line renders only on update-available; join prints from cache + spawns on stale-cache (injectable spawner); tick never fails on network error; no fetch invoked by the periodic path (assert runner args).

## T8 — cmux layout discipline: splits over new workspaces  (S/M) — added 2026-07-21

**Operator finding (Tom):** for see-two-things-at-once, a tiled split in ONE workspace beats a new workspace — but agents (and our own tools) default to `new-workspace`. Defaults ARE doctrine (P5), so both change together.

**Layout rules (doctrine, also §Fleet layout in org-template.md):**
- **New workspace** = a new CONTEXT only: one per swarm program (its agents, board, and briefs live there), or a genuinely separate repo/lane cluster. Agents never create workspaces as a side effect of "show something."
- **Tab (new surface in the current workspace)** = adding a swarmmate or long-lived surface to the SAME context.
- **Tiled split** = the default whenever the point is simultaneous visibility: board beside your work, watching another agent, comparing two outputs. 2–3 panes max; beyond that use tabs.
- **Headless** = scripted/short-lived children — no visual surface at all (G1 already routes them here).

**Mechanics (make the defaults match):**
1. transport.ts gains `spawnSplitInWorkspace(cwd, command, direction='right', workspaceId?)` using cmux `new-split <dir>` (resolve the created surface via list-pane-surfaces, send the command — mirror spawnSurfaceInWorkspace's pattern). Injectable for tests.
2. **`swarm board --tab` default flips to a SPLIT in the CURRENT workspace** (direction right). `--own-workspace` restores the old behavior (for the program-workspace setup case). Same for the graph browser pane (`board --graph --tab`): prefer a browser split/pane in the current workspace (cmux `new-pane --type browser --direction right --url ...` or equivalent — inspect cmux help), falling back to the existing browser-workspace path, then `open`.
3. **`swarm spawn`** (already surface-in-current-workspace by default — verify): gains `--split [dir]` (tiled beside caller) and `--new-workspace <name>` (program creation, names the workspace). Refuse `--new-workspace` without a name (named contexts only — no anonymous workspace litter).
4. Teaching: help --agent board/spawn lines mention split-default + when to use which container; hook banner unchanged (no room).
5. **Rider (wart from live use):** `task close --disposition discard --force-discard` additionally bypasses the claim-evidence matrix (it already bypasses git gates; discard declares the work void — demanding evidence for voided work forces theater). Audited event unchanged; `--not-established` still required.

**Acceptance.** spawnSplit sends the command into the new split surface (stubbed cmux runner asserts new-split + send); board --tab default splits in current workspace and --own-workspace creates the named workspace (old path preserved + tested); spawn --split/--new-workspace(name-required) paths; graph --tab prefers in-workspace browser pane with tested fallback chain; discard+force-discard closes an evidence-less analysis task (event recorded), while discard WITHOUT --force-discard still refuses; docs lines updated.

## Explicitly changed roadmap items (from the review)

- **React SPA graduation: DROPPED** (SWARM-VISUALIZER §5 edited): the served board meets the visibility claim; a promised second UI era is competing prompt material. Revisit only with a named unresolved decision it would resolve.
- Journals/learnings corroboration boundary: cheap form only for now — checkpoints remain same-task trusted; org-doc promotion stays human-gated (existing distillation loop doctrine); no curator automation until exhaust volume justifies it.
- Operator-attention accounting: passive metric only (computed from existing rows: operator messages, gate approvals, focus jumps per closed task) — a board panel later, no prompts at close.
