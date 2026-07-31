import { withImmediateTransaction, type SwarmDb } from './db.js';
import { requireSwarmAuthority } from './authority.js';
import { observeMonotonicClock } from './clock.js';
import { parseGrantTtl } from './grants.js';
import { getTask, validateTaskSlug } from './tasks.js';

export const MIGRATION_LEASE_MAX_TTL_MS = 24 * 60 * 60 * 1000;

export interface MigrationResourceLease {
  id: number;
  swarm_id: string;
  resource: string;
  task_id: string;
  task_epoch: number;
  holder_agent_id: string;
  holder_name: string;
  created_by_agent_id: string;
  created_at: string;
  expires_at: string;
  released_at: string | null;
  release_reason: string | null;
}

export interface ReserveMigrationResourceOptions {
  resource: string;
  taskId: string;
  ttl: string;
  now?: number;
}

function canonicalMigrationResource(value: string): string {
  const trimmed = value.trim().replace(/^migration:/i, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(trimmed)) {
    throw new Error(
      'Migration resource must use 1-128 letters, digits, dot, underscore, slash, or hyphen characters.'
    );
  }
  return `migration:${trimmed.toLowerCase()}`;
}

function finiteNow(now: number): void {
  if (!Number.isFinite(now) || !Number.isSafeInteger(now)) {
    throw new Error('Migration lease time must be a finite integer millisecond timestamp.');
  }
}

function expireLeases(db: SwarmDb, swarmId: string, now: number): void {
  const timestamp = new Date(now).toISOString();
  db.prepare(`
    UPDATE migration_resource_leases
    SET released_at = ?, release_reason = 'expired'
    WHERE swarm_id = ? AND released_at IS NULL AND expires_at <= ?
  `).run(timestamp, swarmId, timestamp);
}

export function reserveMigrationResource(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  options: ReserveMigrationResourceOptions
): MigrationResourceLease {
  validateTaskSlug(options.taskId);
  const resource = canonicalMigrationResource(options.resource);
  const now = options.now ?? Date.now();
  finiteNow(now);
  const duration = parseGrantTtl(options.ttl);
  if (duration > MIGRATION_LEASE_MAX_TTL_MS) {
    throw new Error('Migration resource lease TTL must not exceed 1d.');
  }

  return withImmediateTransaction(db, () => {
    observeMonotonicClock(db, swarmId, 'migration-lease', now);
    const issuer = requireSwarmAuthority(db, swarmId, actor, 'reserve migration resource');
    expireLeases(db, swarmId, now);
    const task = getTask(db, swarmId, options.taskId);
    if (!task || !['active', 'awaiting_review'].includes(task.state) || !task.owner_agent_id || !task.owner_agent) {
      throw new Error(`Migration resource ${resource} requires an active, registration-bound task.`);
    }
    const conflict = db.prepare(`
      SELECT * FROM migration_resource_leases
      WHERE swarm_id = ? AND resource = ? AND released_at IS NULL
    `).get(swarmId, resource) as unknown as MigrationResourceLease | undefined;
    if (conflict) {
      throw new Error(
        `Migration resource ${resource} is exclusively leased to task "${conflict.task_id}" ` +
        `at epoch ${conflict.task_epoch} until ${conflict.expires_at}.`
      );
    }
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + duration).toISOString();
    const inserted = db.prepare(`
      INSERT INTO migration_resource_leases (
        swarm_id, resource, task_id, task_epoch, holder_agent_id, holder_name,
        created_by_agent_id, created_at, expires_at, released_at, release_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      swarmId,
      resource,
      task.id,
      task.lease_epoch,
      task.owner_agent_id,
      task.owner_agent,
      issuer.agent.id,
      createdAt,
      expiresAt
    );
    return db.prepare('SELECT * FROM migration_resource_leases WHERE id = ?')
      .get(Number(inserted.lastInsertRowid)) as unknown as MigrationResourceLease;
  }) as MigrationResourceLease;
}

export function releaseMigrationResource(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  resourceInput: string,
  reason: string,
  now: number = Date.now()
): MigrationResourceLease | null {
  const resource = canonicalMigrationResource(resourceInput);
  const releaseReason = reason.replace(/\s+/g, ' ').trim();
  if (!releaseReason) throw new Error('Migration lease release requires --reason <text>.');
  finiteNow(now);
  return withImmediateTransaction(db, () => {
    observeMonotonicClock(db, swarmId, 'migration-lease', now);
    requireSwarmAuthority(db, swarmId, actor, 'release migration resource');
    expireLeases(db, swarmId, now);
    const existing = db.prepare(`
      SELECT * FROM migration_resource_leases
      WHERE swarm_id = ? AND resource = ? AND released_at IS NULL
    `).get(swarmId, resource) as unknown as MigrationResourceLease | undefined;
    if (!existing) return null;
    db.prepare(`
      UPDATE migration_resource_leases
      SET released_at = ?, release_reason = ?
      WHERE id = ? AND released_at IS NULL
    `).run(new Date(now).toISOString(), releaseReason, existing.id);
    return db.prepare('SELECT * FROM migration_resource_leases WHERE id = ?')
      .get(existing.id) as unknown as MigrationResourceLease;
  }) as MigrationResourceLease | null;
}

export function listMigrationResources(
  db: SwarmDb,
  swarmId: string,
  liveOnly: boolean = false,
  now: number = Date.now()
): MigrationResourceLease[] {
  finiteNow(now);
  if (liveOnly) {
    withImmediateTransaction(db, () => expireLeases(db, swarmId, now));
  }
  return db.prepare(`
    SELECT * FROM migration_resource_leases
    WHERE swarm_id = ? ${liveOnly ? 'AND released_at IS NULL' : ''}
    ORDER BY id ASC
  `).all(swarmId) as unknown as MigrationResourceLease[];
}
