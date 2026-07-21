# Swarm CLI — Troubleshooting

Operational notes for diagnosing and recovering the swarm CLI when it breaks. Maintained from real session incidents.

---

## better-sqlite3 NODE_MODULE_VERSION mismatch

### Symptom

Every `swarm <cmd>` errors with one of:

```
Error: The module '.../node_modules/better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 141. This version of Node.js requires
NODE_MODULE_VERSION 137.
```

— or:

```
Error: Could not locate the bindings file. Tried:
 → .../node_modules/better-sqlite3/build/Release/better_sqlite3.node
 → ...
```

### Cause

`better-sqlite3` is a native addon keyed to a specific Node ABI. Agents on the same machine often have different `node` first on PATH (Homebrew Node 25 vs nvm Node 24), so `#!/usr/bin/env node` would load a mismatched binary.

| Node version | NODE_MODULE_VERSION (ABI) |
|---|---|
| node 22.x | 127 |
| node 24.x | 137 |
| node 25.x | 141 |

### Preferred fix — pin Node for swarm (machine-local)

`bin/swarm` is a bash launcher that prefers:

1. `$SWARM_NODE` (absolute path to a node binary)
2. `~/.swarm/node-path` (one line: absolute path — **not in the git repo**)
3. first `node` on PATH

Pin this host once (match the ABI of the installed prebuild; currently Node 24 / ABI 137):

```bash
mkdir -p ~/.swarm
echo '/Users/tom/.nvm/versions/node/v24.14.1/bin/node' > ~/.swarm/node-path
swarm members   # should work even if Homebrew node 25 is first on PATH
```

### Auto-repair — official prebuild download

If the active node still mismatches, `bin/swarm-entry.mjs` downloads the matching WiseLibs prebuild for the current ABI (does **not** run `npm rebuild`, which thrash-fetches the wrong ABI mid-session). One re-exec after download.

Manual equivalent:

```bash
ABI=$(node -e "console.log(process.versions.modules)")  # e.g. "137"
VERSION=$(node -p "require('/Users/tom/Developer/Ridge.io/swarm/node_modules/better-sqlite3/package.json').version")
cd /tmp
curl -sL "https://github.com/WiseLibs/better-sqlite3/releases/download/v${VERSION}/better-sqlite3-v${VERSION}-node-v${ABI}-darwin-arm64.tar.gz" -o bsq.tgz
cd /Users/tom/Developer/Ridge.io/swarm/node_modules/better-sqlite3
rm -rf build
tar -xzf /tmp/bsq.tgz
swarm members
```

### Anti-patterns to avoid

- ❌ `npm install` / `npm rebuild` in the swarm dir during a live session — repeatedly deletes and re-fetches the wrong prebuild, breaking every connected agent's swarm CLI for minutes at a time.
- ❌ `--build-from-source` — fails on Python 3.14 expat issue.
- ❌ Pinning to an older `better-sqlite3` (e.g. 11.10.0) hoping a different prebuild — the same ABI mismatch logic applies.
- ❌ Un-pinning `~/.swarm/node-path` while multiple agents share one install — each agent's PATH may thrash the single shared `.node` binary.

---

## Mid-session agent rescue (CLI broken, swarm DB intact)

When the CLI breaks mid-session, agents can still write to the swarm DB at `~/.swarm/swarm.db` directly via `sqlite3`:

```bash
# Register an agent manually
sqlite3 ~/.swarm/swarm.db "INSERT INTO agents (name, surface, status, joined_at, last_seen_at) VALUES ('AgentName', 'manual', 'active', datetime('now'), datetime('now'))"

# Send a message
sqlite3 ~/.swarm/swarm.db "INSERT INTO messages (from_agent, to_agent, body, created_at) VALUES ('FromAgent', 'ToAgent', 'message body', datetime('now'))"
```

Used by `BugFix-Atomic` on 2026-04-29 to deliver a 4-hour-stale proposal that would otherwise have been lost.

---

## Side effect: stale undelivered messages after a CLI break

