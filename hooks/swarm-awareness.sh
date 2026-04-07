#!/usr/bin/env bash
# Swarm awareness hook — runs on UserPromptSubmit
# If this terminal is in the swarm, injects a compact reminder as system context.
# Also checks inbox for messages that were queued (not push-delivered).
# If not in the swarm, exits silently (no output, no cost).

SURFACE_ID="${CMUX_SURFACE_ID:-}"
[ -z "$SURFACE_ID" ] && exit 0

DB="$HOME/.swarm/swarm.db"
[ -f "$DB" ] || exit 0

AGENT=$(sqlite3 "$DB" "SELECT name FROM agents WHERE surface_id='$SURFACE_ID'" 2>/dev/null)
[ -z "$AGENT" ] && exit 0

# Refresh heartbeat on every prompt — keeps idle agents alive
sqlite3 "$DB" "UPDATE agents SET last_heartbeat='$(date -u +%Y-%m-%dT%H:%M:%S.000Z)' WHERE surface_id='$SURFACE_ID'" 2>/dev/null

SWARM_BIN="$(cd "$(dirname "$0")/.." && pwd)/bin/swarm"
MEMBERS=$(sqlite3 "$DB" "SELECT name FROM agents ORDER BY joined_at" 2>/dev/null | tr '\n' ', ' | sed 's/,$//')

# Read and consume pending messages (catches queued messages from headless senders)
INBOX=$("$SWARM_BIN" inbox 2>/dev/null)

if echo "$INBOX" | grep -q "No new messages"; then
  INBOX_SECTION=""
else
  INBOX_SECTION="
NEW MESSAGES (respond to these):
${INBOX}"
fi

cat <<EOF
You are "${AGENT}" in a coordination swarm. Active agents: ${MEMBERS}.
Commands: swarm send <agent> "<msg>" | broadcast "<msg>" | inbox | members | status --set "<desc>" | read <agent> --lines 20
When you see [SWARM from <name>]: treat it as a message from another agent and respond.${INBOX_SECTION}
EOF
