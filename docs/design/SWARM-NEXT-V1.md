# SWARM-NEXT v1 — design & specification

Status: APPROVED FOR BUILD (Tom, 2026-07-19). Author: Fable-class lead (Sweeper session), per the routing rule that spec/architecture is frontier-model work and implementation routes to Codex.
Provenance: synthesis of (a) the 2026-07-18 introspection review + Leasehold proposal, (b) a two-round, two-model-family research panel (codex gpt-5.6-sol + independent claude, repo-blind web research then repo-grounded gap analysis; grok failed 4/4 runs), (c) the field evidence from the week-long PromptEden GA run and its cleanup (~28 orphaned worktrees, ~129 stranded commits, dead registrations, stale-doctrine replay). Full trail: `Ridge.io/.briefs/swarm-next-plan.md`, `.briefs/swarm-introspection-review-and-leasehold-proposal.md`, judge files under `~/.local/state/alloy/runs/20260719T*/judge.json`.

---

## 1. Philosophy (the opinionated part)

The swarm's first self-improvement wave fixed *messaging* and left *lifecycle* unmanaged, because messaging pain is visible per-turn while lifecycle debt accrues silently until a cleanup crew has to archaeology it out. This design inverts the system's defaults around five principles, each carrying its evidence:

**P1 — Tasks, not agents, are the durable unit of work.** Agents are disposable processes; the assignment, its lease, its checkpoints, and its evidence live in SQLite rows that survive any agent. A dead agent's open tasks ARE its handoff. (Temporal's worker/workflow split; Kubernetes lease objects; codex-panel top adoption #1.)

