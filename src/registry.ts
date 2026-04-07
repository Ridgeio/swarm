import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { isSurfaceAlive } from './transport.js';

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  surface_id: string;
  workspace_id: string | null;
  ppid: number;
  joined_at: string;
  last_heartbeat: string;
}

export function joinAgent(
  db: Database.Database,
  name: string,
  surfaceId: string,
  workspaceId: string | undefined,
  ppid: number,
  description?: string
): Agent {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT OR REPLACE INTO agents (id, name, description, surface_id, workspace_id, ppid, joined_at, last_heartbeat)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, description ?? null, surfaceId, workspaceId ?? null, ppid, now, now);

  return { id, name, description: description ?? null, surface_id: surfaceId, workspace_id: workspaceId ?? null, ppid, joined_at: now, last_heartbeat: now };
}

export function leaveAgent(db: Database.Database, surfaceId: string): boolean {
  const result = db.prepare('DELETE FROM agents WHERE surface_id = ?').run(surfaceId);
  return result.changes > 0;
}

export function getSelf(db: Database.Database): Agent | null {
  const surfaceId = process.env.CMUX_SURFACE_ID;
  if (!surfaceId) return null;
  return db.prepare('SELECT * FROM agents WHERE surface_id = ?').get(surfaceId) as Agent | undefined ?? null;
}

export function getAgent(db: Database.Database, name: string): Agent | null {
  return db.prepare('SELECT * FROM agents WHERE name = ? COLLATE NOCASE').get(name) as Agent | undefined ?? null;
}

export function listAgents(db: Database.Database): Agent[] {
  cleanupStale(db);
  return db.prepare('SELECT * FROM agents ORDER BY joined_at ASC').all() as Agent[];
}

export function updateStatus(db: Database.Database, surfaceId: string, description: string): boolean {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE agents SET description = ?, last_heartbeat = ? WHERE surface_id = ?')
    .run(description, now, surfaceId);
  return result.changes > 0;
}

export function updateWorkspace(db: Database.Database, surfaceId: string, workspaceId: string): void {
  db.prepare('UPDATE agents SET workspace_id = ? WHERE surface_id = ?').run(workspaceId, surfaceId);
}

export function updateHeartbeat(db: Database.Database, surfaceId: string): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE agents SET last_heartbeat = ? WHERE surface_id = ?').run(now, surfaceId);
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

// Track consecutive surface-dead checks to prevent single-check false positives
const failedChecks = new Map<string, number>();
const REQUIRED_FAILURES = 3; // Must fail 3 consecutive checks before pruning

function cleanupStale(db: Database.Database): void {
  const agents = db.prepare('SELECT id, surface_id, workspace_id, last_heartbeat FROM agents').all() as Pick<Agent, 'id' | 'surface_id' | 'workspace_id' | 'last_heartbeat'>[];
  const now = Date.now();
  for (const agent of agents) {
    const alive = isSurfaceAlive(agent.surface_id, agent.workspace_id);
    if (alive) {
      failedChecks.delete(agent.id);
      continue;
    }

    // Surface appears dead — track consecutive failures
    const failures = (failedChecks.get(agent.id) ?? 0) + 1;
    failedChecks.set(agent.id, failures);

    // Only prune if: surface failed multiple consecutive checks AND heartbeat is stale
    const heartbeatAge = now - new Date(agent.last_heartbeat).getTime();
    if (failures >= REQUIRED_FAILURES && heartbeatAge > STALE_THRESHOLD_MS) {
      db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
      failedChecks.delete(agent.id);
    }
  }
}
