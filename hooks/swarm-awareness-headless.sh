#!/usr/bin/env bash
SWARM_BIN="$(cd "$(dirname "$0")/.." && pwd)/bin/swarm"
# `|| true` keeps this a clean no-op after leaving the swarm: hook-context exits 1
# (requireSelf) when the session isn't joined, and a nonzero hook exit is just noise.
"$SWARM_BIN" hook-context 2>/dev/null || true
