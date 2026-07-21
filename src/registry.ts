import type { SwarmDb } from './db.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DEFAULT_SWARM_ID, DEFAULT_SWARM_NAME, withImmediateTransaction } from './db.js';
import {
  processCmuxLivenessObserver,
  type CmuxLivenessObserver,
} from './transport.js';
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

export type HostAgentKind = 'claude-code' | 'codex' | 'grok' | 'gemini';

export interface WorkerVersionRunOptions {
  encoding: 'utf-8';
  timeout: number;
  stdio: ['ignore', 'pipe', 'pipe'];
}

export type WorkerVersionRunner = (
  binary: string,
  args: string[],
  options: WorkerVersionRunOptions
) => string | Buffer;

const WORKER_BINARIES: Record<HostAgentKind, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  grok: 'grok',
  gemini: 'gemini',
};

export interface Agent {
  id: string;
  swarm_id: string;
  name: string;
  description: string | null;
  agent_type: AgentType;
  endpoint_url: string | null;
  /** Host harness that owns this terminal. */
  host_agent: HostAgentKind | null;
  worker_version: string | null;
  surface_id: string;
  workspace_id: string | null;
  ppid: number;
  joined_at: string;
  last_heartbeat: string;
  session_token: string | null;
}

interface SessionMarker {
  swarm_id: string;
  agent_name: string;
  session_token: string | null;
}

interface ResolvedSelf {
  agent: Agent;
  presentedToken: string | null;
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

export function captureWorkerVersion(
  host: HostAgentKind | null,
  runner: WorkerVersionRunner = execFileSync
): string | null {
  if (!host) return null;
  try {
    const output = runner(WORKER_BINARIES[host], ['--version'], {
      encoding: 'utf-8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const firstLine = String(output).split(/\r?\n/, 1)[0];
    return firstLine.length > 0 ? firstLine : null;
  } catch {
    return null;
  }
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
          session_token: typeof parsed.session_token === 'string' ? parsed.session_token : null,
        };
      }
    } catch { /* fall through to legacy marker */ }
  }

  return { swarm_id: DEFAULT_SWARM_ID, agent_name: raw, session_token: null };
}

function writeSessionMarker(swarmId: string, agentName: string, sessionToken: string): void {
  const markerPath = getSessionMarkerPath();
  if (!markerPath) return;

  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(
    markerPath,
    JSON.stringify({ swarm_id: swarmId, agent_name: agentName, session_token: sessionToken }, null, 2),
    { encoding: 'utf-8', mode: 0o600 }
  );
}

function surfaceSessionMarkerPath(surfaceId: string): string {
  const key = createHash('sha256').update(surfaceId).digest('hex');
  return path.join(SWARM_DIR, 'sessions', `cmux-${key}.json`);
}

function readSurfaceSessionMarker(surfaceId: string): SessionMarker | null {
  const markerPath = surfaceSessionMarkerPath(surfaceId);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as Partial<SessionMarker>;
    if (!parsed.agent_name || !parsed.swarm_id) return null;
    return {
      swarm_id: parsed.swarm_id,
      agent_name: parsed.agent_name,
      session_token: typeof parsed.session_token === 'string' ? parsed.session_token : null,
    };
  } catch {
    return null;
  }
}

