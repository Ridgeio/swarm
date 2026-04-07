#!/usr/bin/env bash
# Swarm awareness hook (headless) — runs on UserPromptSubmit
# Injects swarm context and delivers pending messages inline.

AGENT_NAME="${SWARM_AGENT_NAME:-}"
[ -z "$AGENT_NAME" ] && exit 0

DB="$HOME/.swarm/swarm.db"
[ -f "$DB" ] || exit 0

# Verify agent is still registered
REGISTERED=$(sqlite3 "$DB" "SELECT name FROM agents WHERE name='$AGENT_NAME' COLLATE NOCASE AND agent_type='headless'" 2>/dev/null)
[ -z "$REGISTERED" ] && exit 0

# Refresh heartbeat
sqlite3 "$DB" "UPDATE agents SET last_heartbeat='$(date -u +%Y-%m-%dT%H:%M:%S.000Z)' WHERE name='$AGENT_NAME' COLLATE NOCASE" 2>/dev/null

SWARM_BIN="$(cd "$(dirname "$0")/.." && pwd)/bin/swarm"
MEMBERS=$(sqlite3 "$DB" "SELECT name FROM agents ORDER BY joined_at" 2>/dev/null | tr '\n' ', ' | sed 's/,$//')

# Read and consume pending messages (not peek — marks as read)
INBOX=$(SWARM_AGENT_NAME="$AGENT_NAME" "$SWARM_BIN" inbox 2>/dev/null)

if echo "$INBOX" | grep -q "No new messages"; then
  INBOX_SECTION=""
else
  INBOX_SECTION="
NEW MESSAGES (respond to these):
${INBOX}"
fi

cat <<SWARM_EOF
You are "${AGENT_NAME}" in a coordination swarm. Active agents: ${MEMBERS}.
Commands: swarm send <agent> "<msg>" | broadcast "<msg>" | inbox | members | status --set "<desc>"
When you see [SWARM from <name>]: treat it as a message from another agent and respond.${INBOX_SECTION}
SWARM_EOF
