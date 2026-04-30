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

The swarm CLI uses native `better-sqlite3` via `bin/swarm` (`#!/usr/bin/env node`). The native module ships prebuilds keyed to specific node ABIs:

| Node version | NODE_MODULE_VERSION (ABI) |
|---|---|
| node 22.x | 127 |
| node 24.x | 137 |
| node 25.x | 141 |

`prebuild-install` (run automatically on `npm install` / `npm rebuild`) frequently fetches the wrong ABI's prebuild, and the `build/Release/better_sqlite3.node` binary ends up incompatible with the active node. Compiling from source on Darwin currently fails with a Python 3.14 expat symbol error (`_XML_SetAllocTrackerActivationThreshold`), so source-build isn't a reliable fallback.

### Reliable fix — direct prebuild download

```bash
# 1. Get the active node ABI
ABI=$(node -e "console.log(process.versions.modules)")  # e.g. "137"

# 2. Get the installed better-sqlite3 version
VERSION=$(node -p "require('/Users/tom/Developer/Ridge.io/swarm/node_modules/better-sqlite3/package.json').version")

# 3. Download the matching prebuild
cd /tmp
curl -sL "https://github.com/WiseLibs/better-sqlite3/releases/download/v${VERSION}/better-sqlite3-v${VERSION}-node-v${ABI}-darwin-arm64.tar.gz" -o bsq.tgz

# 4. Replace the broken build dir
cd /Users/tom/Developer/Ridge.io/swarm/node_modules/better-sqlite3
rm -rf build
tar -xzf /tmp/bsq.tgz

# 5. Verify
swarm members
```

Confirmed working on 2026-04-29 with `v12.9.0` + `v137` (node 24) + darwin-arm64.

### Anti-patterns to avoid

- ❌ `npm install` / `npm rebuild` in the swarm dir during a live session — repeatedly deletes and re-fetches the wrong prebuild, breaking every connected agent's swarm CLI for minutes at a time.
- ❌ `--build-from-source` — fails on Python 3.14 expat issue.
- ❌ Pinning to an older `better-sqlite3` (e.g. 11.10.0) hoping a different prebuild — the same ABI mismatch logic applies.

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

## Long-term fixes (not yet implemented)

- **Vendor a working prebuild** in this repo so `prebuild-install` doesn't have to fetch.
- **Pin a single better-sqlite3 version** that has the right prebuild for whatever node version is actually used in production environments.
- **Migrate to `node:sqlite`** (built-in node 22+) so there's no native dep at all.

Any of these would fix the recurring break. Worth a small PR when next touching the swarm tool.
