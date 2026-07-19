import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DEFAULT_SWARM_ID, DEFAULT_SWARM_NAME } from './db.js';
import { isSurfaceAlive } from './transport.js';
import { isAgentAlive } from './transport-router.js';
import type { AgentType } from './transport-interface.js';

const SWARM_DIR = path.join(os.homedir(), '.swarm');

export interface Swarm {
  id: string;
  name: string;
  root_path: string | null;
  description: string | null;
  created_at: string;
  last_active_at: string;
}

export type HostAgentKind = 'claude-code' | 'codex' | 'grok';

export interface Agent {
  id: string;
  swarm_id: string;
  name: string;
  description: string | null;
  agent_type: AgentType;
  endpoint_url: string | null;
  /** Host harness that owns this terminal (claude-code | codex | grok). */
  host_agent: HostAgentKind | null;
  surface_id: string;
  workspace_id: string | null;
  ppid: number;
  joined_at: string;
  last_heartbeat: string;
}

interface SessionMarker {
  swarm_id: string;
  agent_name: string;
}

/**
 * Options for headless join/leave. The per-TTY session marker is a fallback
 * identity mechanism for interactive terminals that have no SWARM_AGENT_NAME
 * injected by a hook. Only the interactive CLI session should manage it; pure
 * DB callers (tests, programmatic use, batch registration) must not, otherwise
 * multiple agents sharing a controlling TTY would reap each other on join.
 */
export interface HeadlessSessionOptions {
  trackSession?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeSwarmName(name?: string | null): string {
  const trimmed = name?.trim();
  return trimmed || DEFAULT_SWARM_NAME;
}

function getSessionMarkerPath(): string | null {
  try {
    let pid = process.ppid?.toString() || '';
    for (let i = 0; i < 5 && pid; i++) {
      const tty = execFileSync('ps', ['-o', 'tty=', '-p', pid], { encoding: 'utf-8' }).trim();
      if (tty && tty !== '??' && tty !== '') {
        return path.join(SWARM_DIR, `headless-${tty}`);
      }
      pid = execFileSync('ps', ['-o', 'ppid=', '-p', pid], { encoding: 'utf-8' }).trim();
    }
  } catch { /* fall through */ }

  return null;
}

function readSessionMarker(): SessionMarker | null {
  const markerPath = getSessionMarkerPath();
  if (!markerPath || !fs.existsSync(markerPath)) return null;

  const raw = fs.readFileSync(markerPath, 'utf-8').trim();
  if (!raw) return null;

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Partial<SessionMarker>;
      if (parsed.agent_name) {
        return {
          swarm_id: parsed.swarm_id || DEFAULT_SWARM_ID,
          agent_name: parsed.agent_name,
        };
      }
    } catch { /* fall through to legacy marker */ }
  }

  return { swarm_id: DEFAULT_SWARM_ID, agent_name: raw };
}

function writeSessionMarker(swarmId: string, agentName: string): void {
  const markerPath = getSessionMarkerPath();
  if (!markerPath) return;

  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({ swarm_id: swarmId, agent_name: agentName }, null, 2), 'utf-8');
}

function removeSessionMarker(swarmId: string, agentName: string): void {
  const markerPath = getSessionMarkerPath();
  if (!markerPath || !fs.existsSync(markerPath)) return;

  const marker = readSessionMarker();
  if (marker && marker.swarm_id === swarmId && marker.agent_name.toLowerCase() === agentName.toLowerCase()) {
    fs.unlinkSync(markerPath);
  }
}

export function getSwarmById(db: Database.Database, swarmId: string): Swarm | null {
  return db.prepare('SELECT * FROM swarms WHERE id = ?').get(swarmId) as Swarm | undefined ?? null;
}

export function getSwarm(db: Database.Database, name: string): Swarm | null {
  return db.prepare('SELECT * FROM swarms WHERE name = ? COLLATE NOCASE').get(normalizeSwarmName(name)) as Swarm | undefined ?? null;
}