**P2 — Context is externalized continuously, or it never existed.** Every task carries an event-triggered checkpoint trail (goal, decisions+why, failed approaches, next action) plus git commits. A fresh context reorients from files in minutes; killing an agent loses minutes, not a context window of paid tokens. Checkpoints are 300–600 tokens at phase boundaries — never per-turn narration, which is furnace behavior. (Anthropic long-running-agent harness — progress files + git as memory; Manus filesystem-as-context; Amp's handoff-over-compaction; both panelists' #1 recommendation. A dead agent's transcript already persists on disk — we additionally index it, we do not dump it into context.)

**P3 — Authority is fenced, not assumed.** Liveness (TTL, heartbeat) detects death; it cannot prevent a paused agent that wakes after expiry from making stale writes. Every task lease carries a monotonically increasing epoch; correctness-sensitive mutations must present the current epoch and are refused otherwise. (Kleppmann's fencing-token argument; codex-panel "most urgent gap".)

**P4 — The bus shrinks; files and the ledger carry coordination state.** The strongest cross-source research finding: successful long-running fleets nearly eliminate agent-to-agent messaging (Anthropic's 16-agent C-compiler swarm coordinated via git + task-lock files with NO message bus; AgentTaxo's communication-tax measurements; MAST's inter-agent-misalignment failure class). The bus keeps: dispatch, gates/escalations, handoff pointers. It loses: status narration (→ journal), acks (→ delivery metadata), polling (→ deterministic watchers), doctrine (→ versioned files + spawn packets). Messages carry pointers; specs live in files.

**P5 — Enforcement is deterministic; convention is a bug report waiting to happen.** Every rule that matters is either enforced at a CLI/code boundary or mechanically re-injected into every agent turn (the hook). Doc-only rules already failed in the field — including the self-improvement process leaving its own merged worktree behind. Deletion is last: observe → hold → rescue → quarantine → delete, with a verified preservation artifact before anything is removed.

### Non-goals (deliberately not built, with reasons)

- **No vector memory** — grep+files beat embeddings for code (Anthropic removed embeddings from Claude Code; Cursor/Devin converged).
- **No auto-written doctrine** — automatic memory accumulation underperforms human-gated curation (Cursor shipped-then-killed Memories; MemGhost injection risk).
- **No debate loops** — fail vs self-consistency at equal compute.
- **No new daemons beyond the janitor tick**; no Temporal/BEAM — we steal recovery-boundary/fencing/supervision *semantics* onto the SQLite substrate we already trust.
- **No deletion of anything in v1.** The janitor observes and rescues only.
- **No hash-chained audit logs, dual-scheduler watchdogs, quota debt-inheritance, per-turn served-law digests** — cut by unanimous two-family panel verdict as v3 machinery ahead of need.
- **No node:sqlite migration in v1** — recorded as a known dependency risk (better-sqlite3 ABI breaks take down all coordination at once; TROUBLESHOOTING.md), scheduled post-v1.

---

## 2. Current state (verified against source, 2026-07-19)

- Schema (src/db.ts): `swarms`, `agents`, `messages(id, swarm_id, from_agent, to_agent NULL=broadcast, body, delivered, created_at, kind)`, `inbox_cursors(swarm_id, agent_name, last_read_id)`. Additive-nullable-column migration pattern established (`ensureMessageKindColumn`).
- `getInbox` (src/mailbox.ts:116-155): cursor-watermark reads; **consuming by default**; kind-filtered reads peek-only by construction; `ORDER BY created_at` with cursor advanced from the last row (dormant ordering bug, TODO-ARCH §3).
- Hook (src/index.ts:288 `printHookContext`): injects members + inbox into every turn via UserPromptSubmit across all three harnesses (hooks.ts); **consumes messages** (peek=false) — headless at-most-once-with-loss. Piggybacks redeliver-worker spawn (the proven anti-entropy-on-access pattern).
- Broadcasts are `to_agent IS NULL` rows; a first-join agent has no cursor row → `lastReadId=0` → **replays all historical broadcasts as live doctrine**.
- No resource-lifecycle verbs of any kind. No task concept. `swarm reset` wipes; reap is invocation-only; headless rows never auto-pruned (registry.ts:415).
- MESSAGE_KINDS = status|digest|merge-req|escalation|ack|gate, validated at CLI boundary.
- Tests: 12 files under tests/, run via `npm test` (tsx). All must stay green.

---

## 3. Work items

Conventions for all items: follow the existing additive migration pattern in src/db.ts (new tables `CREATE TABLE IF NOT EXISTS` in `migrate()`; new columns via ensure-column guards). All timestamps ISO-8601 UTC strings. All new name comparisons `COLLATE NOCASE` (field-proven bug class). Never weaken sanitize()/execFileSync guarantees (transport.ts). Every behavior change lands with tests; every refusal path prints an actionable message. Keep the CLI thin — no frameworks, no manager layers (repo design constraint).

### WI-1 — Broadcast backfill fence + supersession  (S)

**Motivation.** A day-14 replacement agent's first read replays weeks of stale orders as live doctrine (verified: mailbox.ts:124-141). Supersession must be explicit metadata, not recency (STALE benchmark: implicit supersession ≈55% accuracy even for the best systems).

**Spec.**
1. On first-ever join of a name in a swarm (no existing `inbox_cursors` row), initialize the cursor to `MAX(messages.id)` for that swarm (0 if none). Applies to `joinAgent`, `joinHeadlessAgent`, `joinA2AAgent`. A re-join with an existing cursor row keeps it (a returning agent may still want what it missed; DMs can only be addressed to registered agents, so no legitimate pre-join DM exists to lose).
2. `swarm inbox --recent N` remains the deliberate archaeology path (unchanged) — fencing hides history from the *default* read, it does not destroy it.
3. New column `messages.superseded_by INTEGER` (nullable, additive). New flag `swarm send/broadcast --supersedes <msg-id>`:
   - Validates: the referenced message exists in this swarm AND `from_agent` matches the sender (case-insensitive). Refuse otherwise ("you can only supersede your own messages").
   - Sets `superseded_by = <new id>` on the referenced row (a tombstone pointing forward).
4. Read behavior: `getInbox` and hook injection EXCLUDE superseded rows (`superseded_by IS NULL`). `--recent` INCLUDES them, annotated `[superseded by #<id>]`. Rationale: default reads must never serve a stale order as live; history stays inspectable.
5. Chains are allowed (A superseded by B, B by C); each read simply filters non-null.

**Acceptance.** New-join agent sees zero historical broadcasts in inbox/hook; `--recent` still replays; superseding message hides its target from all default reads including other recipients' unread inboxes; non-owner supersede refused; existing tests green.

### WI-2 — Pull/ack delivery inversion  (M)

**Motivation.** The hook consumes on read: a compacted turn or an ignored injection silently marks messages read (headless data loss, field-observed). TODO-ARCH 5.1/5.3. Delivery state must be per-recipient and explicit.

**Spec.**
1. New table:
```sql
CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id INTEGER NOT NULL,
  swarm_id TEXT NOT NULL,
  recipient TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | injected | acked
  first_injected_at TEXT,
  inject_count INTEGER NOT NULL DEFAULT 0,
  acked_at TEXT,
  PRIMARY KEY (message_id, recipient)
);
```
   New sends eagerly create one delivery row per exact recipient registration, plus a durable push-outbox row, in the same transaction as the canonical message. This makes commit durable before terminal/A2A push and prevents a same-name replacement from inheriting a direct message. Legacy rows without recipient IDs remain readable through lazy delivery-row creation and the cursor compatibility path.
2. **Hook reads become peek-only.** `printHookContext` calls `getInbox(..., peek=true)` and additionally filters to messages NOT `acked` by self. Each shown message: upsert delivery row, increment `inject_count`, stamp `first_injected_at`. Display includes the message id: `[#142 10:31 AM] [gate] Yulan: ...`.
3. **Re-injection backoff.** A message with `inject_count >= 3` (or `first_injected_at` older than 45 min) collapses to one summary line in the hook: `(#142 from Yulan, unacked for 52m — swarm inbox --recent to review, swarm ack 142 to clear)`. Never auto-acked, never silently dropped. Constants as named exports for tuning.
4. **`swarm ack <id...>`** — marks only those exact delivery rows acked for self; advances the legacy `inbox_cursors` watermark to `max(acked ids, current)` for backward compatibility. Ack is idempotent. `--all` is refused and no bulk-ack library helper exists.
5. **Explicit `swarm inbox` (no flags)**: displaying a message IS an explicit read — it acks what it prints (delivery rows + cursor), preserving current UX. `--peek`, `--recent`, `--kind` never ack (unchanged semantics; kind-filtered stays peek-by-construction).
6. Cursor-ordering defensive fix (TODO-ARCH 5.x) while the file is open: `getInbox` orders `BY id ASC`; watermark advances via `Math.max(...ids)`.
7. `swarm stats` gains an unacked-age section: per agent, count + max age of unacked deliveries (replaces silence-based stall inference with delivery-grounded evidence).

**Acceptance.** A hook injection followed by session death leaves messages pending (re-shown next turn); ack clears; third re-show collapses to summary; explicit inbox still one-shot reads; watermark still moves so old builds interoperate; A2A send path untouched; tests cover the compaction-loss scenario (peek → no cursor movement), backoff, idempotent ack, mixed-build tolerance (delivery table absent rows).

### WI-3 — Task ledger, checkpoints, handoff, fencing  (M) — the context-insurance item

**Motivation.** P1/P2/P3. Mechanizes: named-branch-only work (detached HEADs unconstructable), checkpoint discipline, succession without archaeology, stale-authority refusal.

**Spec.**
1. Tables:
```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT NOT NULL,                  -- slug [a-z0-9-]{3,64}
  swarm_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',        -- open|active|awaiting_review|done|abandoned
  owner_agent TEXT COLLATE NOCASE,
  owner_agent_id TEXT,                       -- immutable active registration ID
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,                     -- soft TTL, default now+24h, renewed by checkpoint
  repo_path TEXT, branch TEXT, worktree_path TEXT,
  transcript_hint TEXT,                      -- harness + cwd + session file path when detectable
  disposition TEXT,                          -- pr|merged|archive|discard (set at close)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (swarm_id, id)
);
CREATE TABLE IF NOT EXISTS task_events (    -- append-only
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  swarm_id TEXT NOT NULL, task_id TEXT NOT NULL,
  epoch INTEGER NOT NULL, kind TEXT NOT NULL, -- started|checkpoint|claimed|handoff|closed|refused_stale_epoch|...
  actor TEXT, actor_agent_id TEXT, data TEXT, -- immutable provenance + JSON
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  swarm_id TEXT NOT NULL, task_id TEXT,
  body TEXT NOT NULL, made_by TEXT NOT NULL,
  actor_agent_id TEXT, task_epoch INTEGER,
  supersedes INTEGER,                         -- decisions.id
  status TEXT NOT NULL DEFAULT 'active',      -- active|superseded
  created_at TEXT NOT NULL
);
```
2. **`swarm task start <slug> --title <t> [--repo <path>] [--no-worktree]`** — creates or claims the task: state=active, owner=self's immutable registration ID, `lease_epoch += 1`, records `transcript_hint` (detectHost() + process.cwd() + best-effort harness session dir). When `--repo` given and not `--no-worktree`: creates branch `swarm/<agent>/<slug>` and worktree at `~/.swarm/wt/<repo-basename>/<agent>--<slug>/` (canonical namespace; refuse /private/tmp and workspace-root targets). Claiming an actively-owned task requires `--takeover`; taking over another registration additionally requires active Owner/Lead authority, bumps the epoch, emits an ID-provenanced `claimed` event, and durably queues a notification to the exact previous registration. Legacy name-only owners fail closed until `swarm task rebind <slug> --to <agent> --reason <text>` performs an Owner/Lead-authorized, audited epoch bump. Every git invocation uses execFileSync.
3. **`swarm task checkpoint <slug> [--notes <text>]`** — fenced: caller must match both the current owner registration ID and epoch (implicit: CLI rereads the row; a takeover or same-name rejoin fails the comparison and records a refusal). Writes `~/.swarm/briefs/checkpoints/<swarm>/<slug>/NNN.md` from the skeleton (below), pre-filled with mechanical facts (HEAD sha, branch, dirty/untracked counts via git when repo known); `--notes` fills the narrative section; without `--notes`, prints the skeleton path and instructs the agent to edit it, exiting nonzero until the file contains no `<FILL>` markers (checkpoint isn't "done" until the thinking is in it). Renews `lease_expires_at = now+24h`. Records a checkpoint event with exact actor ID. A handoff may only consume a checkpoint whose event is from the current owner registration at the current epoch.
   Checkpoint skeleton (exact headings, machine-parseable):
```markdown
# checkpoint <slug> #NNN
- state: <one line>
- head: <sha> on <branch> (dirty: N, untracked: M)
## decisions (+why, +rejected alternatives)
<FILL>
## failed approaches (do-not-repeat)
<FILL>
## next action
<FILL>
## blockers / landmines
<FILL>
```
4. **`swarm task close <slug> --disposition pr|merged|archive|discard`** — fenced. Refuses while the task worktree/branch has (a) unpushed commits (`git log <branch> --not --remotes` non-empty), (b) dirty tracked files, or (c) untracked files — unless disposition=archive AND a rescue artifact exists (WI-4), or `--force-discard` (double-confirm flag, event-logged). pr/merged evidence: branch tip sha reachable from any remote ref (`git branch -r --contains`); no hard `gh` dependency in v1. On success: state=done, disposition recorded, worktree removed via `git worktree remove` (branch ref kept — refs are cheap, worktrees are debris).
5. **`swarm handoff offer <slug> --to <agent>` → `swarm handoff accept <slug>`** — requires a current-owner/current-epoch checkpoint fresher than 60 min (or `--stale-ok`, which labels the brief STALE). Composes an immutable charter under `~/.swarm/briefs/handoff-offers/` with the latest checkpoint verbatim + task row facts + unpushed-branch inventory + transcript_hint. The durable `handoff_offers` row binds source epoch, both exact registration IDs, charter SHA-256, pickup deadline, pointer message ID, and delivery state. Offer creation and pointer/outbox enqueue commit atomically before push and leave the source lease unchanged. Only the bound recipient registration can accept; acceptance re-hashes the charter and atomically transfers name+ID, bumps the epoch, records the event, and queues its acknowledgement before push. Expiry, digest mismatch, clock rollback, or changed source/recipient authority fails closed without transfer. The fleet-wide janitor records expiry and exactly-once durable notifications for the sender and active Owner/Lead registrations. `status` exposes pending/injected/acked pickup. Immediate handoff is unsupported.
6. **`swarm decision <text> [--task <slug>] [--supersedes <id>]`** — one-line durable decision journal (`DECISION: X BECAUSE y` doctrine). Task-bound decisions require the current ID+epoch-fenced owner. Program decisions require active Owner/Lead authority. Every decision records immutable actor provenance; only the exact original active registration may supersede an active decision at the same scope, and a transaction/index fence permits a single successor. Parser help, missing flag values, and unknown flags fail without inserting a row. Cheap, greppable, survives every context death.
7. **Hook integration** (printHookContext): one line when self owns active tasks: `Your task: <slug> [<state>] — last checkpoint 94m ago (stale — swarm task checkpoint <slug>); next: <first line of ## next action>`. Threshold 90 min for the stale nag. No task → no line (zero tax).
8. MESSAGE_KINDS += `'handoff'`.
9. `swarm reset` preserves `tasks/task_events/decisions` tables (hygiene state survives fleet resets).

**Acceptance.** start→checkpoint→close happy path; takeover bumps epoch and stale owner's checkpoint/close refused (event recorded); close refused on unpushed/dirty/untracked with exact counts in the message; handoff refuses stale checkpoints; offer leaves source authority unchanged; exact recipient acceptance transfers once; expired/tampered offers never transfer; `ack --all` is refused; skeleton `<FILL>` gate works; hook line appears only for owners/offered parties; branch always named (no detached HEAD constructible through these verbs); worktrees only under `~/.swarm/wt/`; reset preserves ledger.

### WI-4 — `swarm rescue`: verified preservation artifacts  (S)

**Motivation.** Codifies the manual cleanup procedure that saved ~129 commits. Correction from the panel (factual): **git bundles do not carry dirty or untracked state** — preservation = bundle + patches + untracked archive, and it is not preserved until a restore is proven.

**Spec.**
1. **`swarm rescue --worktree <path> | --task <slug> | --agent <name>`** (agent = all worktrees recorded on their tasks). For each target worktree:
   a. If HEAD is detached: create branch `rescue/<agent-or-unknown>/<slug-or-basename>-<yyyymmdd>` at HEAD.
   b. Artifact dir `~/.swarm/archive/rescue/<basename>-<yyyymmddHHMM>/`: `repo.bundle` (git bundle: HEAD + all local branch tips of that worktree's repo not reachable from remotes), `staged.patch` (`git diff --cached --binary`), `unstaged.patch` (`git diff --binary`), `untracked.tar.gz` (`git ls-files --others --exclude-standard -z | tar`), `manifest.json` (worktree path, repo, branch, HEAD sha, per-file checksums, counts, created_at, swarm/task/agent attribution).
   c. **Verification (mandatory, recorded in manifest):** `git bundle verify`; clone bundle to a temp dir, apply both patches, extract tar, compare resulting `git status --porcelain` + checksums against manifest. `verified: true` only on full match; on any failure the command exits nonzero and says exactly what didn't restore.
2. Rescue NEVER deletes, unregisters, or modifies the source worktree (beyond creating the rescue branch ref).
3. `swarm rescue --list` enumerates artifacts with verification state.
4. Artifact dirs are plain files — they ride the existing cross-laptop rsync mesh for off-host redundancy (documented, not automated, in v1).

**Acceptance.** Detached-HEAD + dirty + untracked fixture round-trips: rescue → wipe a copy → restore from artifact → byte-identical status; verification failure path exits nonzero; source untouched (git status identical before/after apart from the new ref).

### WI-5 — Janitor tick, observe-only census + deadline enforcement  (M)

**Motivation.** P5. Census-adopt is the PRIMARY mechanism (harnesses create most worktrees — the EXP-005 debris was harness-made, not verb-made). Deletion is not in this item; there is nothing destructive to configure wrong.

**Spec.**
1. **`swarm janitor tick --observe`** (the flag is required in v1; destructive filesystem/repository phases remain deliberately unbuilt). Singleton-locked via the redeliver.ts stale-break lock pattern. The filesystem/repository pipeline is read-only outside `~/.swarm`; the same tick also sweeps handoff deadlines across every swarm and commits idempotent coordination-ledger expiry/escalation rows:
   a. Heartbeat: upsert `janitor_status` (single row: last_tick_at, last_duration_ms, counters JSON).
   b. Repo census over roots from `~/.swarm/janitor-roots.json` (human-edited JSON array; `swarm janitor roots add/remove/list` to manage; seeded on first run with registered swarm root_paths). Per root: `git worktree list --porcelain` → orphans (gitdir missing), detached HEADs, per-worktree dirty/untracked counts; local branches with upstream `: gone`; unpushed-commit counts (`git log --branches --not --remotes --oneline`).
   c. Temp scan: `/private/tmp` + `$TMPDIR` top level for entries with a `.git` file/dir whose gitdir resolves into a census root (worktrees stranded in temp — the field pattern).
   d. Junk heuristic: direct children of census roots that contain ONLY build output (node_modules/.astro/dist/build/.next and no tracked source, no .git) — the pe-marketing-pixel class.
   e. Findings upsert into `janitor_findings(id, first_seen_at, last_seen_at, kind, path, detail JSON, state)` — state always `'hold'` in v1 (panel correction: unknown ≠ expired; nothing is ever marked deletion-eligible here). Resolved findings (path gone) marked `cleared`.
2. **Triggers** (both, complementary):
   a. Hook piggyback (primary — the proven cleanupStale-rides-listAgents pattern): in `printHookContext`, if `janitor_status.last_tick_at` is older than 10 min, spawn a detached `swarm janitor tick --observe` exactly like `spawnRedeliverWorker`. Runs when the fleet is active — when debris is being made.
   b. **`swarm janitor install`** — writes `~/Library/LaunchAgents/io.swarm.janitor.plist` (StartInterval 900, RunAtLoad) invoking the built CLI's `janitor tick --observe`; covers idle-fleet windows. `swarm janitor uninstall` removes it.
3. **Visibility:** hook-context gains one line: `janitor: tick 4m ago | debris: 3 worktrees (1 detached), 129 unpushed commits, 2 temp strays, 1 junk dir` — with a LOUD variant when last_tick_at > 30 min (`janitor heartbeat stale`). `swarm stats` gains the same counters as a section; counters snapshotted per tick into `janitor_status.counters` history table `janitor_snapshots` for trend lines.
4. Tick must be fast (<5s typical) and safe under concurrency (lock) and mid-tick crash (next tick recomputes from reality — no incremental state to corrupt).

**Acceptance.** Fixture with a detached-HEAD worktree, a `: gone` branch, a temp-stranded worktree, and a junk dir: one tick populates findings with correct kinds/counts, all state=hold; second tick is idempotent (last_seen_at moves, no dupes); removing a fixture clears the finding; hook line renders both fresh and stale variants; tick refuses to run without --observe; launchd plist installs/uninstalls cleanly; no path outside ~/.swarm is written.

### WI-6 — Documentation, doctrine, process  (S, split Fable/Codex)

Codex scope (technical docs, same PR as the code they describe): update README.md command reference; CLAUDE.md architecture section (new tables, verbs, hook behavior, janitor); TROUBLESHOOTING.md entries for ack/backoff and janitor lock; mark TODO-ARCHITECTURE 5.1/5.3/5.x as landed with commit refs (do not delete the file's history).

Fable scope (judgment docs, this session): `docs/philosophy.md` (the P1–P5 essay with sources — the durable "why"); replace `docs/model-routing.md` with the merged role×model×fallback table + quota-band protocol; move the org doc into the repo as `docs/org-template.md` (role templates + messaging rules, roster-free — the live roster is runtime state, not doctrine); orchestration.md addendum: bus-shrinking doctrine, journal/checkpoint rules, "a completion claim without its artifact is an ack, not a fact" cross-reference to `task close` evidence gates; experiments.md entries EXP-006..EXP-010 (one per WI, each with hypothesis, guard metric, due-date for the measurement — the loop governs its own rollout).

### WI-7 — `swarm board`: live operator visibility  (M, builds after WI-3/WI-5 land — it renders their tables)

**Motivation (Tom, 2026-07-19, recorded as a standing constraint).** The move to task-based durability must never cost the operator visibility. Tom runs agents as cmux tabs precisely to SEE what each is doing and to adjust their CLIs in-session (model, effort, fast/priority modes). Policy: **builders stay interactive cmux sessions by default; headless is for mechanical sweeps only.** The board complements the tabs — it answers "what is the fleet doing and who needs me," while the tabs remain the drill-down and control surface. Research grounding: fleet dashboards should be one-row-per-TASK, not per-terminal, organized around urgency triage ("which agent needs a human right now") — the converged pattern across solo-operator fleet tooling.

**Spec (v1 — a refreshing TUI, zero new infrastructure).**
1. **`swarm board [--watch [N]]`** — renders the fleet state to the terminal; `--watch` clears and re-renders every N seconds (default 5). Read-only; every section is a straight query over existing tables. Designed to live in a dedicated cmux tab.
2. Sections, in urgency order:
   a. **NEEDS YOU** — pending gate/escalation/merge-req-kind messages unacked, tasks in `awaiting_review`, stalled tasks (no checkpoint/commit evidence > threshold), janitor heartbeat stale. Empty section renders as one quiet line.
   b. **TASKS** — one row per non-done task: `slug | state | owner(epoch) | model/host | checkpoint age | branch (pushed?/dirty) | next-action (first line)`.
   c. **FLEET** — one row per registered agent: name, host_agent, current task, last progress evidence age (last checkpoint/commit/ack, NOT last message — progress-based per P3), unacked count.
   d. **DEBRIS + QUOTA** — janitor counters (worktrees/unpushed/strays/junk, tick age) and the current capacity bands (read from the program task's checkpoint when present).
3. Rendering: plain box-drawing text, no TUI framework (repo thin-CLI constraint); color via the existing chalk-free ANSI conventions if any, else none. Must degrade cleanly when tables are missing (pre-WI-3 DBs) — print the section header + "not available (WI-N not landed)".
4. **v2 sketch (not in v1):** `swarm board --graph` emitting a mermaid org/flow diagram (hierarchy from org template roles + live task assignments) to an HTML file for richer visualization; `--tab` auto-opening a dedicated cmux surface via the existing cmux CLI integration. Both deliberately deferred until the text board proves its render is the right content.

**Acceptance.** Board renders all four sections against a fixture DB; --watch refreshes; graceful degradation on missing tables; needs-you section correctly surfaces an unacked gate message, an awaiting_review task, and a stale janitor heartbeat; runs read-only (no writes to any table).

### WI-7b — `swarm board --tab`: one-command cmux tab  (S, landed increment)

**Motivation.** The v1 board prints to stdout; putting it in a dedicated cmux tab is a manual `cmux new-workspace … --command` step. `--tab` makes it one command so the operator never has to remember the cmux incantation (Tom's visibility constraint — the board should be trivially summonable).

**Spec.**
1. `swarm board --tab [--watch [N]]` — spawns a new cmux workspace whose command is `swarm board --watch <N>` (default N = BOARD_DEFAULT_WATCH_SECONDS), reusing `spawnWorkspace(cwd, command)` from transport.ts. Workspace title `swarm board`. Prints the created workspace/surface ref, then exits (the spawned tab owns the live loop; the invoking process does not block).
2. `--tab` without cmux available (resolveCmux throws / not found): exit 1 with `cmux not found — run 'swarm board --watch' directly in a terminal you want to watch.` Never crash.
3. `--tab` is incompatible with `--graph` in a *text* sense only — see WI-7c for `--graph --tab` (browser pane). If both are passed, WI-7c's graph-tab path wins.

**Acceptance.** `--tab` invokes spawnWorkspace with the expected command string (unit-tested via an injectable spawner); cmux-absent path exits 1 with the guidance message; the spawned command string round-trips the interval.

### WI-7c — `swarm board --graph`: mermaid workflow diagram  (M, landed increment)

**Motivation.** The operator's original wish: a *visual* depiction of the swarm's shape — hierarchy/workflow, not a text table. Now buildable because WI-2/3/5 populate the tables it renders. This is the honest, data-grounded view: not a fictional org chart (roles aren't stored — they're declared in kickoff messages) but the LIVE work graph — who owns what, where work has been handed off, and what debris hangs off the fleet.

**Spec — the diagram (this is the design; render it faithfully).**
A mermaid `flowchart LR` (left-to-right) with three node families and a legend:

- **Agent nodes** — one per row in `agents`. Rounded (`(name)`). Label two lines: agent name, then host/type (`host_agent` if set, else `agent_type`). `classDef` by host: `hostClaude`, `hostCodex`, `hostGrok`, `hostGemini`, `hostA2A`, `hostHeadless`, `hostUnknown` — visually distinct fills. This encodes the multi-model composition of the fleet at a glance (the whole point of cross-family diversity).
- **Task nodes** — one per non-`done` task (plus tasks closed within the last 24h, dimmed). Rectangle (`[slug]`). Label two lines: slug, then `[state] · ckpt <age>` (checkpoint age via the same evidence path the text board uses; "no ckpt" if none). `classDef` by state: `stActive` (green), `stAwaiting` (amber), `stStale` (red — active but checkpoint older than CHECKPOINT_STALE_MINUTES), `stOpen` (grey), `stDone` (dim/struck).
- **Debris node** — one summary node from `janitor_status` counters: `debris\n<W> worktrees (<D> detached)\n<U> unpushed`. `classDef debrisWarn` (orange) when any count > 0, else `debrisOk` (muted). Include janitor tick age; if the heartbeat is stale, a `debrisStale` class (red border).

Edges:
- Agent `-->|owns|` Task for each task's `owner_agent` (solid).
- Agent `-.->|handoff|` Agent for each `task_events` row kind=`claimed` with a `previous_owner` in `data` (dashed, previous_owner → new owner), deduped.
- All task nodes `-.->` Debris is NOT drawn (debris is fleet-global, shown standalone with its own heading).

Also: a title line (swarm name + ISO timestamp + agent/task/debris counts), and a `subgraph legend` documenting the color classes. Empty swarm (no agents, no tasks) still renders a valid diagram with a single "idle swarm" note node + the debris node — never emits broken mermaid.

**Spec — output & delivery.**
1. `swarm board --graph [--out <path>] [--open] [--watch [N]]`:
   - Generates a self-contained HTML file (default `~/.swarm/board.html`; `--out` overrides) containing the mermaid diagram inside `<pre class="mermaid">`, mermaid loaded from a **pinned** CDN (`mermaid@11`) with `startOnLoad`, `theme` chosen from `prefers-color-scheme`, and a graceful fallback: if the script fails to load, the raw mermaid source stays visible in the `<pre>` (so the file is never blank offline). Page is theme-aware (dark/light via media query). Include a small header (title/counts) and, under `--watch`, an HTML `<meta http-equiv="refresh" content="N">` so the browser reloads as the file is regenerated.
   - Always prints the raw mermaid source to stdout too (pipeable, inspectable, greppable) and prints the written file path to stderr.
   - `--watch [N]`: regenerate the file every N seconds (default 5) until interrupted (mirrors the text `watchBoard` loop; injectable clock/exit for tests).
   - `--open`: after writing, open the file — macOS `open <path>` via execFileSync (best-effort; never fatal if it fails). 
2. `swarm board --graph --tab`: generate the HTML, then open it in a cmux **browser pane/workspace** pointed at the `file://` URL (`cmux new-workspace --name "swarm graph" ...` with a browser surface, or fall back to `--open`). Best-effort; document the fallback.
3. All generation is read-only over the DB (getDbReadOnly, no migrations, no writes). The only writes are the HTML file at `--out` and (under --tab) cmux spawning.

**Acceptance.** `--graph` emits valid mermaid for: a populated fixture (agents of ≥2 hosts, tasks in ≥3 states incl. a stale one, a handoff/claimed edge, non-zero debris) — asserting the presence of each node class, the owns/handoff edges, and the debris node; an empty swarm (valid diagram, idle note); missing tables (graceful — a minimal diagram or a clear "not available" note, never a crash). HTML file is written and contains the mermaid source verbatim (fallback-safe). Raw mermaid goes to stdout. `--watch` regenerates ≥2 times under an injected clock. No DB writes.

**Deferred to a later increment (still v2):** live handoff *volume* weighting on edges, message-flow edges (kept off by design — P4 says the bus should be small, so visualizing chatter would celebrate the wrong thing), and an in-CLI SVG render (keep the browser as the renderer — no headless-chrome dependency in a thin CLI).

### Tech-debt items (fold into the phase touching each file)

- getInbox `ORDER BY id` + max-id watermark (WI-2, stated there).
- stats.ts pair-key `\x00` separator → `'→'` so stats output is diffable/greppable (verify current code during WI-2 phase; cosmetic, test-covered).
- hooks.ts `SWARM_DIR` derivation via `new URL(import.meta.url).pathname` breaks on paths with spaces — use `fileURLToPath` (touch in WI-5 phase which extends the hook).

---

## 4. Rollout & measurement

Phases land as separate commits on `feat/swarm-next-v1`, each: implementation + tests green (`npm test`) + docs for that surface. Phase order: WI-1+WI-2 (mailbox/hooks lane) → WI-3+WI-4 (ledger lane) → WI-5 (janitor) → WI-6 (docs). Cross-family review: Codex implements, Fable-class reviews every diff before commit (this session); anything gate-critical gets a second look via `codex exec review` in a later session.

Observation week: janitor runs observe-only during the next PromptEden session; its census IS the debris baseline (EXP-010's measurement). Deletion phases get designed only after that baseline exists — with the panel's corrections (hold-not-expired adoption, verified artifacts, restore windows) as standing constraints.

Success criteria for the program (measured at the next session's retro): zero new stranded-commit incidents; zero stale-doctrine replays to new joiners; every agent death recoverable from checkpoint+handoff in <10 min of successor time; debris counters visible every turn and trending flat-or-down; message volume down with gate latency flat (guard metric).
