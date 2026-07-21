# Swarm — Architecture Critique & Improvement Roadmap

> **Landed via SWARM-NEXT v1:** The pull/ack, per-recipient delivery, and cursor-ordering items below landed on `feat/swarm-next-v1`; the governing rollout spec is [docs/design/SWARM-NEXT-V1.md](docs/design/SWARM-NEXT-V1.md). This file remains the historical critique and backlog for still-open items.
>
> **Status:** Historical critique plus active backlog. Captured 2026-07-03; landed items are marked in §5.
> **Source:** An `/alloy` multi-model panel (codex + grok + claude, each reading the
> real source tree read-only) plus the judge synthesis (Claude, with hands-on repo
> context from ~10 bug fixes landed on `master` this session).
>
> This is the durable record of *why the current delivery model has a ceiling* and
> *what to build instead*. Treat it as the north-star plan; open focused issues/PRs
> off the ranked fix list in §5.

---

## TL;DR verdict

- **The spine is sound.** SQLite (`~/.swarm/swarm.db`, WAL) + the mailbox model +
  the A2A HTTP transport are the right foundation and should be kept.
- **The delivery model is fundamentally limited, not merely rough.** "Deliver a
  message by *typing it into another terminal*, and surface the inbox by *injecting
  it into the next prompt*" is a **pull system wearing a push costume**. No daemon
  means SQLite can't notify, so "push" can only ever be "inject on next prompt" —
  and the terminal-keystroke hack exists purely to paper over that gap.
- **The fix is a delivery-layer refactor, not a rewrite.** Invert to an explicit
  durable-log **pull** model with acks, put a thin per-host daemon in charge of
  delivery + backpressure, authenticate senders, and demote the keystroke transport
  to an optional human-visible nudge.

Cross-model agreement is a strong *recommendation*, not proof — but three
independent models on the real code reached the same file-anchored conclusions, and
they match what had to be patched by hand this session.

---

## 1. Deficiencies that are *fundamental* (a ceiling, not a rough edge)

### 1a. Terminal-as-transport is UI automation cosplaying as IPC

`sendToSurface` (`src/transport.ts:109`) chunks a message into 60-char slices,
`cmux send`s each slice, then presses **Enter into another agent's interactive
prompt line**. All three panelists independently flagged this as a house of cards:

- **You are co-driving an input line you don't own.** If the recipient is
  mid-generation, in a tool call, or showing a permission prompt, your keystrokes
  interleave with its state. There is no framing, no "is the recipient ready?" — you
  type and hope.