export function getOrCreateSwarm(
  db: Database.Database,
  name?: string,
  rootPath?: string,
  description?: string
): Swarm {
  const swarmName = normalizeSwarmName(name);
  const existing = getSwarm(db, swarmName);
  const resolvedRoot = rootPath ? path.resolve(rootPath) : undefined;
  const now = nowIso();

  if (existing) {
    if (resolvedRoot !== undefined || description !== undefined) {
      db.prepare(`
        UPDATE swarms
        SET root_path = COALESCE(?, root_path),
            description = COALESCE(?, description),
            last_active_at = ?
        WHERE id = ?
      `).run(resolvedRoot ?? null, description ?? null, now, existing.id);
    } else {
      db.prepare('UPDATE swarms SET last_active_at = ? WHERE id = ?').run(now, existing.id);
    }
    return getSwarmById(db, existing.id) ?? existing;
  }

  const id = swarmName.toLowerCase() === DEFAULT_SWARM_NAME ? DEFAULT_SWARM_ID : randomUUID();
  db.prepare(`
    INSERT INTO swarms (id, name, root_path, description, created_at, last_active_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, swarmName, resolvedRoot ?? null, description ?? null, now, now);

  const created = getSwarmById(db, id);
  if (!created) throw new Error(`Failed to create swarm "${swarmName}".`);
  return created;
}

export function listSwarms(db: Database.Database): Swarm[] {
  return db.prepare('SELECT * FROM swarms ORDER BY last_active_at DESC, name ASC').all() as Swarm[];
}

export function findSwarmForCwd(db: Database.Database, cwd: string = process.cwd()): Swarm | null {
  const current = path.resolve(cwd);
  const swarms = db.prepare('SELECT * FROM swarms WHERE root_path IS NOT NULL ORDER BY length(root_path) DESC').all() as Swarm[];

  for (const swarm of swarms) {
    if (!swarm.root_path) continue;
    const root = path.resolve(swarm.root_path);
    if (current === root || current.startsWith(`${root}${path.sep}`)) {
      return swarm;
    }
  }

  return null;
}

export function deleteSwarm(db: Database.Database, name: string): Swarm | null {
  const swarm = getSwarm(db, name);
  if (!swarm) return null;
  if (swarm.id === DEFAULT_SWARM_ID) {
    throw new Error('The default swarm cannot be deleted. Use "swarm reset --swarm default" to clear it.');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM message_deliveries WHERE swarm_id = ?').run(swarm.id);
    db.prepare('DELETE FROM swarms WHERE id = ?').run(swarm.id);
  }).immediate();
  return swarm;
}

export function joinAgent(
  db: Database.Database,
  swarmId: string,
  name: string,
  surfaceId: string,
  workspaceId: string | undefined,
  ppid: number,
  description?: string,
  agentType: AgentType = 'cmux',
  endpointUrl?: string,
  hostAgent?: HostAgentKind | null
): Agent {
  const id = randomUUID();
  const now = nowIso();
  const host = hostAgent ?? null;

  const tx = db.transaction(() => {
    const existing = getAgent(db, swarmId, name);
    if (existing && existing.surface_id !== surfaceId) {
      throw new Error(`Agent name "${name}" is already taken by a ${existing.agent_type} agent in this swarm. Choose a different name.`);
    }

    if (agentType === 'cmux') {
      db.prepare("DELETE FROM agents WHERE surface_id = ? AND swarm_id != ? AND agent_type = 'cmux'")
        .run(surfaceId, swarmId);
    }

    db.prepare(`
      INSERT OR REPLACE INTO agents (
        id, swarm_id, name, description, surface_id, workspace_id, ppid,
        joined_at, last_heartbeat, agent_type, endpoint_url, host_agent
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, swarmId, name, description ?? null, surfaceId, workspaceId ?? null, ppid, now, now, agentType, endpointUrl ?? null, host);

    db.prepare(`
      INSERT OR IGNORE INTO inbox_cursors (swarm_id, agent_name, last_read_id)
      SELECT ?, ?, COALESCE(MAX(id), 0)
      FROM messages
      WHERE swarm_id = ?
    `).run(swarmId, name, swarmId);

    db.prepare('UPDATE swarms SET last_active_at = ? WHERE id = ?').run(now, swarmId);
  });
  tx.immediate();

  return {
    id,
    swarm_id: swarmId,
    name,
    description: description ?? null,
    agent_type: agentType,
    endpoint_url: endpointUrl ?? null,
    host_agent: host,
    surface_id: surfaceId,
    workspace_id: workspaceId ?? null,
    ppid,
    joined_at: now,
    last_heartbeat: now,
  };
}

