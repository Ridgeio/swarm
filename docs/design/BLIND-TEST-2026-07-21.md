# Blind usability test — 2026-07-21

Method: a Codex CLI agent ("Glyph", gpt-5.6-sol high) was dispatched with ZERO briefing about the swarm system — one bootstrap hint (`swarm help --agent` exists), a small unit of work in a fixture repo, orders to learn only from what the system itself teaches, and a mandatory friction report. Sandbox: workspace-write + the swarm state dirs. Its self-report was cross-examined against the ledger's objective trail (they matched exactly). Raw report: session scratchpad `codex-blind-result.md`; ledger trail under task `uppercase-md`.

## Headline result

The teaching surfaces WORK under adversity. Despite a hostile sandbox (Codex denies `.git` writes → git kept failing in ways nothing explained), the blind agent: joined under a self-chosen name, discovered the task ledger, used `swarm run` for evidence, checkpointed, escalated with a packet, adapted rescue (`--task` refused → `--worktree` succeeded, verified), **declined `--override` and `--force-discard` as unauthorized**, verified its work, and handed off honestly instead of fake-closing. Its verdict: "the task ledger's refusals are more instructive than its top-level help." Escalate→handoff as the safe terminal path was DISCOVERED, not taught.

## Findings (fixes dispatched as phase F)

- **F1 (HIGH, bug): sandboxed observer falsely reaps live fleet.** Glyph's routine `swarm members` calls probed Lead's surface from inside a sandbox that could not reach the cmux socket; the failures accumulated dead-strikes and `cleanupStale` reaped the LIVE Lead registration mid-test (agents table went empty). Same failure class explains earlier mystery reapings (Herald; Lead on 2026-07-19). Fix: liveness verdicts require a competent observer — if the observing process cannot reach cmux at all (ping/socket check), skip ALL liveness accounting; observer blindness must never count as subject death.
- **F2 (MED, bug+teach): identity-waterfall hijack.** A headless join from a child process stamps the tty session marker and outranks the parent's cmux-surface identity — the blind agent's join made MY hook banner say "You are Glyph", and pre-join, Glyph's terminal showed "Lead (you)". Fix: a registered cmux surface (CMUX_SURFACE_ID) outranks the headless tty marker in getSelf; join warns when resolution would change identity mid-session.
- **F3 (S, teach): claim/evidence contract invisible until refusal.** Claim kinds and their evidence requirements appear nowhere in help; `task start` silently defaults the claim (Glyph got `analysis` for code work and only learned at close). Fix: `help --agent` documents the claim→evidence matrix one-liner; `task start` prints the chosen claim + what close will require + whether/how it can be changed.
- **F4 (S, teach): --no-worktree silently forfeits task-associated rescue.** Nothing warned that `rescue --task/--agent` would later refuse. Fix: task start with --no-worktree prints the tradeoff + the `rescue --worktree` alternative.
- **F5 (S, teach): docs/ROUTING.md cited without a findable path.** The blind agent honored the no-browsing rule and thus never found it. Fix: help footer prints the absolute path (resolved like vendor/).
- **F6 (S, teach, hypothesis untested): grant refusal names the remedy command without naming the ACTOR.** "Run exactly: swarm grant create ..." reads as an instruction to the refused agent — inviting self-granting. Glyph never reached this gate (sandbox), so the hypothesis stands unproven, but the wording contradicts the authority model either way. Fix: refusal routes through the operator ("request via swarm escalate <slug>; operator remedy: ...").

## Sandbox artifacts (not swarm bugs, worth knowing)

Codex workspace-write denies `.git` writes → branch/worktree creation and commits fail with messages the harness can't improve; `swarm read <agent>` fails without cmux socket access. Field rule: agents in restrictive sandboxes should be given `--no-worktree` tasks or full access.

---

# Round 2 — full access, responsive operator (same day)

Method deltas: `danger-full-access` (no sandbox artifacts), the operator (Lead) on duty and responsive, task requiring work "landed on main" (funnels to the merged-close grant gate). Agent: "Keel" (fresh Codex session, same one-hint bootstrap). Full loop achieved: task → worktree branch → commit → push → checkpoint → **escalation** → operator grant → close → **agent self-verification catching a false disposition** → operator lands → agent re-verifies → honest ack.

## Round-1 fixes CONFIRMED working in the field
- **F6**: refused at the grant gate, Keel escalated — did NOT self-grant (round-1's untested hypothesis, settled). It even declined to push to main while HOLDING a live merge grant, because the gates doc says Lead merges.
- **F3**: "task start clearly reported the owner, branch, worktree, claim kind, and lease."
- **F5/ROUTING**: it loaded exactly the two sections the routing table names for its two open decisions — decision-routed docs work.
- Escalation packets are decision-ready in practice (operator granted from the packet alone); `grant_used` audit + `--not-established` honesty both exercised.

## New findings (fixes = phase G)
- **G1 (HIGH, bug): surface capture at join.** The full-access child inherited `CMUX_SURFACE_ID` and `swarm join Keel` registered a SECOND cmux agent on the operator's surface; newest-wins resolution captured the identity and locked the operator out of the CLI entirely (operator actions had to go through the storage layer). Round-1's F2 fixed marker precedence — the wrong layer. Fix: cmux join REFUSES a surface already registered to a different name (guidance: child/scripted processes join `--headless`; explicit `--force-surface` to take over), and stale same-surface ghosts are removable.
- **G2 (HIGH, bug — found by the blind agent auditing its own close): "merged" reachability targets the wrong ref.** Close verified the commit reachable from ANY remote ref — the pushed feature branch satisfied it — and recorded `merged` while main didn't contain the work. Keel independently verified git, reported the false disposition with exact SHAs, and declined to self-repair. Fix: merged-disposition requires reachability from the repo's DEFAULT branch (remote HEAD → init fallback), close output prints source SHA / target ref / target SHA, success phrasing is "disposition recorded" unless landing verified, worktree removal only after verification passes.
- **G3 (S): no repair path for a false disposition** — add `swarm task reopen <slug> --reason` (audited, state→active).
- **G4 (S): `swarm inbox --wait <sec>`** — agents awaiting operators burned shell sleeps.
- **G5 (S, teach): close semantics** ("records a disposition; performs no merge") stated in help + the local/file-remote workflow documented.
- Observation (low): `swarm read <operator>` exposed operator commentary; Keel correctly treated it as context-not-decisions per doctrine — the org-template line held.

## What the test validated positively

Refusal quality (each refusal taught the next step), pull/ack durability (all 6 messages to an absent operator queued losslessly), escalation packets, verified rescue as the work-preservation path of last resort, handoff as honest terminal state, `help --agent` as "a strong capability map", and the agent's ledger trail as a faithful audit of its self-report.
