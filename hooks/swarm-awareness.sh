#!/usr/bin/env bash
# Swarm awareness hook — runs on UserPromptSubmit
# If this terminal is in the swarm, injects a compact reminder as system context.
# If not in the swarm, exits silently (no output, no cost).

SURFACE_ID="${CMUX_SURFACE_ID:-}"
[ -z "$SURFACE_ID" ] && exit 0

DB="$HOME/.swarm/swarm.db"
[ -f "$DB" ] || exit 0

AGENT=$(sqlite3 "$DB" "SELECT name FROM agents WHERE surface_id='$SURFACE_ID'" 2>/dev/null)
[ -z "$AGENT" ] && exit 0

SWARM_BIN="/Users/tom/Developer/Ridge.io/swarm/bin/swarm"
MEMBERS=$(sqlite3 "$DB" "SELECT name FROM agents ORDER BY joined_at" 2>/dev/null | tr '\n' ', ' | sed 's/,$//')

cat <<EOF
You are "${AGENT}" in a coordination swarm. Active agents: ${MEMBERS}.
Commands: ${SWARM_BIN} send <agent> "<msg>" | broadcast "<msg>" | inbox | members | status --set "<desc>" | read <agent> --lines 20
When you see [SWARM from <name>]: treat it as a message from another agent and respond.
EOF
