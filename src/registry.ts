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
import { MODEL_FAMILY_MAP as HOST_MODEL_FAMILY } from './model-family.js';
import type { AgentType } from './transport-interface.js';

/**
 * Resolved per call rather than at module load: the state directory follows the
 * current HOME, which keeps session-marker and pointer files under test control
 * instead of writing into the real ~/.swarm.
 */
function swarmDir(): string {
  return path.join(os.homedir(), '.swarm');
}

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
  /** Declared model family ('claude' | 'openai' | 'xai' | 'google'); null = undeclared. */
  model_family: string | null;
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

export interface JoinAgentOptions {
  forceSurface?: boolean;
}

export interface JoinedAgent extends Agent {
  surface_takeover?: {
    prior_name: string;
    surface_id: string;
  };
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
        return path.join(swarmDir(), `headless-${tty}`);
      }
      pid = execFileSync('ps', ['-o', 'ppid=', '-p', pid], { encoding: 'utf-8' }).trim();
    }
  } catch { /* fall through */ }

  return null;
}

/**
 * A headless TTY can hold a membership per swarm, so each one needs its own
 * token file. The UNSCOPED path stays the "active" marker — which swarm an
 * unqualified command means — so single-swarm sessions behave exactly as before.
 */
function scopedSessionMarkerPath(basePath: string, swarmId: string): string {
  return `${basePath}.${createHash('sha256').update(swarmId).digest('hex').slice(0, 16)}`;
}

function parseTtySessionMarker(markerPath: string): SessionMarker | null {
  if (!fs.existsSync(markerPath)) return null;
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

/**
 * With no swarmId: the active marker (this TTY's default swarm).
 * With a swarmId: that swarm's own marker, falling back to the active marker
 * when it already names that swarm — which is every pre-upgrade session.
 */
function readSessionMarker(swarmId?: string): SessionMarker | null {
  const markerPath = getSessionMarkerPath();
  if (!markerPath) return null;
  if (!swarmId) return parseTtySessionMarker(markerPath);

  const scoped = parseTtySessionMarker(scopedSessionMarkerPath(markerPath, swarmId));
  if (scoped) return scoped;
  const active = parseTtySessionMarker(markerPath);
  return active?.swarm_id === swarmId ? active : null;
}

function writeSessionMarker(swarmId: string, agentName: string, sessionToken: string): void {
  const markerPath = getSessionMarkerPath();
  if (!markerPath) return;

  const payload = JSON.stringify(
    { swarm_id: swarmId, agent_name: agentName, session_token: sessionToken },
    null,
    2
  );
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });

  // MIGRATE THE OUTGOING ACTIVE MARKER FIRST.
  //
  // A session that joined before markers were swarm-scoped has ONLY the unscoped file.
  // Overwriting it here to make the new swarm active would destroy the old membership's
  // token — the DB row survives and the roster still lists it, but that swarm can never
  // authenticate again. The feature would report "still a member of alpha" while alpha
  // was in fact stranded, which is the failure-looks-like-success shape this whole branch
  // exists to remove. Give the outgoing membership its scoped home before taking the file.
  const outgoing = parseTtySessionMarker(markerPath);
  if (outgoing && outgoing.swarm_id !== swarmId && outgoing.session_token) {
    const outgoingScoped = scopedSessionMarkerPath(markerPath, outgoing.swarm_id);
    if (!fs.existsSync(outgoingScoped)) {
      fs.writeFileSync(outgoingScoped, JSON.stringify(outgoing, null, 2), { encoding: 'utf-8', mode: 0o600 });
    }
  }

  // Per-swarm marker authenticates this membership; the unscoped one makes it active.
  fs.writeFileSync(scopedSessionMarkerPath(markerPath, swarmId), payload, { encoding: 'utf-8', mode: 0o600 });
  fs.writeFileSync(markerPath, payload, { encoding: 'utf-8', mode: 0o600 });
}

/** Which swarm this TTY's unqualified commands currently target, if any. */
export function readActiveHeadlessSwarmId(): string | null {
  const markerPath = getSessionMarkerPath();
  if (!markerPath) return null;
  return parseTtySessionMarker(markerPath)?.swarm_id ?? null;
}

/**
 * Does this marker still describe a membership this session owns?
 *
 * A marker names a swarm and an agent, and both survive the agent being replaced: another
 * terminal can force-reclaim the name, minting a new token. The marker's token is the only
 * thing that distinguishes "my membership" from "someone else's seat with the same name",
 * so a row-exists check is not enough — it is exactly what reclamation defeats.
 */
