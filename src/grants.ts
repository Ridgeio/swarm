import { withImmediateTransaction, type SwarmDb } from './db.js';
import { getAgent } from './registry.js';
import { requireActiveAgent, requireSwarmAuthority } from './authority.js';
import { observeMonotonicClock } from './clock.js';

export const GRANT_OPS = ['merge', 'prod', 'spend', 'override'] as const;
export type BuiltinGrantOp = typeof GRANT_OPS[number];
export type GrantOp = BuiltinGrantOp | `custom:${string}`;

export interface Grant {
  id: number;
  swarm_id: string;
  op: GrantOp;
  resource: string;
  granted_to: string | null;
  granted_to_agent_id: string | null;
  granted_by: string;
  granted_by_agent_id: string | null;
  note: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface CreateGrantOptions {
  op: string;
  resource: string;
  ttl: string;
  grantedTo?: string;
  note?: string;
  now?: number;
}

export interface FindLiveGrantOptions {
  op: string;
  resources: string[];
  actor: string;
  now?: number;
}

export interface GrantMatch {
  grant: Grant;
  matchedResource: string;
}

export const GRANT_TTL_PATTERN = /^(\d+)(m|h|d)$/;

export function validateGrantOp(value: string): GrantOp {
  if ((GRANT_OPS as readonly string[]).includes(value)) return value as BuiltinGrantOp;
  if (/^custom:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return value as unknown as GrantOp;
  throw new Error(`Invalid grant op "${value}". Use merge, prod, spend, override, or custom:<name>.`);
}

export function parseGrantTtl(value: string): number {
  const match = GRANT_TTL_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid --ttl "${value}". Use a positive duration such as 30m, 2h, or 1d.`);
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`Invalid --ttl "${value}". Use a positive duration such as 30m, 2h, or 1d.`);
  }
  const unitMs = match[2] === 'm'
    ? 60_000
    : match[2] === 'h'
      ? 60 * 60_000
      : 24 * 60 * 60_000;
  const durationMs = amount * unitMs;
  if (!Number.isSafeInteger(durationMs)) {
    throw new Error(`Invalid --ttl "${value}": duration is too large.`);
  }
  return durationMs;
}

export function grantResourceMatches(grantResource: string, requestedResource: string): boolean {
  if (grantResource === '*') return true;
  if (grantResource.endsWith('*')) {
    return requestedResource.startsWith(grantResource.slice(0, -1));
  }
  return grantResource === requestedResource;
}

export function createGrant(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  options: CreateGrantOptions
): Grant {
  const op = validateGrantOp(options.op);
  const resource = options.resource.trim();
  if (!resource) throw new Error('Grant --resource must not be empty.');
  const durationMs = parseGrantTtl(options.ttl);
  const now = options.now ?? Date.now();
  const expiresAtMs = now + durationMs;
  if (
    !Number.isFinite(now) ||
    !Number.isSafeInteger(now) ||
    !Number.isFinite(expiresAtMs) ||
    Math.abs(expiresAtMs) > 8.64e15
  ) {
    throw new Error(`Invalid --ttl "${options.ttl}": expiry is outside the supported date range.`);
  }
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(expiresAtMs).toISOString();
  const requestedRecipient = options.grantedTo?.trim();
  return withImmediateTransaction(db, () => {
    observeMonotonicClock(db, swarmId, 'grant', now);
    const issuer = requireSwarmAuthority(db, swarmId, actor, 'create grant');
    const recipient = requestedRecipient ? getAgent(db, swarmId, requestedRecipient) : null;
    if (requestedRecipient && !recipient) {
      throw new Error(
        `Agent "${requestedRecipient}" not found in this swarm. ` +
        'Run "swarm members" and retry --to with an active agent.'
      );
    }
    const result = db.prepare(`
      INSERT INTO grants (
        swarm_id, op, resource, granted_to, granted_to_agent_id,
        granted_by, granted_by_agent_id, note, created_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      swarmId,
      op,
      resource,
      recipient?.name ?? null,
      recipient?.id ?? null,
      issuer.agent.name,
      issuer.agent.id,
      options.note?.trim() || null,
      createdAt,
      expiresAt
    );
    return db.prepare('SELECT * FROM grants WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as unknown as Grant;
  }) as Grant;
}

export function listGrants(
  db: SwarmDb,
  swarmId: string,
  liveOnly: boolean = false,
  now: number = Date.now()
): Grant[] {
  if (!liveOnly) {
    return db.prepare('SELECT * FROM grants WHERE swarm_id = ? ORDER BY id ASC').all(swarmId) as unknown as Grant[];
  }
  return db.prepare(`
    SELECT * FROM grants
    WHERE swarm_id = ? AND revoked_at IS NULL AND expires_at > ?
    ORDER BY expires_at ASC, id ASC
  `).all(swarmId, new Date(now).toISOString()) as unknown as Grant[];
}

export function revokeGrant(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  id: number,
  now: number = Date.now()
): Grant | null {
  if (!Number.isFinite(now) || !Number.isSafeInteger(now)) {
    throw new Error('Grant revocation time must be a finite integer millisecond timestamp.');
  }
  return withImmediateTransaction(db, () => {
    observeMonotonicClock(db, swarmId, 'grant', now);
    requireSwarmAuthority(db, swarmId, actor, 'revoke grant');
    const existing = db.prepare('SELECT * FROM grants WHERE swarm_id = ? AND id = ?')
      .get(swarmId, id) as unknown as Grant | undefined;
    if (!existing) return null;
    if (existing.revoked_at === null) {
      db.prepare('UPDATE grants SET revoked_at = ? WHERE swarm_id = ? AND id = ? AND revoked_at IS NULL')
        .run(new Date(now).toISOString(), swarmId, id);
    }
    return db.prepare('SELECT * FROM grants WHERE swarm_id = ? AND id = ?')
      .get(swarmId, id) as unknown as Grant;
  }) as Grant;
}

export function findLiveGrant(
  db: SwarmDb,
  swarmId: string,
  options: FindLiveGrantOptions
): GrantMatch | null {
  const op = validateGrantOp(options.op);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || !Number.isSafeInteger(now)) {
    throw new Error('Grant validation time must be a finite integer millisecond timestamp.');
  }
  const find = (): GrantMatch | null => {
    observeMonotonicClock(db, swarmId, 'grant', now);
    const actorAgent = requireActiveAgent(db, swarmId, options.actor, `use ${op} grant`);
    const at = new Date(now).toISOString();
    const candidates = db.prepare(`
      SELECT * FROM grants
      WHERE swarm_id = ? AND op = ? AND revoked_at IS NULL AND expires_at > ?
        AND granted_by_agent_id IS NOT NULL
        AND (
          (granted_to IS NULL AND granted_to_agent_id IS NULL)
          OR granted_to_agent_id = ?
        )
      ORDER BY id ASC
    `).all(swarmId, op, at, actorAgent.id) as unknown as Grant[];
    for (const grant of candidates) {
      for (const requestedResource of options.resources) {
        if (grantResourceMatches(grant.resource, requestedResource)) {
          return { grant, matchedResource: requestedResource };
        }
      }
    }
    return null;
  };
  return db.isTransaction ? find() : withImmediateTransaction(db, find);
}

export function recordGrantUsed(
  db: SwarmDb,
  task: { swarm_id: string; id: string; lease_epoch: number },
  grant: Grant,
  actor: string,
  createdAt: string = new Date().toISOString()
): number {
  const actorAgent = requireActiveAgent(db, task.swarm_id, actor, `record use of grant #${grant.id}`);
  const result = db.prepare(`
    INSERT INTO task_events (
      swarm_id, task_id, epoch, kind, actor, actor_agent_id, data, created_at
    ) VALUES (?, ?, ?, 'grant_used', ?, ?, ?, ?)
  `).run(
    task.swarm_id,
    task.id,
    task.lease_epoch,
    actor,
    actorAgent.id,
    JSON.stringify({
      grant_id: grant.id,
      op: grant.op,
      resource: grant.resource,
      actor,
      actor_agent_id: actorAgent.id,
      granted_by_agent_id: grant.granted_by_agent_id,
      granted_to_agent_id: grant.granted_to_agent_id,
    }),
    createdAt
  );
  return Number(result.lastInsertRowid);
}
