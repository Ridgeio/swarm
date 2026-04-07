#!/usr/bin/env bash
# Swarm awareness hook (headless) — runs on UserPromptSubmit
# Injects swarm context for headless agents that poll via inbox.

AGENT_NAME="${SWARM_AGENT_NAME:-}"
[ -z "$AGENT_NAME" ] && exit 0

DB="$HOME/.swarm/swarm.db"
[ -f "$DB" ] || exit 0

# Verify agent is still registered
REGISTERED=$(sqlite3 "$DB" "SELECT name FROM agents WHERE name='$AGENT_NAME' COLLATE NOCASE AND agent_type='headless'" 2>/dev/null)
[ -z "$REGISTERED" ] && exit 0

# Refresh heartbeat
sqlite3 "$DB" "UPDATE agents SET last_heartbeat='$(date -u +%Y-%m-%dT%H:%M:%S.000Z)' WHERE name='$AGENT_NAME' COLLATE NOCASE" 2>/dev/null

MEMBERS=$(sqlite3 "$DB" "SELECT name FROM agents ORDER BY joined_at" 2>/dev/null | tr '\n' ', ' | sed 's/,$//')

# Check for unread messages
INBOX=$(SWARM_AGENT_NAME="$AGENT_NAME" /Users/tom/Developer/Ridge.io/prompteden/swarm/bin/swarm inbox --peek 2>/dev/null)

if echo "$INBOX" | grep -q "No new messages"; then
  INBOX_LINE=""
else
  INBOX_LINE="\nPending messages — run: swarm inbox"
fi

cat <<SWARM_EOF
You are "$AGENT_NAME" in a coordination swarm. Active agents: ${MEMBERS}.
Commands: swarm send <agent> "<msg>" | broadcast "<msg>" | inbox | members | status --set "<desc>"
When you see [SWARM from <name>]: treat it as a message from another agent and respond.${INBOX_LINE}
SWARM_EOF