function writeSurfaceSessionMarker(agent: Agent): void {
  if (!agent.session_token) return;
  const markerPath = surfaceSessionMarkerPath(agent.surface_id);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({
    swarm_id: agent.swarm_id,
    agent_name: agent.name,
    session_token: agent.session_token,
  }, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

function removeSurfaceSessionMarker(swarmId: string, surfaceId: string): void {
  const markerPath = surfaceSessionMarkerPath(surfaceId);
  const marker = readSurfaceSessionMarker(surfaceId);
  if (marker?.swarm_id === swarmId) fs.rmSync(markerPath, { force: true });
}

function removeSessionMarker(swarmId: string, agentName: string): void {
  const markerPath = getSessionMarkerPath();
  if (!markerPath || !fs.existsSync(markerPath)) return;

  const marker = readSessionMarker();
  if (marker && marker.swarm_id === swarmId && marker.agent_name.toLowerCase() === agentName.toLowerCase()) {
    fs.unlinkSync(markerPath);
  }
}

export function getSwarmById(db: SwarmDb, swarmId: string): Swarm | null {
  return db.prepare('SELECT * FROM swarms WHERE id = ?').get(swarmId) as Swarm | undefined ?? null;
}

export function getSwarm(db: SwarmDb, name: string): Swarm | null {
  return db.prepare('SELECT * FROM swarms WHERE name = ? COLLATE NOCASE').get(normalizeSwarmName(name)) as Swarm | undefined ?? null;
}

export function getOrCreateSwarm(
  db: SwarmDb,
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

export function listSwarms(db: SwarmDb): Swarm[] {
  return db.prepare('SELECT * FROM swarms ORDER BY last_active_at DESC, name ASC').all() as unknown as Swarm[];
}

export function findSwarmForCwd(db: SwarmDb, cwd: string = process.cwd()): Swarm | null {
  const current = path.resolve(cwd);
  const swarms = db.prepare('SELECT * FROM swarms WHERE root_path IS NOT NULL ORDER BY length(root_path) DESC').all() as unknown as Swarm[];

  for (const swarm of swarms) {
    if (!swarm.root_path) continue;
    const root = path.resolve(swarm.root_path);
    if (current === root || current.startsWith(`${root}${path.sep}`)) {
      return swarm;
    }
  }

  return null;
}

export function deleteSwarm(db: SwarmDb, name: string): Swarm | null {
  const swarm = getSwarm(db, name);
  if (!swarm) return null;
  if (swarm.id === DEFAULT_SWARM_ID) {
    throw new Error('The default swarm cannot be deleted. Use "swarm reset --swarm default" to clear it.');
  }
  withImmediateTransaction(db, () => {
    db.prepare('DELETE FROM message_deliveries WHERE swarm_id = ?').run(swarm.id);
    db.prepare('DELETE FROM swarms WHERE id = ?').run(swarm.id);
  });
  return swarm;
}

export function joinAgent(
  db: SwarmDb,
  swarmId: string,
  name: string,
  surfaceId: string,
  workspaceId: string | undefined,
  ppid: number,
  description?: string,
  agentType: AgentType = 'cmux',
  endpointUrl?: string,
  hostAgent?: HostAgentKind | null,
  versionRunner?: WorkerVersionRunner
): Agent {
  const id = randomUUID();
  const sessionToken = agentType === 'a2a' ? null : randomBytes(16).toString('hex');
  const now = nowIso();
  const host = hostAgent ?? null;
  const workerVersion = agentType === 'a2a'
    ? null
    : captureWorkerVersion(host, versionRunner);

  withImmediateTransaction(db, () => {
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
        joined_at, last_heartbeat, agent_type, endpoint_url, host_agent, session_token,
        worker_version
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, swarmId, name, description ?? null, surfaceId, workspaceId ?? null, ppid,
      now, now, agentType, endpointUrl ?? null, host, sessionToken, workerVersion
    );

    db.prepare(`
      INSERT OR IGNORE INTO inbox_cursors (swarm_id, agent_name, last_read_id)
      SELECT ?, ?, COALESCE(MAX(id), 0)
      FROM messages
      WHERE swarm_id = ?
    `).run(swarmId, name, swarmId);

    db.prepare('UPDATE swarms SET last_active_at = ? WHERE id = ?').run(now, swarmId);
  });

  const agent: Agent = {
    id,
    swarm_id: swarmId,
    name,
    description: description ?? null,
    agent_type: agentType,
    endpoint_url: endpointUrl ?? null,
    host_agent: host,
    worker_version: workerVersion,
    surface_id: surfaceId,
    workspace_id: workspaceId ?? null,
    ppid,
    joined_at: now,
    last_heartbeat: now,
    session_token: sessionToken,
  };
  if (agentType === 'cmux' && process.env.CMUX_SURFACE_ID === surfaceId) {
    writeSurfaceSessionMarker(agent);
  }
  return agent;
}

export function joinA2AAgent(
  db: SwarmDb,
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

export function leaveAgent(db: SwarmDb, swarmId: string, surfaceId: string): boolean {
  const result = db.prepare('DELETE FROM agents WHERE swarm_id = ? AND surface_id = ?').run(swarmId, surfaceId);
  if (Number(result.changes) > 0) removeSurfaceSessionMarker(swarmId, surfaceId);
  return Number(result.changes) > 0;
}

export function leaveA2AAgent(db: SwarmDb, swarmId: string, name: string): boolean {
  const result = db.prepare("DELETE FROM agents WHERE swarm_id = ? AND name = ? COLLATE NOCASE AND agent_type = 'a2a'")
    .run(swarmId, name);
  return Number(result.changes) > 0;
}

export function joinHeadlessAgent(
  db: SwarmDb,
  swarmId: string,
  name: string,
  description?: string,
  options: HeadlessSessionOptions & {
    hostAgent?: HostAgentKind | null;
    versionRunner?: WorkerVersionRunner;
  } = {}
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
    description, 'headless', undefined, options.hostAgent, options.versionRunner
  );
  if (options.trackSession) {
    if (!agent.session_token) throw new Error(`Failed to mint a session token for headless agent "${name}".`);
    writeSessionMarker(swarmId, name, agent.session_token);
  }
  return agent;
}

export function leaveHeadlessAgent(
  db: SwarmDb,
  swarmId: string,
  name: string,
  options: HeadlessSessionOptions = {}
): boolean {
  const result = db.prepare("DELETE FROM agents WHERE swarm_id = ? AND name = ? COLLATE NOCASE AND agent_type = 'headless'")
    .run(swarmId, name);
  if (options.trackSession) {
    removeSessionMarker(swarmId, name);
  }
  return Number(result.changes) > 0;
}

function resolveSelf(db: SwarmDb, swarmId?: string): ResolvedSelf | null {
  const envSwarmId = process.env.SWARM_ID;
  const envSwarmName = process.env.SWARM_NAME;
  let resolvedSwarmId = swarmId || envSwarmId;

  if (!resolvedSwarmId && envSwarmName) {
    resolvedSwarmId = getSwarm(db, envSwarmName)?.id;
  }

  const surfaceId = process.env.CMUX_SURFACE_ID;
  if (surfaceId) {
    // A concrete registration for the current Cmux surface is authoritative.
    // Child processes can stamp the shared TTY's headless marker, so that
    // marker is only a fallback when this selected swarm has no surface row.
    const sql = resolvedSwarmId
      ? 'SELECT * FROM agents WHERE swarm_id = ? AND surface_id = ? ORDER BY joined_at DESC LIMIT 1'
      : 'SELECT * FROM agents WHERE surface_id = ? ORDER BY joined_at DESC LIMIT 1';
    const params = resolvedSwarmId ? [resolvedSwarmId, surfaceId] : [surfaceId];
    const bySurface = db.prepare(sql).get(...params) as Agent | undefined;
    if (bySurface) {
      const marker = readSurfaceSessionMarker(surfaceId);
      return {
        agent: bySurface,
        presentedToken:
          marker?.swarm_id === bySurface.swarm_id &&
          marker.agent_name.toLowerCase() === bySurface.name.toLowerCase()
            ? marker.session_token
            : null,
      };
    }
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
    const byName = db.prepare(sql).get(...params) as Agent | undefined;
    if (!byName) return null;
    return {
      agent: byName,
      presentedToken: byName.agent_type === 'a2a' ? null : process.env.SWARM_SESSION_TOKEN ?? null,
    };
  }

  const marker = readSessionMarker();
  if (marker) {
    const markerSwarmId = resolvedSwarmId || marker.swarm_id;
    const byMarker = db.prepare(`
      SELECT * FROM agents
      WHERE swarm_id = ? AND name = ? COLLATE NOCASE AND agent_type = 'headless'
      ORDER BY joined_at DESC
      LIMIT 1
    `).get(markerSwarmId, marker.agent_name) as Agent | undefined;
    if (!byMarker) return null;
    return { agent: byMarker, presentedToken: marker.session_token };
  }

  return null;
}

export function getSelf(db: SwarmDb, swarmId?: string): Agent | null {
  return resolveSelf(db, swarmId)?.agent ?? null;
}

export function getSurfaceMarkerConflictWarning(db: SwarmDb, swarmId: string): string | null {
  const surfaceId = process.env.CMUX_SURFACE_ID;
  if (!surfaceId) return null;
  const bySurface = db.prepare(`
    SELECT * FROM agents
    WHERE swarm_id = ? AND surface_id = ? AND agent_type = 'cmux'
    ORDER BY joined_at DESC
    LIMIT 1
  `).get(swarmId, surfaceId) as Agent | undefined;
  const marker = readSessionMarker();
  if (!bySurface || !marker || marker.agent_name.toLowerCase() === bySurface.name.toLowerCase()) {
    return null;
  }
  return `session marker says ${marker.agent_name}; this surface is registered as ${bySurface.name} — child processes may have stamped the marker`;
}

function tokensMatch(expected: string, presented: string | null): boolean {
  if (!presented) return false;
  const expectedBytes = Buffer.from(expected, 'utf-8');
  const presentedBytes = Buffer.from(presented, 'utf-8');
  if (expectedBytes.length !== presentedBytes.length) return false;
  return timingSafeEqual(expectedBytes, presentedBytes);
}

export function getAuthenticatedSelf(db: SwarmDb, swarmId?: string): Agent | null {
  const resolved = resolveSelf(db, swarmId);
  if (!resolved) return null;
  const { agent, presentedToken } = resolved;
  // Existing A2A endpoint identity remains unchanged. Legacy local rows with a
  // NULL token are grandfathered until their next join mints one.
  if (agent.agent_type === 'a2a' || agent.session_token === null) return agent;
  if (!tokensMatch(agent.session_token, presentedToken)) {
    throw new Error(`identity could not be authenticated for ${agent.name} — rejoin with swarm join ${agent.name}`);
  }
  return agent;
}

export function getAgent(db: SwarmDb, swarmId: string, name: string): Agent | null {
  return db.prepare('SELECT * FROM agents WHERE swarm_id = ? AND name = ? COLLATE NOCASE')
    .get(swarmId, name) as Agent | undefined ?? null;
}

export async function listAgents(
  db: SwarmDb,
  swarmId: string,
  cmuxObserver: CmuxLivenessObserver = processCmuxLivenessObserver
): Promise<Agent[]> {
  await cleanupStale(db, swarmId, cmuxObserver);
  return db.prepare('SELECT * FROM agents WHERE swarm_id = ? ORDER BY joined_at ASC').all(swarmId) as unknown as Agent[];
}

export function listAgentsSync(db: SwarmDb, swarmId?: string): Agent[] {
  if (swarmId) {
    return db.prepare('SELECT * FROM agents WHERE swarm_id = ? ORDER BY joined_at ASC').all(swarmId) as unknown as Agent[];
  }
  return db.prepare('SELECT * FROM agents ORDER BY joined_at ASC').all() as unknown as Agent[];
}

export function updateStatus(db: SwarmDb, swarmId: string, surfaceId: string, description: string): boolean {
  const now = nowIso();
  const result = db.prepare('UPDATE agents SET description = ?, last_heartbeat = ? WHERE swarm_id = ? AND surface_id = ?')
    .run(description, now, swarmId, surfaceId);
  db.prepare('UPDATE swarms SET last_active_at = ? WHERE id = ?').run(now, swarmId);
  return Number(result.changes) > 0;
}

export function updateWorkspace(db: SwarmDb, swarmId: string, surfaceId: string, workspaceId: string): void {
  db.prepare('UPDATE agents SET workspace_id = ? WHERE swarm_id = ? AND surface_id = ?').run(workspaceId, swarmId, surfaceId);
}

export function updateHostAgent(
  db: SwarmDb,
  swarmId: string,
  surfaceId: string,
  hostAgent: HostAgentKind
): void {
  db.prepare('UPDATE agents SET host_agent = ? WHERE swarm_id = ? AND surface_id = ?')
    .run(hostAgent, swarmId, surfaceId);
}

export function updateHeartbeat(db: SwarmDb, swarmId: string, surfaceId: string): void {
  const now = nowIso();
  db.prepare('UPDATE agents SET last_heartbeat = ? WHERE swarm_id = ? AND surface_id = ?').run(now, swarmId, surfaceId);
  db.prepare('UPDATE swarms SET last_active_at = ? WHERE id = ?').run(now, swarmId);
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

async function cleanupStale(
  db: SwarmDb,
  swarmId?: string,
  cmuxObserver: CmuxLivenessObserver = processCmuxLivenessObserver
): Promise<void> {
  const agents = swarmId
    ? db.prepare('SELECT * FROM agents WHERE swarm_id = ?').all(swarmId) as unknown as Agent[]
    : db.prepare('SELECT * FROM agents').all() as unknown as Agent[];
  const now = Date.now();
  // One cheap, memoized process-level competence check precedes every subject
  // probe. If this observer cannot reach the socket, it contributes no liveness
  // evidence and performs no strike/reap accounting for any subject.
  const hasProbeableAgent = agents.some(agent => agent.agent_type !== 'headless');
  if (hasProbeableAgent && !cmuxObserver.isCompetent()) return;

  const checks = agents.map(async (agent) => {
    if (agent.agent_type === 'headless') return; // no probeable surface; never auto-pruned

    // First probe. Cmux heartbeats are refreshed by the awareness hook; A2A heartbeats
    // are only refreshed here, so bump them whenever the endpoint is reachable.
    const aliveNow = agent.agent_type === 'a2a'
      ? await isAgentAlive(agent)
      : cmuxObserver.isSurfaceAlive(agent.surface_id, agent.workspace_id);
    if (aliveNow === null) return;
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
      : cmuxObserver.isSurfaceAlive(agent.surface_id, agent.workspace_id) === false;
    if (stillDead) {
      db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
    }
  });

  await Promise.all(checks);
}

async function isConfirmedDead(
  agent: Agent,
  cmuxObserver: CmuxLivenessObserver
): Promise<boolean | null> {
  if (!cmuxObserver.isCompetent()) return null;
  const probe = async (): Promise<boolean | null> => agent.agent_type === 'a2a'
    ? await isAgentAlive(agent)
    : cmuxObserver.isSurfaceAlive(agent.surface_id, agent.workspace_id);
  const initial = await probe();
  if (initial === null) return null;
  if (initial) return false;
  const confirmed = await probe();
  return confirmed === null ? null : !confirmed;
}

export async function reapIfDead(
  db: SwarmDb,
  swarmId: string,
  name: string,
  cmuxObserver: CmuxLivenessObserver = processCmuxLivenessObserver
): Promise<Agent | null> {
  const existing = getAgent(db, swarmId, name);
  if (!existing) return null;
  if (existing.agent_type === 'headless') return null;
  if (await isConfirmedDead(existing, cmuxObserver)) {
    db.prepare('DELETE FROM agents WHERE id = ?').run(existing.id);
    return existing;
  }
  return null;
}

export async function reapAll(
  db: SwarmDb,
  swarmId?: string,
  cmuxObserver: CmuxLivenessObserver = processCmuxLivenessObserver
): Promise<Agent[]> {
  const agents = swarmId
    ? db.prepare('SELECT * FROM agents WHERE swarm_id = ?').all(swarmId) as unknown as Agent[]
    : db.prepare('SELECT * FROM agents').all() as unknown as Agent[];
  const reaped: Agent[] = [];
  for (const agent of agents) {
    if (agent.agent_type === 'headless') continue;
    if (await isConfirmedDead(agent, cmuxObserver)) {
      db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
      reaped.push(agent);
    }
  }
  return reaped;
}

export function forceReap(db: SwarmDb, swarmId: string, name: string): Agent | null {
  const existing = getAgent(db, swarmId, name);
  if (!existing) return null;
  db.prepare('DELETE FROM agents WHERE id = ?').run(existing.id);
  return existing;
}