- **The 60-char chunking (`CHUNK_SIZE = 60`, `src/transport.ts:49`, `:118`) exists
  specifically to dodge "Claude Code paste-bracket detection."** You are
  reverse-engineering a TUI's *undocumented* input heuristics. That is a **permanent
  maintenance tax against a moving target** — any Claude Code input change can break
  delivery silently. (grok's sharpest point.)
- **`sanitize()` (`src/transport.ts:37`) flattens every `\n \r \t` to a space.** The
  transport can therefore **only carry single-line prose** — no code block, no diff,
  no JSON, no stack trace, without corruption. That alone disqualifies it as a
  general agent-to-agent protocol. (claude's underrated catch.)
- **The AppleScript/Warp path is a footgun, not a transport.** It clobbers the
  user's clipboard and steals focus on every message, and the Warp focus fallback
  lands on **the frontmost tab** (`src/applescript-transport.ts`) — i.e. it can type
  a swarm message into whatever tab the human is actively looking at.

### 1b. Prompt-as-mailbox has opposite-and-both-wrong delivery semantics

The awareness hook (`hooks/swarm-awareness*.sh` → `swarm hook-context` →
`printHookContext` → `getInbox`) reads the inbox with **`peek=false`, which advances
the cursor** (`src/mailbox.ts`). Injecting the inbox into a prompt therefore
*consumes* it:

- **Headless path → at-most-once-with-loss.** If that turn is summarized/compacted,
  or the model simply doesn't act on the "NEW MESSAGES" block, the message is **gone,
  marked read, never retried.**
- **Cmux path → at-least-once-with-dupes.** It types the message *and* leaves it
  unread, so it gets re-injected next turn.
- **Neither path is acknowledged.** There is no delivery receipt, no idempotency key,
  no redelivery. The two transports have *opposite* failure modes and *both* are
  wrong.

**Root cause:** no daemon → SQLite can't push → "delivery" degrades to "inject on
next prompt." Everything in §1a is scaffolding to hide this.

---

## 2. What's simply *absent* to be a real substrate

Unanimous across the panel. None of these exist today:

| Missing capability | Consequence today |
|---|---|
| Delivery guarantees | Silent loss (headless) or dupes (cmux) |
| Acknowledgements | Sender never knows if a message landed or was acted on |
| Idempotency | Redelivery would double-execute instructions |
| Ordering integrity | Cursor advances by read-order, not a monotonic position (see §3) |
| Backpressure / rate-limiting | Unbounded fan-out → org-wide rate-limit incident (§2b) |
| Observability / audit | No log of what was delivered, to whom, acted-on or not |
| Real authentication | `[SWARM from X]` is sender-chosen text → injection primitive (§2a) |
| Supervision / lifecycle | No restart, no health, no dead-letter |
| Typed messages | Everything is one sanitized single-line string |

### 2a. Auth: `[SWARM from X]` is an open relay / prompt-injection primitive

The `from` label is just a string the sender picks (`src/mailbox.ts:28`), and the
awareness hook instructs **every agent to treat an inbound `[SWARM from ...]` line as
a peer command.** So any process that can reach `swarm send` (or inject the wire
format) can impersonate any agent and issue instructions. The entire safety story
rests on the "trusted environment" assumption — which is doing enormous load-bearing
work. (This is exactly why the "Bob" injection earlier this session was *possible*:
the model **permits** it by design; it was not a bug.)

### 2b. Backpressure: unbounded broadcast fan-out is the rate-limit root cause

`broadcastMessage` (`src/mailbox.ts`) does `Promise.all` over **every** recipient,
each injected message spawns an LLM turn, and the fan-out is unbounded. **This is
almost certainly what caused the org-wide rate-limit incident this session** — and
it's the one finding that reality has already proven, not just argued.

---

## 3. Judge addendum (context the panel lacked)

- **The deepest issue none of them named outright: economics.** Prompt-as-mailbox
  means *every delivered message = an LLM turn = money*. Coordination cost scales
  with `message_volume × model_price`, with **zero governor**. The rate-limit blowup
  wasn't just concurrency — the substrate's cost is **unbounded by construction**.
  Any real fix must put a token/turn budget somewhere (the daemon in §5.2 is the
  natural home).
- **On the cursor-ordering bug** (all three flagged `ORDER BY created_at` vs.
  cursoring on the max-by-position `id`): an adversarial verifier *empirically tested
  this exact code earlier this session* — it is **dormant.** SQLite's stable sort
  over the id-ordered index makes the last-returned row == max `id` in practice. So
  it's theoretically real but **low priority**; the fix (order by `id`, advance
  cursor via `Math.max(...ids)`) is trivial and worth doing **defensively** while the
  code is open.
- **~10 symptom fixes landed this session** (broadcast queued/failed counting,
  case-mismatch DM loss via `COLLATE NOCASE`, migration wedge/NOCASE-dedup, reclaim
  never auto-evicting a live agent, the `cleanupStale` strike-counter that could
  never accumulate, `getSelf` identity fall-through, rename-workspace Surface→
  Workspace id resolution). That **validates the panel's core thesis**: the rough
  edges are endless because the *delivery model's spine* is wrong. You can patch
  forever.

---

## 4. Fundamentally limited vs. rough — the answer to the key question

| | Verdict |
|---|---|
| **Fundamentally limited (needs a different spine)** | `cmux send` / `osascript` keystroke delivery, and "push without a daemon" generally. You cannot harden "I'm typing into a human's prompt line, against undocumented TUI heuristics, single-line only, with a lock that gives up under load." |
| **Rough but fixable (same spine)** | SQLite single file (great at this scale). The mailbox/cursor model (right idea — fix the cursor, make it non-consuming, add acks). **A2A — the only piece already built on a real protocol; it is the natural cross-machine spine and just needs acks + auth.** |

### Where the panel split (salvageability)

- **grok:** hard ceiling — doesn't scale, needs a different spine.
- **claude:** keep the spine — this is a *delivery-layer* refactor, not a rewrite.
- **codex (middle):** demote push to a *notification* path; move the authoritative
  control plane to a durable queue/protocol.

**Judge read:** claude is right on *tactics*, grok is right about the *keystroke
transport specifically*. The honest synthesis is **codex's framing** — keep
cmux/AppleScript **only** as an optional human-visible nudge, and make the
authoritative channel a durable **pull-log with acks, owned by a thin daemon**. That
is the line between "clever cross-terminal demo" and "reliable swarm of 5–10 agents
working unbabysat."

---

## 5. Highest-leverage fixes (ranked, with effort)

### 5.1 — Invert delivery to PULL  ·  ~1 day  ·  **do first**

**LANDED — `9743629` (`feat: broadcast backfill fence, supersession tombstones, pull/ack delivery`)**

Make the durable log the source of truth. Agents poll their inbox (they already do,
via the hook) and **ack explicitly**.

- Make the hook **`peek` (never auto-consume)** — read without advancing the cursor.
- Advance the cursor **only on an explicit ack**.
- Kills, in one move: headless data-loss, cmux dupes, multiline corruption, and
  focus-stealing (delivery no longer requires typing into a terminal).

**Touch points:** `printHookContext`/`getInbox` (`peek=true`), a new `swarm ack`
command + `acked`/cursor bookkeeping, hook script text.

### 5.2 — Thin per-host daemon (or long-lived `swarm watch`)  ·  2–3 days

**OPEN**

A single long-lived process per host that **holds the DB, owns delivery, and enforces
a concurrency cap + token bucket.**

- Direct cure for the §2b rate-limit fan-out — the daemon is the **governor** for the
  §3 economics problem (budget lives here).
- Natural home for observability/audit and for turning "inject on next prompt" into
  a real, rate-limited notification.

### 5.3 — Per-recipient delivery rows + acks + idempotency + status  ·  1–2 days

**LANDED — `9743629` (`feat: broadcast backfill fence, supersession tombstones, pull/ack delivery`)**

Add a per-recipient delivery table with a `status` column
(`pending | delivered | acked | dead`), redelivery, and dead-lettering.

- Gives real delivery guarantees + a complete audit trail.
- Idempotency keys so a redelivery never double-executes.

### 5.4 — Authenticate the sender  ·  ~1 day

**LANDED WITH TRUST-MODEL CAVEAT — SWARM-NEXT v2 T2**

Local joins issue a per-session token and identity-resolving verbs verify it
against the current TTY/Cmux marker. Legacy NULL-token rows are grandfathered
until rejoin; A2A endpoint identity is unchanged.

This lands records-and-audit identity checking, not a cryptographic security
boundary. A malicious local process under the same operator account can read the
database and marker files. See the [SWARM-NEXT v2 honest trust-model note](docs/design/SWARM-NEXT-V2.md#honest-trust-model-note-applies-to-t2).

### 5.5 — Retire / quarantine the AppleScript/Warp keystroke transport  ·  hours

Once inbox-pull (5.1) is primary, the keystroke path is net-negative (clipboard
clobber, focus theft, frontmost-tab footgun, single-line-only). Demote it to an
**optional human-visible nudge** or remove it.

### 5.x — Defensive quick win (independent of the above)

**LANDED — `9743629` (`feat: broadcast backfill fence, supersession tombstones, pull/ack delivery`)**

Fix the cursor ordering (§3) even though it's dormant: order by `id`, advance via
`Math.max(...ids)` instead of `created_at`. Trivial, do it while the file is open.

---

## 6. What to keep (explicitly)

- **SQLite + WAL** — correct choice at this scale; do not replace with a server DB.
- **The mailbox/cursor concept** — keep it; just make it non-consuming + acked.
- **A2A HTTP transport** — the only real-protocol piece; make it the cross-machine
  spine (it needs acks + auth, not replacement).
- **Identity resolution** (`getSelf` waterfall) — fine as-is after this session's
  fall-through fix.

---

## 7. Raw panel output

The full run — per-panelist `result.md` files (codex / grok / claude) plus the
judge's `judge.json` — is preserved at:

```
~/.local/state/alloy/runs/20260628T144527Z-badd36/
```

Unique per-panelist insights worth re-reading there:
- **claude:** `sanitize()` single-line-only limitation; AppleScript frontmost-tab
  fallback footgun.
- **codex:** broadcast `to_agent = NULL` lets a *newly joined* agent read historical
  broadcasts (backfill leak).
- **grok:** the 60-char chunking is a deliberate dodge of Claude Code's paste-bracket
  detection (fragile by design).
