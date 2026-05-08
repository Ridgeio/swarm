#!/usr/bin/env bash
SWARM_BIN="$(cd "$(dirname "$0")/.." && pwd)/bin/swarm"
"$SWARM_BIN" hook-context 2>/dev/null