export function joinA2AAgent(
  db: Database.Database,
  swarmId: string,
  name: string,
  endpointUrl: string,
  description?: string
): Agent {
  const existing = getAgent(db, swarmId, name);
  if (existing && existing.agent_type === 'cmux') {
    throw new Error(`Agent "${name}" is already registered as a Cmux agent in this swarm. Choose a different name or remove the existing agent first.`);
  }
  const syntheticSurfaceId = `a2a:${swarmId}:${name}`;
  return joinAgent(db, swarmId, name, syntheticSurfaceId, undefined, 0, description, 'a2a', endpointUrl);
}

export function leaveAgent(db: Database.Database, swarmId: string, surfaceId: string): boolean {
  const result = db.prepare('DELETE FROM agents WHERE swarm_id = ? AND surface_id = ?').run(swarmId, surfaceId);
  return result.changes > 0;
}

export function leaveA2AAgent(db: Database.Database, swarmId: string, name: string): boolean {
  const result = db.prepare("DELETE FROM agents WHERE swarm_id = ? AND name = ? COLLATE NOCASE AND agent_type = 'a2a'")
    .run(swarmId, name);
  return result.changes > 0;
}

export function joinHeadlessAgent(
  db: Database.Database,
  swarmId: string,
  name: string,
  description?: string,
  options: HeadlessSessionOptions & { hostAgent?: HostAgentKind | null } = {}
): Agent {
  if (options.trackSession) {
    // This TTY previously joined under a different identity — reap it so a
    // single interactive session never leaves a ghost behind after a rename.
    const currentMarker = readSessionMarker();
    if (currentMarker && (currentMarker.swarm_id !== swarmId || currentMarker.agent_name.toLowerCase() !== name.toLowerCase())) {
      db.prepare("DELETE FROM agents WHERE swarm_id = ? AND name = ? COLLATE NOCASE AND agent_type = 'headless'")
        .run(currentMarker.swarm_id, currentMarker.agent_name);
    }
  }

  const existing = getAgent(db, swarmId, name);
  if (existing && existing.agent_type !== 'headless') {
    throw new Error(`Agent "${name}" is already registered as a ${existing.agent_type} agent in this swarm. Choose a different name or remove the existing agent first.`);
  }
  const syntheticSurfaceId = `headless:${swarmId}:${name}`;
  const agent = joinAgent(
    db, swarmId, name, syntheticSurfaceId, undefined, process.ppid,
    description, 'headless', undefined, options.hostAgent
  );
  if (options.trackSession) {
    writeSessionMarker(swarmId, name);
  }
  return agent;
}

export function leaveHeadlessAgent(
  db: Database.Database,
  swarmId: string,
  name: string,
  options: HeadlessSessionOptions = {}
): boolean {
  const result = db.prepare("DELETE FROM agents WHERE swarm_id = ? AND name = ? COLLATE NOCASE AND agent_type = 'headless'")
    .run(swarmId, name);
  if (options.trackSession) {
    removeSessionMarker(swarmId, name);
  }
  return result.changes > 0;
}

