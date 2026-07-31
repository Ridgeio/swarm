import type { SwarmDb } from './db.js';

/**
 * Persisted wall-clock fence for deadline- and authorization-sensitive state.
 *
 * Scopes are intentionally independent: a deterministic grant fixture cannot
 * move a handoff deadline clock, while a rollback within either stream fails
 * closed. Call this from the same IMMEDIATE transaction as the protected
 * mutation so a rejected or crashed mutation cannot advance the fence alone.
 */
export function observeMonotonicClock(
  db: SwarmDb,
  swarmId: string,
  scope: string,
  now: number
): void {
  if (!Number.isFinite(now) || !Number.isSafeInteger(now) || Math.abs(now) > 8.64e15) {
    throw new Error(`Coordination clock for ${scope} must be a finite integer millisecond timestamp.`);
  }
  const prior = db.prepare(`
    SELECT last_wall_ms FROM coordination_clocks
    WHERE swarm_id = ? AND scope = ?
  `).get(swarmId, scope) as { last_wall_ms: number } | undefined;
  if (prior && now < prior.last_wall_ms) {
    throw new Error(
      `Refused ${scope} mutation because the wall clock moved backwards ` +
      `(${now} < ${prior.last_wall_ms}). Restore a monotonic clock before retrying.`
    );
  }
  db.prepare(`
    INSERT INTO coordination_clocks (swarm_id, scope, last_wall_ms, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(swarm_id, scope) DO UPDATE SET
      last_wall_ms = excluded.last_wall_ms,
      updated_at = excluded.updated_at
  `).run(swarmId, scope, now, new Date(now).toISOString());
}
