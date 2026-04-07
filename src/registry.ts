import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { isSurfaceAlive } from './transport.js';
import { isAgentAlive } from './transport-router.js';
import type { AgentType } from './transport-interface.js';

const SWARM_DIR = path.join(os.homedir(), '.swarm');

/**
 * Get a session-unique marker file path based on the TTY device.
 * Each terminal session has a unique TTY, so markers don't collide.
 */
function getSessionMarkerPath(): string | null {
  // Try SWARM_AGENT_NAME first (set by hook)
  if (process.env.SWARM_AGENT_NAME) return null; // no marker needed

  // Find TTY from process tree
  try {
    let pid = process.ppid?.toString() || '';
    for (let i = 0; i < 5 && pid; i++) {
      const tty = execFileSync('ps', ['-o', 'tty=', '-p', pid], { encoding: 'utf-8' }).trim();
      if (tty && tty !== '??' && tty !== '') {
        // e.g., ttys003 → ~/.swarm/headless-ttys003
        return path.join(SWARM_DIR, `headless-${tty}`);
      }
      pid = execFileSync('ps', ['-o', 'ppid=', '-p', pid], { encoding: 'utf-8' }).trim();
    }
  } catch { /* fall through */ }

  return null;
}

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  agent_type: AgentType;
  endpoint_url: string | null;
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
  description?: string,
  agentType: AgentType = 'cmux',
  endpointUrl?: string
): Agent {
  // Check if name is already taken by a different agent
  const existing = getAgent(db, name);
  if (existing && existing.surface_id !== surfaceId) {
    throw new Error(`Agent name "${name}" is already taken by a ${existing.agent_type} agent. Choose a different name.`);
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT OR REPLACE INTO agents (id, name, description, surface_id, workspace_id, ppid, joined_at, last_heartbeat, agent_type, endpoint_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, description ?? null, surfaceId, workspaceId ?? null, ppid, now, now, agentType, endpointUrl ?? null);

  return { id, name, description: description ?? null, agent_type: agentType, endpoint_url: endpointUrl ?? null, surface_id: surfaceId, workspace_id: workspaceId ?? null, ppid, joined_at: now, last_heartbeat: now };
}

export function joinA2AAgent(
  db: Database.Database,
  name: string,
  endpointUrl: string,
  description?: string
): Agent {
  // Prevent overwriting an existing Cmux agent
  const existing = getAgent(db, name);
  if (existing && existing.agent_type === 'cmux') {
    throw new Error(`Agent "${name}" is already registered as a Cmux agent. Choose a different name or remove the existing agent first.`);
  }
  const syntheticSurfaceId = `a2a:${name}`;
  return joinAgent(db, name, syntheticSurfaceId, undefined, 0, description, 'a2a', endpointUrl);
}

export function leaveAgent(db: Database.Database, surfaceId: string): boolean {
  const result = db.prepare('DELETE FROM agents WHERE surface_id = ?').run(surfaceId);
  return result.changes > 0;
}

export function leaveA2AAgent(db: Database.Database, name: string): boolean {
  const result = db.prepare("DELETE FROM agents WHERE name = ? COLLATE NOCASE AND agent_type = 'a2a'").run(name);
  return result.changes > 0;
}

export function joinHeadlessAgent(
  db: Database.Database,
  name: string,
  description?: string
): Agent {
  const existing = getAgent(db, name);
  if (existing && existing.agent_type !== 'headless') {
    throw new Error(`Agent "${name}" is already registered as a ${existing.agent_type} agent. Choose a different name or remove the existing agent first.`);
  }
  const syntheticSurfaceId = `headless:${name}`;
  const agent = joinAgent(db, name, syntheticSurfaceId, undefined, process.ppid, description, 'headless');
  // Write per-TTY marker so this session's CLI calls auto-identify
  const markerPath = getSessionMarkerPath();
  if (markerPath) {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, name, 'utf-8');
  }
  return agent;
}

export function leaveHeadlessAgent(db: Database.Database, name: string): boolean {
  const result = db.prepare("DELETE FROM agents WHERE name = ? COLLATE NOCASE AND agent_type = 'headless'").run(name);
  // Clean up per-TTY marker
  const markerPath = getSessionMarkerPath();
  if (markerPath && fs.existsSync(markerPath)) {
    const saved = fs.readFileSync(markerPath, 'utf-8').trim();
    if (saved.toLowerCase() === name.toLowerCase()) {
      fs.unlinkSync(markerPath);
    }
  }
  return result.changes > 0;
}

export function getSelf(db: Database.Database): Agent | null {
  // Try Cmux surface first
  const surfaceId = process.env.CMUX_SURFACE_ID;
  if (surfaceId) {
    return db.prepare('SELECT * FROM agents WHERE surface_id = ?').get(surfaceId) as Agent | undefined ?? null;
  }
  // Try headless agent by SWARM_AGENT_NAME env var (set by the awareness hook)
  const agentName = process.env.SWARM_AGENT_NAME;
  if (agentName) {
    return db.prepare("SELECT * FROM agents WHERE name = ? COLLATE NOCASE AND agent_type = 'headless'").get(agentName) as Agent | undefined ?? null;
  }
  // Try per-TTY marker file (written by swarm join, unique per terminal session)
  const markerPath = getSessionMarkerPath();
  if (markerPath && fs.existsSync(markerPath)) {
    const name = fs.readFileSync(markerPath, 'utf-8').trim();
    if (name) {
      return db.prepare("SELECT * FROM agents WHERE name = ? COLLATE NOCASE AND agent_type = 'headless'").get(name) as Agent | undefined ?? null;
    }
  }
  return null;
}

export function getAgent(db: Database.Database, name: string): Agent | null {
  return db.prepare('SELECT * FROM agents WHERE name = ? COLLATE NOCASE').get(name) as Agent | undefined ?? null;
}

export async function listAgents(db: Database.Database): Promise<Agent[]> {
  await cleanupStale(db);
  return db.prepare('SELECT * FROM agents ORDER BY joined_at ASC').all() as Agent[];
}

export function listAgentsSync(db: Database.Database): Agent[] {
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

async function cleanupStale(db: Database.Database): Promise<void> {
  const agents = db.prepare('SELECT id, name, agent_type, endpoint_url, surface_id, workspace_id, last_heartbeat FROM agents').all() as Agent[];
  const now = Date.now();

  // Check all agents in parallel
  const checks = agents.map(async (agent) => {
    // Headless agents are never auto-pruned — only removed by explicit leave/reset
    if (agent.agent_type === 'headless') return;

    let alive: boolean;
    if (agent.agent_type === 'a2a') {
      alive = await isAgentAlive(agent);
    } else {
      alive = isSurfaceAlive(agent.surface_id, agent.workspace_id);
    }

    if (alive) {
      failedChecks.delete(agent.id);
      // Refresh heartbeat for A2A agents on successful liveness check
      if (agent.agent_type === 'a2a') {
        updateHeartbeat(db, agent.surface_id);
      }
    } else {
      // Track consecutive failures to prevent single-check false positives
      const failures = (failedChecks.get(agent.id) ?? 0) + 1;
      failedChecks.set(agent.id, failures);

      const heartbeatAge = now - new Date(agent.last_heartbeat).getTime();
      if (failures >= REQUIRED_FAILURES && heartbeatAge > STALE_THRESHOLD_MS) {
        db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
        failedChecks.delete(agent.id);
      }
    }
  });

  await Promise.all(checks);
}
