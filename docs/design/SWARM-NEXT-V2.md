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

## Explicitly changed roadmap items (from the review)

- **React SPA graduation: DROPPED** (SWARM-VISUALIZER §5 edited): the served board meets the visibility claim; a promised second UI era is competing prompt material. Revisit only with a named unresolved decision it would resolve.
- Journals/learnings corroboration boundary: cheap form only for now — checkpoints remain same-task trusted; org-doc promotion stays human-gated (existing distillation loop doctrine); no curator automation until exhaust volume justifies it.
- Operator-attention accounting: passive metric only (computed from existing rows: operator messages, gate approvals, focus jumps per closed task) — a board panel later, no prompts at close.