export function getSelf(db: Database.Database, swarmId?: string): Agent | null {
  const envSwarmId = process.env.SWARM_ID;
  const envSwarmName = process.env.SWARM_NAME;
  let resolvedSwarmId = swarmId || envSwarmId;

  if (!resolvedSwarmId && envSwarmName) {
    resolvedSwarmId = getSwarm(db, envSwarmName)?.id;
  }

  const surfaceId = process.env.CMUX_SURFACE_ID;
  if (surfaceId) {
    const sql = resolvedSwarmId
      ? 'SELECT * FROM agents WHERE swarm_id = ? AND surface_id = ? ORDER BY joined_at DESC LIMIT 1'
      : 'SELECT * FROM agents WHERE surface_id = ? ORDER BY joined_at DESC LIMIT 1';
    const params = resolvedSwarmId ? [resolvedSwarmId, surfaceId] : [surfaceId];
    const bySurface = db.prepare(sql).get(...params) as Agent | undefined;
    if (bySurface) return bySurface;
    // No Cmux agent owns this surface — fall through to the headless resolution paths so an
    // agent that joined with `--headless` from inside a Cmux tab can still find itself.
  }

  const agentName = process.env.SWARM_AGENT_NAME;
  if (agentName) {
    // Headless agents resolve by name; a2a agents too, so a remote agent can
    // act as itself over SSH (e.g. `SWARM_AGENT_NAME=Fable swarm send ...`).
    const sql = resolvedSwarmId
      ? "SELECT * FROM agents WHERE swarm_id = ? AND name = ? COLLATE NOCASE AND agent_type IN ('headless', 'a2a') ORDER BY joined_at DESC LIMIT 1"
      : "SELECT * FROM agents WHERE name = ? COLLATE NOCASE AND agent_type IN ('headless', 'a2a') ORDER BY joined_at DESC LIMIT 1";
    const params = resolvedSwarmId ? [resolvedSwarmId, agentName] : [agentName];
    return db.prepare(sql).get(...params) as Agent | undefined ?? null;
  }

  const marker = readSessionMarker();
  if (marker) {
    const markerSwarmId = resolvedSwarmId || marker.swarm_id;
    return db.prepare(`
      SELECT * FROM agents
      WHERE swarm_id = ? AND name = ? COLLATE NOCASE AND agent_type = 'headless'
      ORDER BY joined_at DESC
      LIMIT 1
    `).get(markerSwarmId, marker.agent_name) as Agent | undefined ?? null;
  }

  return null;
}

export function getAgent(db: Database.Database, swarmId: string, name: string): Agent | null {
  return db.prepare('SELECT * FROM agents WHERE swarm_id = ? AND name = ? COLLATE NOCASE')
    .get(swarmId, name) as Agent | undefined ?? null;
}

export async function listAgents(db: Database.Database, swarmId: string): Promise<Agent[]> {
  await cleanupStale(db, swarmId);
  return db.prepare('SELECT * FROM agents WHERE swarm_id = ? ORDER BY joined_at ASC').all(swarmId) as Agent[];
}

export function listAgentsSync(db: Database.Database, swarmId?: string): Agent[] {
  if (swarmId) {
    return db.prepare('SELECT * FROM agents WHERE swarm_id = ? ORDER BY joined_at ASC').all(swarmId) as Agent[];
  }
  return db.prepare('SELECT * FROM agents ORDER BY joined_at ASC').all() as Agent[];
}

export function updateStatus(db: Database.Database, swarmId: string, surfaceId: string, description: string): boolean {
  const now = nowIso();
  const result = db.prepare('UPDATE agents SET description = ?, last_heartbeat = ? WHERE swarm_id = ? AND surface_id = ?')
    .run(description, now, swarmId, surfaceId);
  db.prepare('UPDATE swarms SET last_active_at = ? WHERE id = ?').run(now, swarmId);
  return result.changes > 0;
}

export function updateWorkspace(db: Database.Database, swarmId: string, surfaceId: string, workspaceId: string): void {
  db.prepare('UPDATE agents SET workspace_id = ? WHERE swarm_id = ? AND surface_id = ?').run(workspaceId, swarmId, surfaceId);
}

