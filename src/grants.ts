import type { SwarmDb } from './db.js';
import { getAgent } from './registry.js';

export const GRANT_OPS = ['merge', 'prod', 'spend', 'override'] as const;
export type BuiltinGrantOp = typeof GRANT_OPS[number];
export type GrantOp = BuiltinGrantOp | `custom:${string}`;

export interface Grant {
  id: number;
  swarm_id: string;
  op: GrantOp;
  resource: string;
  granted_to: string | null;
  granted_by: string;
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
  if (!Number.isFinite(now) || !Number.isFinite(expiresAtMs) || Math.abs(expiresAtMs) > 8.64e15) {
    throw new Error(`Invalid --ttl "${options.ttl}": expiry is outside the supported date range.`);
  }
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(expiresAtMs).toISOString();
  const requestedRecipient = options.grantedTo?.trim();
  let grantedTo: string | null = null;
  if (requestedRecipient) {
    const agent = getAgent(db, swarmId, requestedRecipient);
    if (!agent) {
      throw new Error(`Agent "${requestedRecipient}" not found in this swarm. Run "swarm members" and retry --to with an active agent.`);
    }
    grantedTo = agent.name;
  }
  const result = db.prepare(`
    INSERT INTO grants (
      swarm_id, op, resource, granted_to, granted_by, note, created_at, expires_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    swarmId,
    op,
    resource,
    grantedTo,
    actor,
    options.note?.trim() || null,
    createdAt,
    expiresAt
  );
  return db.prepare('SELECT * FROM grants WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as Grant;
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
  id: number,
  now: number = Date.now()
): Grant | null {
  const existing = db.prepare('SELECT * FROM grants WHERE swarm_id = ? AND id = ?')
    .get(swarmId, id) as unknown as Grant | undefined;
  if (!existing) return null;
  if (existing.revoked_at === null) {
    db.prepare('UPDATE grants SET revoked_at = ? WHERE swarm_id = ? AND id = ? AND revoked_at IS NULL')
      .run(new Date(now).toISOString(), swarmId, id);
  }
  return db.prepare('SELECT * FROM grants WHERE swarm_id = ? AND id = ?')
    .get(swarmId, id) as unknown as Grant;
}

export function findLiveGrant(
  db: SwarmDb,
  swarmId: string,
  options: FindLiveGrantOptions
): GrantMatch | null {
  const op = validateGrantOp(options.op);
  const at = new Date(options.now ?? Date.now()).toISOString();
  const candidates = db.prepare(`
    SELECT * FROM grants
    WHERE swarm_id = ? AND op = ? AND revoked_at IS NULL AND expires_at > ?
      AND (granted_to IS NULL OR granted_to = ? COLLATE NOCASE)
    ORDER BY id ASC
  `).all(swarmId, op, at, options.actor) as unknown as Grant[];
  for (const grant of candidates) {
    for (const resource of options.resources) {
      if (grantResourceMatches(grant.resource, resource)) {
        return { grant, matchedResource: resource };
      }
    }
  }
  return null;
}

export function recordGrantUsed(
  db: SwarmDb,
  task: { swarm_id: string; id: string; lease_epoch: number },
  grant: Grant,
  actor: string,
  createdAt: string = new Date().toISOString()
): number {
  const result = db.prepare(`
    INSERT INTO task_events (swarm_id, task_id, epoch, kind, actor, data, created_at)
    VALUES (?, ?, ?, 'grant_used', ?, ?, ?)
  `).run(
    task.swarm_id,
    task.id,
    task.lease_epoch,
    actor,
    JSON.stringify({ grant_id: grant.id, op: grant.op, resource: grant.resource, actor }),
    createdAt
  );
  return Number(result.lastInsertRowid);
}