When the CLI is broken, **messages can land in the DB but inbox-cursor delivery to the recipient may not fire** (the cursor update happens inside the recipient's own `swarm inbox` call, which is itself broken). Result: messages sit unread for hours, even after the CLI is repaired.

### Recovery query

```bash
sqlite3 /Users/tom/.swarm/swarm.db \
  "SELECT id, created_at, from_agent, to_agent, substr(body, 1, 200)
   FROM messages
   WHERE created_at > datetime('now', '-6 hours')
   ORDER BY id DESC
   LIMIT 50"
```

Run this **after every CLI repair** to find any orphan messages that landed during the outage. The recipient won't see them via `swarm inbox` until they explicitly poll.

---

## Cleaning zombie agent registrations

When cmux workspaces are closed, the agent rows persist in `~/.swarm/swarm.db`. They show up in `swarm members` but consume nothing. If the listing gets cluttered:

```bash
sqlite3 ~/.swarm/swarm.db \
  "DELETE FROM agents WHERE name IN ('Stale1','Stale2',...)"
```

---

## Local reserved agent names (not in the git repo)

Some machines keep OpenClaw / A2A identities that local Cmux agents must not claim.

- Config file (machine-local): `~/.swarm/reserved-names` — one name per line, `#` comments OK
- Or env: `SWARM_RESERVED_NAMES=Forge,Cooper` / `SWARM_RESERVED_NAMES_FILE=/path/to/file`

`swarm join` rejects reserved names. The list is **never** committed to the swarm repo — each host maintains its own. A2A registration is not blocked (those names are intended for remote agents).

---

## Grok CLI: queue vs send-now (Enter)

### Behavior

Grok's TUI mid-turn input has two modes (footer: `Enter:send now` / `Ctrl+;:queue`):

- **Single Enter after a push** — message is **queued** (does not interrupt the current turn). This is the default for `swarm send` / `swarm broadcast`.
- **Double Enter** — force **send-now / interject**. Only used when the sender opts in.

### Opt-in interject

```bash
swarm send Brillo "urgent: stop and review" --interject
swarm broadcast "drop everything" --now
```

`--interject` / `--now` only changes delivery for agents with `host_agent = 'grok'` (second Enter). Claude/Codex still get one Enter.

### Host tagging

Join records `host_agent` via `detectHost()` (`GROK_AGENT` / `CMUX_AGENT_LAUNCH_KIND=grok`). Existing sessions refresh on whoami/inbox/status. Manual tag:

```bash
sqlite3 ~/.swarm/swarm.db "UPDATE agents SET host_agent = 'grok' WHERE name IN ('Forge','Brillo','Quill');"
```

---

## Messages keep reappearing in my hook

### Cause

The awareness hook deliberately peeks: injection is not acknowledgement. A delivery remains pending across turns until the recipient acks it, so context loss cannot silently consume an instruction. After repeated injections the hook collapses the body to a reminder, but it still does not clear the row.

### Fix

Use the message ID shown by the hook:

```bash
swarm ack 41
# or, after reviewing everything pending:
swarm ack --all
```

A plain `swarm inbox` read also acknowledges every row it prints. `--peek`, `--recent`, and kind-filtered reads do not.

---

## Janitor heartbeat stale

The board/hook becomes loud after the WI-5 heartbeat threshold (30 minutes). Check that `~/Library/LaunchAgents/io.swarm.janitor.plist` exists and still points at the current Node binary and built `dist/index.js`. Re-run `swarm janitor install` if the plist is missing or stale.

The prompt hook is the fallback trigger: `hook-context` piggybacks an observe-only tick when the last census is old. If both triggers are uncertain, run the same safe census manually:

```bash
swarm janitor tick --observe
swarm board
```

If the manual tick succeeds but the heartbeat later goes stale again, inspect the launchd plist/registration and confirm the active agent host is actually running the swarm awareness hook.

---

## Served board port is already in use

`swarm board --serve` binds only to `127.0.0.1:7787`. If startup reports that port 7787 is already in use, either stop the older board process or choose another loopback port:

```bash
swarm board --serve --port 7790 --tab
```

## Served board API returns 401

The served board uses a fresh per-process token. Open the exact URL printed by the current `swarm board --serve` process; stale tabs and URLs from an earlier process have an expired token. For direct API diagnostics, copy the current token into `X-Swarm-Token` or the `?token=` query parameter.

---

## Task close refuses because evidence does not match the claim

Read the claim kind and expected evidence kinds in the refusal; the CLI prints both. Inspect the durable contract with `swarm task show <slug>`, then retry with the named kind:

```bash
swarm task show design-audit
swarm task close design-audit --disposition archive \
  --evidence report:/absolute/path/to/audit.md \
  --not-established "runtime behavior"
```

`journey:<path>` and `deploy-health:<path>` must name existing files; `report:<path>` must also be non-empty; `decision:<id>` must exist in this swarm. A deploy-health URL is checked once with a two-second best-effort request; network failure is recorded as `unverified` and does not block close. A probe may use `--outcome inconclusive` instead of report evidence.

Every close, including an override, must type `--not-established "<text>"`; use `"none"` only when that is honest. To bypass an evidence or Git gate deliberately, pass both `--override --reason "<text>"`. The reason and exact bypassed-gate list are recorded in a `gate_override` event.

## Task close refuses because Git state is not preserved

`task close` has an exact-count preservation gate. The error reports all three blocking counts: `unpushed commits: N, dirty tracked files: N, untracked files: N`. For `pr` or `merged`, the recorded branch tip must also be reachable from a remote ref.

The normal fix is to push the branch and clean or commit the worktree. The explicit escape hatches are:

- Preserve the worktree with `swarm rescue --task <slug>`, verify the artifact, then close with `--disposition archive`.
- Intentionally throw it away with both `--disposition discard --force-discard`. This is event-logged and cannot be requested with only one of the two flags.

```bash
swarm rescue --task auth-refresh
swarm task close auth-refresh --disposition archive --not-established "none"

# destructive intent, double-confirmed:
swarm task close auth-refresh --disposition discard --force-discard --not-established "none"
```

---

## Rescue verification failed

Read the `manifest.json` path printed in the error. The manifest records the source worktree/repository, task and agent attribution, HEAD and branch, porcelain status, dirty/untracked counts, artifact sizes and SHA-256 checksums, changed-source checksums, and any locally unreachable branches. A failed verification sets `verified: false`, clears `verified_at`, and puts the concrete mismatch in `verification_error` (for example a missing bundle, checksum mismatch, restore-status mismatch, or changed-file mismatch).

Verification restores into a temporary directory. It does not clean, reset, remove, or otherwise repair the source worktree; the source is left untouched. If the artifact itself is damaged, keep the source in place and create a fresh rescue artifact rather than treating the failed manifest as preservation evidence. Re-check an intact artifact with:

```bash
swarm rescue --verify <artifact-dir>
```

---

## Long-term fixes (not yet implemented)

- **Vendor a working prebuild** in this repo so `prebuild-install` doesn't have to fetch.
- **Pin a single better-sqlite3 version** that has the right prebuild for whatever node version is actually used in production environments.
- **Migrate to `node:sqlite`** (built-in node 22+) so there's no native dep at all.

Any of these would fix the recurring break. Worth a small PR when next touching the swarm tool.