function headlessMarkerOwnsRow(db: SwarmDb, marker: SessionMarker): boolean {
  if (!marker.session_token) return false;
  const row = db.prepare(`
    SELECT session_token FROM agents
    WHERE swarm_id = ? AND name = ? COLLATE NOCASE AND agent_type = 'headless'
  `).get(marker.swarm_id, marker.agent_name) as { session_token: string | null } | undefined;
  return !!row && row.session_token === marker.session_token;
}

/** This TTY's headless memberships, each proven by a token match against its live row. */
export function listOwnedHeadlessMarkers(db: SwarmDb): SessionMarker[] {
  return listHeadlessMarkers().filter(marker => headlessMarkerOwnsRow(db, marker));
}

/**
 * Point this TTY's unqualified commands at a swarm it OWNS a membership in. Without the
 * ownership check, a stale marker let a dead session adopt a reclaimed seat as its default
 * and then read that agent's inbox.
 */
export function setActiveHeadlessSwarm(db: SwarmDb, swarmId: string): boolean {
  const markerPath = getSessionMarkerPath();
  if (!markerPath) return false;
  const scoped = parseTtySessionMarker(scopedSessionMarkerPath(markerPath, swarmId));
  if (!scoped || !headlessMarkerOwnsRow(db, scoped)) return false;
  fs.writeFileSync(markerPath, JSON.stringify(scoped, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return true;
}

/**
 * Every swarm this TTY holds a headless marker for.
 *
 * Call it WITHOUT `agentName` to get this terminal's membership set: the marker files are
 * already per-TTY, so all of them belong to this session — and each membership may use a
 * DIFFERENT name (that is the documented contract). Filtering by the active name hid
 * every membership registered under another one.
 */
export function listHeadlessMarkers(agentName?: string): SessionMarker[] {
  const markerPath = getSessionMarkerPath();
  if (!markerPath) return [];
  const dir = path.dirname(markerPath);
  const base = path.basename(markerPath);
  if (!fs.existsSync(dir)) return [];
  const markers: SessionMarker[] = [];
  for (const file of fs.readdirSync(dir)) {
    // Scoped markers only: "<base>.<16 hex>" — never the unscoped active marker.
    if (!file.startsWith(`${base}.`) || !/^[0-9a-f]{16}$/.test(file.slice(base.length + 1))) continue;
    const marker = parseTtySessionMarker(path.join(dir, file));
    if (!marker) continue;
    if (agentName && marker.agent_name.toLowerCase() !== agentName.toLowerCase()) continue;
    markers.push(marker);
  }
  return markers;
}

/**
 * Session markers are keyed by (surface, swarm), not by surface alone: one Cmux
 * surface may hold a membership in several swarms at once, and each membership
 * mints its own token. A surface-only key would let the newest join overwrite the
 * older swarm's token, and `getAuthenticatedSelf` would then throw on the swarm
 * the agent never left.
 */
function surfaceSessionMarkerPath(surfaceId: string, swarmId: string): string {
  const key = createHash('sha256').update(`${surfaceId}\u0000${swarmId}`).digest('hex');
  return path.join(swarmDir(), 'sessions', `cmux-${key}.json`);
}

/** Pre-multi-swarm layout: one marker per surface. Read-only, for migration. */
function legacySurfaceSessionMarkerPath(surfaceId: string): string {
  const key = createHash('sha256').update(surfaceId).digest('hex');
  return path.join(swarmDir(), 'sessions', `cmux-${key}.json`);
}

function parseSessionMarkerFile(markerPath: string): SessionMarker | null {
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

function writeSessionMarkerFile(markerPath: string, marker: SessionMarker): void {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({
    swarm_id: marker.swarm_id,
    agent_name: marker.agent_name,
    session_token: marker.session_token,
  }, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

function readSurfaceSessionMarker(surfaceId: string, swarmId: string): SessionMarker | null {
  const scoped = parseSessionMarkerFile(surfaceSessionMarkerPath(surfaceId, swarmId));
  if (scoped) return scoped;

  // Upgrade path: a session that joined before markers were swarm-scoped still has
  // its token in the legacy surface-only file. Adopt it forward exactly once, so an
  // in-flight agent is not silently logged out by installing this version.
  const legacy = parseSessionMarkerFile(legacySurfaceSessionMarkerPath(surfaceId));
  if (legacy?.swarm_id !== swarmId) return null;
  writeSessionMarkerFile(surfaceSessionMarkerPath(surfaceId, swarmId), legacy);
  return legacy;
}

function writeSurfaceSessionMarker(agent: Agent): void {
  if (!agent.session_token) return;
  writeSessionMarkerFile(surfaceSessionMarkerPath(agent.surface_id, agent.swarm_id), {
    swarm_id: agent.swarm_id,
    agent_name: agent.name,
    session_token: agent.session_token,
  });
}

function removeSurfaceSessionMarker(swarmId: string, surfaceId: string): void {
  fs.rmSync(surfaceSessionMarkerPath(surfaceId, swarmId), { force: true });
  // Only reclaim the legacy file when it belongs to the swarm being left; another
  // swarm's membership may still be relying on it until its own next join.
  const legacyPath = legacySurfaceSessionMarkerPath(surfaceId);
  if (parseSessionMarkerFile(legacyPath)?.swarm_id === swarmId) {
    fs.rmSync(legacyPath, { force: true });
  }
}

/**
 * Which swarm an unqualified command means when this surface belongs to several.
 * Held in a file rather than inferred, because the alternative — "most recent join
 * wins" — makes `swarm send` target a swarm the agent cannot see it picked.
 */
function activeSwarmPointerPath(surfaceId: string): string {
  const key = createHash('sha256').update(surfaceId).digest('hex');
  return path.join(swarmDir(), 'sessions', `active-${key}.json`);
}

export function readActiveSwarmId(surfaceId: string): string | null {
  const pointerPath = activeSwarmPointerPath(surfaceId);
  if (!fs.existsSync(pointerPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(pointerPath, 'utf-8')) as { swarm_id?: string };
    return typeof parsed.swarm_id === 'string' ? parsed.swarm_id : null;
  } catch {
    return null;
  }
}

export function writeActiveSwarmId(surfaceId: string, swarmId: string): void {
  const pointerPath = activeSwarmPointerPath(surfaceId);
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
  fs.writeFileSync(pointerPath, JSON.stringify({ swarm_id: swarmId }, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/** Drop the pointer only when it still names the swarm being left. */
export function clearActiveSwarmId(surfaceId: string, swarmId: string): void {
  if (readActiveSwarmId(surfaceId) === swarmId) {
    fs.rmSync(activeSwarmPointerPath(surfaceId), { force: true });
  }
}

/** Every swarm this Cmux surface currently holds a membership in. */
export function listSurfaceMemberships(db: SwarmDb, surfaceId: string): Agent[] {
  return db.prepare(`
    SELECT * FROM agents
    WHERE surface_id = ? AND agent_type = 'cmux'
    ORDER BY joined_at ASC
  `).all(surfaceId) as unknown as Agent[];
}

function removeSessionMarker(db: SwarmDb, swarmId: string, agentName: string): void {
  const markerPath = getSessionMarkerPath();
  if (!markerPath) return;

  // Drop this swarm's own marker unconditionally...
  const scopedPath = scopedSessionMarkerPath(markerPath, swarmId);
  const scoped = parseTtySessionMarker(scopedPath);
  if (scoped && scoped.agent_name.toLowerCase() === agentName.toLowerCase()) {
    fs.rmSync(scopedPath, { force: true });
  }

  // ...but the active marker only when it is the membership being removed; it may
  // name a different swarm this TTY is still joined to.
  const active = parseTtySessionMarker(markerPath);
  if (active && active.swarm_id === swarmId && active.agent_name.toLowerCase() === agentName.toLowerCase()) {
    fs.rmSync(markerPath, { force: true });
    // Re-point at a surviving membership so the next unqualified command still resolves.
    const survivor = listOwnedHeadlessMarkers(db)[0];
    if (survivor) setActiveHeadlessSwarm(db, survivor.swarm_id);
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
  versionRunner?: WorkerVersionRunner,
  options: JoinAgentOptions = {}
): JoinedAgent {
  const id = randomUUID();
  const sessionToken = agentType === 'a2a' ? null : randomBytes(16).toString('hex');
  const now = nowIso();
  const host = hostAgent ?? null;
  const workerVersion = agentType === 'a2a'
    ? null
    : captureWorkerVersion(host, versionRunner);
  // Record the family a local harness implies, so the roster states it rather than every
  // reader re-deriving it. A2A rows stay null until they declare one.
  const impliedFamily = host ? HOST_MODEL_FAMILY[host] ?? null : null;

  let surfaceTakeover: JoinedAgent['surface_takeover'];
  let persistedFamily: string | null = impliedFamily;
  withImmediateTransaction(db, () => {
    const existing = getAgent(db, swarmId, name);
    if (existing && existing.surface_id !== surfaceId) {
      throw new Error(`Agent name "${name}" is already taken by a ${existing.agent_type} agent in this swarm. Choose a different name.`);
    }

    if (agentType === 'cmux') {
      const surfaceOwners = db.prepare(`
        SELECT * FROM agents
        WHERE swarm_id = ? AND surface_id = ? AND agent_type = 'cmux'
          AND name != ? COLLATE NOCASE
        ORDER BY joined_at DESC
      `).all(swarmId, surfaceId, name) as unknown as Agent[];
      const surfaceOwner = surfaceOwners[0];
      if (surfaceOwner && !options.forceSurface) {
        throw new Error(
          `Cmux surface "${surfaceId}" is already registered as agent "${surfaceOwner.name}" in this swarm. ` +
          'Child or scripted processes should join with --headless. ' +
          'To take over this surface explicitly, re-run with --force-surface.'
        );
      }
      if (surfaceOwner) {
        db.prepare(`
          DELETE FROM agents
          WHERE swarm_id = ? AND surface_id = ? AND agent_type = 'cmux'
            AND name != ? COLLATE NOCASE
        `).run(swarmId, surfaceId, name);
        surfaceTakeover = {
          prior_name: surfaceOwners.map(owner => owner.name).join(', '),
          surface_id: surfaceId,
        };
      }
      // A surface may hold one cmux membership per swarm and belong to many swarms.
      // This previously deleted the surface's rows in every OTHER swarm, so joining a
      // second swarm silently dropped the first — no warning, and the only symptom was
      // a roster the agent had no reason to re-read. Memberships are now independent;
      // `swarm leave` (scoped to one swarm) is the only way out of one.
    }

    db.prepare(`
      INSERT OR REPLACE INTO agents (
        id, swarm_id, name, description, surface_id, workspace_id, ppid,
        joined_at, last_heartbeat, agent_type, endpoint_url, host_agent, session_token,
        worker_version, model_family
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, swarmId, name, description ?? null, surfaceId, workspaceId ?? null, ppid,
      now, now, agentType, endpointUrl ?? null, host, sessionToken, workerVersion,
      // For an A2A row the column is a DECLARATION, so preserve it across a
      // re-registration that says nothing about family — otherwise the agent is silently
      // demoted to UNKNOWN.
      //
      // For a LOCAL row it is a CACHE of an observation, and a cache is not evidence once
      // the observation is unavailable. Carrying it forward meant a seat that first joined
      // as claude-code and later rejoined with its harness undetected still resolved
      // `claude` — so a genuinely Codex process kept a Claude label, and an OpenAI-authored
      // review would accept it as inverted. Stale certainty is worse than admitted
      // ignorance: unknown refuses, wrong approves.
      (persistedFamily = agentType === 'a2a'
        ? (existing?.model_family ?? null)
        : impliedFamily)
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
    // Must match what the INSERT above persisted, including a preserved declaration —
    // a returned object that disagrees with its own row is a trap for every caller.
    model_family: persistedFamily,
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
  return surfaceTakeover ? { ...agent, surface_takeover: surfaceTakeover } : agent;
}

export function joinA2AAgent(
  db: SwarmDb,
  swarmId: string,
  name: string,
  endpointUrl: string,
  description?: string,
  modelFamily?: string | null
): Agent {
  const existing = getAgent(db, swarmId, name);
  if (existing && existing.agent_type === 'cmux') {
    throw new Error(`Agent "${name}" is already registered as a Cmux agent in this swarm. Choose a different name or remove the existing agent first.`);
  }
  const syntheticSurfaceId = `a2a:${swarmId}:${name}`;
  const agent = joinAgent(db, swarmId, name, syntheticSurfaceId, undefined, 0, description, 'a2a', endpointUrl);
  if (modelFamily) setModelFamily(db, swarmId, name, modelFamily);
  return getAgent(db, swarmId, name) ?? agent;
}

/** Record what an agent says it is. Local agents get this from their harness at join. */
export function setModelFamily(db: SwarmDb, swarmId: string, name: string, family: string): void {
  db.prepare('UPDATE agents SET model_family = ? WHERE swarm_id = ? AND name = ? COLLATE NOCASE')
    .run(family, swarmId, name);
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
    // This TTY previously joined THIS swarm under a different name — reap that row so a
    // single interactive session never leaves a ghost behind after a rename.
    // Scoped to the same swarm on purpose: a marker naming a DIFFERENT swarm is a
    // separate membership this TTY still holds, and deleting it was the silent
    // cross-swarm drop that multi-swarm membership exists to prevent.
    const currentMarker = readSessionMarker(swarmId);
    if (currentMarker && currentMarker.agent_name.toLowerCase() !== name.toLowerCase()) {
      db.prepare("DELETE FROM agents WHERE swarm_id = ? AND name = ? COLLATE NOCASE AND agent_type = 'headless'")
        .run(swarmId, currentMarker.agent_name);
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
    removeSessionMarker(db, swarmId, name);
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
    if (!resolvedSwarmId) {
      // This surface may be in several swarms. Honour the explicit active pointer
      // before falling back to recency, and only if it names a live membership.
      const activeSwarmId = readActiveSwarmId(surfaceId);
      if (activeSwarmId) {
        const active = db.prepare(
          "SELECT 1 FROM agents WHERE swarm_id = ? AND surface_id = ? AND agent_type = 'cmux' LIMIT 1"
        ).get(activeSwarmId, surfaceId);
        if (active) resolvedSwarmId = activeSwarmId;
      }
    }
    const sql = resolvedSwarmId
      ? 'SELECT * FROM agents WHERE swarm_id = ? AND surface_id = ? ORDER BY joined_at DESC LIMIT 1'
      : 'SELECT * FROM agents WHERE surface_id = ? ORDER BY joined_at DESC LIMIT 1';
    const params = resolvedSwarmId ? [resolvedSwarmId, surfaceId] : [surfaceId];
    const bySurface = db.prepare(sql).get(...params) as Agent | undefined;
    if (bySurface) {
      const marker = readSurfaceSessionMarker(surfaceId, bySurface.swarm_id);
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

  const activeMarker = readSessionMarker();
  if (activeMarker) {
    const lookup = (swarmId: string, marker: SessionMarker | null): ResolvedSelf | null => {
      if (!marker) return null;
      const row = db.prepare(`
        SELECT * FROM agents
        WHERE swarm_id = ? AND name = ? COLLATE NOCASE AND agent_type = 'headless'
        ORDER BY joined_at DESC
        LIMIT 1
      `).get(swarmId, marker.agent_name) as Agent | undefined;
      return row ? { agent: row, presentedToken: marker.session_token } : null;
    };

    const markerSwarmId = resolvedSwarmId || activeMarker.swarm_id;
    // Authenticate against the marker for the swarm actually being addressed. Using the
    // active marker's token here would reject every command aimed at a second swarm,
    // since each membership mints its own token.
    const resolved = lookup(markerSwarmId, readSessionMarker(markerSwarmId));
    if (resolved) return resolved;

    // The active marker can name a swarm whose row is gone — `swarm reset`/`delete`
    // removes rows without touching markers. Without this fallback the session reported
    // "not joined" while other memberships were alive and reachable, stranding them
    // unless the operator happened to guess the surviving swarm's name. Cmux already
    // ignores a pointer with no live membership; headless must behave the same.
    if (resolvedSwarmId) return null;
    // OWNED markers only, and never filtered by the active marker's name — each
    // membership on this TTY may use a different one. Looping raw markers here bypassed
    // the ownership check that every other consumer applies: the fallback would resolve
    // as a seat another terminal had reclaimed, because `lookup` only asks whether a row
    // exists under that name. Reclamation keeps the name.
    for (const scoped of listOwnedHeadlessMarkers(db)) {
      const survivor = lookup(scoped.swarm_id, scoped);
      if (!survivor) continue;
      // Repoint the active marker, or every later command repeats this search and
      // `whoami` keeps reporting a swarm that no longer exists as the default. If the
      // repoint is refused, this membership is not ours to adopt — do not return it.
      if (!setActiveHeadlessSwarm(db, scoped.swarm_id)) continue;
      return survivor;
    }
    return null;
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

/**
 * Did the caller PROVE it owns the identity it resolved to?
 *
 * Same check as getAuthenticatedSelf, without throwing, for callers that must not fail a
 * read-only command but must not act on an unproven identity either. SWARM_AGENT_NAME is
 * forgeable — anyone local can claim any headless name — so persisting anything derived
 * from the calling process (its harness, hence its model family) is only safe once the
 * token matches. Without this, `whoami` run under someone else's name relabelled them.
 */
export function isSelfTokenValid(db: SwarmDb, swarmId?: string): boolean {
  const resolved = resolveSelf(db, swarmId);
  if (!resolved) return false;
  const { agent, presentedToken } = resolved;
  // Deliberately does NOT grandfather a NULL token, unlike getAuthenticatedSelf.
  //
  // There, treating NULL as acceptable keeps pre-token rows able to run commands after an
  // upgrade — a compatibility allowance. Here the question is different: may this caller
  // WRITE an identity? A row with no token offers no proof of ownership, and accepting
  // its absence let a forged SWARM_AGENT_NAME relabel exactly the legacy rows an upgrade
  // leaves behind. Absence of evidence is not evidence. Such a row keeps working; it
  // simply cannot be relabelled until a rejoin mints it a token.
  if (agent.session_token === null) return false;
  return tokensMatch(agent.session_token, presentedToken);
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

/**
 * The harness is a property of the TERMINAL, not of one swarm — the same fact the
 * heartbeat already propagates. Refreshing only the selected swarm left sibling
 * memberships carrying the harness they saw at join, so one surface could resolve
 * `claude` in alpha and `openai` in beta at the same instant, and a review in the stale
 * swarm would accept an inverted family that was not inverted.
 *
 * A2A rows are never touched: they describe a remote agent, and the local caller's
 * harness says nothing about it.
 */
export function refreshHostAcrossMemberships(
  db: SwarmDb,
  self: Agent,
  hostAgent: HostAgentKind
): void {
  if (self.agent_type === 'a2a') return;
  const family = HOST_MODEL_FAMILY[hostAgent] ?? null;

  if (self.agent_type === 'cmux') {
    // One real surface id covers every membership this terminal holds.
    db.prepare(
      "UPDATE agents SET host_agent = ?, model_family = ? WHERE surface_id = ? AND agent_type = 'cmux'"
    ).run(hostAgent, family, self.surface_id);
    return;
  }

  // ALWAYS record it on the authenticated row itself. A headless agent resolved via
  // SWARM_AGENT_NAME (spawned/batch paths) may hold no controlling-TTY markers at all, and
  // a marker-only loop then updated zero rows — the detected harness was written to the
  // in-memory object and lost at process exit.
  db.prepare(
    "UPDATE agents SET host_agent = ?, model_family = ? WHERE swarm_id = ? AND name = ? COLLATE NOCASE AND agent_type = 'headless'"
  ).run(hostAgent, family, self.swarm_id, self.name);

  // Siblings come from this TTY's markers, but a marker can be STALE: another terminal
  // may have force-reclaimed that name, minting a new token. Writing on name alone let a
  // dead session relabel a live agent's family — a wrong-family approval. Require the
  // row's token to match the marker that claims it.
  const sibling = db.prepare(`
    SELECT session_token FROM agents
    WHERE swarm_id = ? AND name = ? COLLATE NOCASE AND agent_type = 'headless'
  `);
  const update = db.prepare(
    "UPDATE agents SET host_agent = ?, model_family = ? WHERE swarm_id = ? AND name = ? COLLATE NOCASE AND agent_type = 'headless'"
  );
  for (const marker of listHeadlessMarkers()) {
    if (marker.swarm_id === self.swarm_id) continue;
    const row = sibling.get(marker.swarm_id, marker.agent_name) as { session_token: string | null } | undefined;
    if (!row || !marker.session_token || row.session_token !== marker.session_token) continue;
    update.run(hostAgent, family, marker.swarm_id, marker.agent_name);
  }
}

export function updateHeartbeat(db: SwarmDb, swarmId: string, surfaceId: string): void {
  const now = nowIso();
  db.prepare('UPDATE agents SET last_heartbeat = ? WHERE swarm_id = ? AND surface_id = ?').run(now, swarmId, surfaceId);
  db.prepare('UPDATE swarms SET last_active_at = ? WHERE id = ?').run(now, swarmId);
}

/**
 * A heartbeat records that the TERMINAL is alive, which is true for every swarm the
 * surface belongs to — not only the one whose command happened to run. Without this,
 * non-default memberships keep a heartbeat frozen at join time, and cleanupStale's
 * `heartbeatAge <= STALE_THRESHOLD_MS` grace clause — the only thing standing between
 * a false-negative liveness probe and deletion — is permanently disarmed for them.
 */
export function touchSurfaceMemberships(db: SwarmDb, surfaceId: string): void {
  const now = nowIso();
  db.prepare("UPDATE agents SET last_heartbeat = ? WHERE surface_id = ? AND agent_type = 'cmux'")
    .run(now, surfaceId);
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