export function updateHostAgent(
  db: Database.Database,
  swarmId: string,
  surfaceId: string,
  hostAgent: HostAgentKind
): void {
  db.prepare('UPDATE agents SET host_agent = ? WHERE swarm_id = ? AND surface_id = ?')
    .run(hostAgent, swarmId, surfaceId);
}

export function updateHeartbeat(db: Database.Database, swarmId: string, surfaceId: string): void {
  const now = nowIso();
  db.prepare('UPDATE agents SET last_heartbeat = ? WHERE swarm_id = ? AND surface_id = ?').run(now, swarmId, surfaceId);
  db.prepare('UPDATE swarms SET last_active_at = ? WHERE id = ?').run(now, swarmId);
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

async function cleanupStale(db: Database.Database, swarmId?: string): Promise<void> {
  const agents = swarmId
    ? db.prepare('SELECT * FROM agents WHERE swarm_id = ?').all(swarmId) as Agent[]
    : db.prepare('SELECT * FROM agents').all() as Agent[];
  const now = Date.now();

  const checks = agents.map(async (agent) => {
    if (agent.agent_type === 'headless') return; // no probeable surface; never auto-pruned

    // First probe. Cmux heartbeats are refreshed by the awareness hook; A2A heartbeats
    // are only refreshed here, so bump them whenever the endpoint is reachable.
    const aliveNow = agent.agent_type === 'a2a'
      ? await isAgentAlive(agent)
      : isSurfaceAlive(agent.surface_id, agent.workspace_id);
    if (aliveNow) {
      if (agent.agent_type === 'a2a') updateHeartbeat(db, agent.swarm_id, agent.surface_id);
      return;
    }

    // Unreachable. Only prune once the heartbeat is also stale (so a briefly-unreachable
    // but recently-active agent is spared) AND a second probe still fails (guards against a
    // transient socket/HTTP blip). This replaces a module-level failure counter that never
    // accumulated across the short-lived one-shot CLI process, so auto-pruning never fired.
    const heartbeatAge = now - new Date(agent.last_heartbeat).getTime();
    if (heartbeatAge <= STALE_THRESHOLD_MS) return;

    const stillDead = agent.agent_type === 'a2a'
      ? !(await isAgentAlive(agent))
      : !isSurfaceAlive(agent.surface_id, agent.workspace_id);
    if (stillDead) {
      db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
    }
  });

  await Promise.all(checks);
}

async function isConfirmedDead(agent: Agent): Promise<boolean> {
  const probe = async (): Promise<boolean> =>
    agent.agent_type === 'a2a'
      ? await isAgentAlive(agent)
      : isSurfaceAlive(agent.surface_id, agent.workspace_id);
  if (await probe()) return false;
  return !(await probe());
}

export async function reapIfDead(db: Database.Database, swarmId: string, name: string): Promise<Agent | null> {
  const existing = getAgent(db, swarmId, name);
  if (!existing) return null;
  if (existing.agent_type === 'headless') return null;
  if (await isConfirmedDead(existing)) {
    db.prepare('DELETE FROM agents WHERE id = ?').run(existing.id);
    return existing;
  }
  return null;
}

export async function reapAll(db: Database.Database, swarmId?: string): Promise<Agent[]> {
  const agents = swarmId
    ? db.prepare('SELECT * FROM agents WHERE swarm_id = ?').all(swarmId) as Agent[]
    : db.prepare('SELECT * FROM agents').all() as Agent[];
  const reaped: Agent[] = [];
  for (const agent of agents) {
    if (agent.agent_type === 'headless') continue;
    if (await isConfirmedDead(agent)) {
      db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
      reaped.push(agent);
    }
  }
  return reaped;
}

export function forceReap(db: Database.Database, swarmId: string, name: string): Agent | null {
  const existing = getAgent(db, swarmId, name);
  if (!existing) return null;
  db.prepare('DELETE FROM agents WHERE id = ?').run(existing.id);
  return existing;
}
