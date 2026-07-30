import { withImmediateTransaction, type SwarmDb } from './db.js';
import { getAgent, type Agent } from './registry.js';
import { observeMonotonicClock } from './clock.js';

export type SwarmAuthorityRole = 'owner' | 'lead';

export interface SwarmAuthority {
  id: number;
  swarm_id: string;
  role: SwarmAuthorityRole;
  agent_id: string;
  agent_name: string;
  assigned_by_agent_id: string;
  assignment_kind: 'bootstrap' | 'assigned';
  created_at: string;
  revoked_at: string | null;
}

export function listSwarmAuthorities(
  db: SwarmDb,
  swarmId: string,
  activeOnly: boolean = true
): SwarmAuthority[] {
  return db.prepare(`
    SELECT * FROM swarm_authorities
    WHERE swarm_id = ? ${activeOnly ? 'AND revoked_at IS NULL' : ''}
    ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, id ASC
  `).all(swarmId) as unknown as SwarmAuthority[];
}

export function activeAuthorityForAgent(
  db: SwarmDb,
  swarmId: string,
  agentId: string
): SwarmAuthority[] {
  return db.prepare(`
    SELECT * FROM swarm_authorities
    WHERE swarm_id = ? AND agent_id = ? AND revoked_at IS NULL
    ORDER BY id ASC
  `).all(swarmId, agentId) as unknown as SwarmAuthority[];
}

export function requireActiveAgent(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  operation: string
): Agent {
  const agent = getAgent(db, swarmId, actor);
  if (!agent) {
    throw new Error(
      `Refused ${operation}: "${actor}" has no active agent registration. ` +
      'Join the swarm first; names alone never confer authority.'
    );
  }
  return agent;
}

export function requireSwarmAuthority(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  operation: string,
  roles: readonly SwarmAuthorityRole[] = ['owner', 'lead']
): { agent: Agent; authority: SwarmAuthority } {
  const agent = requireActiveAgent(db, swarmId, actor, operation);
  const authority = activeAuthorityForAgent(db, swarmId, agent.id)
    .find(row => roles.includes(row.role));
  if (!authority) {
    throw new Error(
      `Refused ${operation}: ${agent.name} registration ${agent.id} is not an active ` +
      `${roles.map(role => role === 'owner' ? 'Owner' : 'Lead').join('/')} authority.`
    );
  }
  return { agent, authority };
}

/**
 * The first non-A2A registration is bound as both Owner and Lead. The rows bind
 * the immutable registration ID, so leaving/rejoining under the same display
 * name does not inherit either role. If any authority history exists, bootstrap
 * is permanently closed and recovery must come from an active Owner/Lead.
 */
export function bootstrapSwarmAuthority(
  db: SwarmDb,
  swarmId: string,
  agent: Agent,
  now: number = Date.now()
): SwarmAuthority[] {
  if (agent.agent_type === 'a2a' || agent.session_token === null) return [];
  return withImmediateTransaction(db, () => {
    const history = db.prepare(
      'SELECT id FROM swarm_authorities WHERE swarm_id = ? LIMIT 1'
    ).get(swarmId);
    if (history) return [];
    observeMonotonicClock(db, swarmId, 'authority', now);
    const createdAt = new Date(now).toISOString();
    const insert = db.prepare(`
      INSERT INTO swarm_authorities (
        swarm_id, role, agent_id, agent_name, assigned_by_agent_id,
        assignment_kind, created_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, 'bootstrap', ?, NULL)
    `);
    insert.run(swarmId, 'owner', agent.id, agent.name, agent.id, createdAt);
    insert.run(swarmId, 'lead', agent.id, agent.name, agent.id, createdAt);
    return listSwarmAuthorities(db, swarmId);
  }) as SwarmAuthority[];
}

export function assignSwarmAuthority(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  role: SwarmAuthorityRole,
  targetName: string,
  now: number = Date.now()
): SwarmAuthority {
  return withImmediateTransaction(db, () => {
    observeMonotonicClock(db, swarmId, 'authority', now);
    // Re-resolve both parties under the write lock. A role or registration
    // change between CLI authentication and this transaction must not authorize
    // a stale issuer or silently retarget a same-name recipient.
    const issuer = requireSwarmAuthority(db, swarmId, actor, `assign ${role} authority`);
    const target = requireActiveAgent(db, swarmId, targetName, `assign ${role} authority`);
    const timestamp = new Date(now).toISOString();
    db.prepare(`
      UPDATE swarm_authorities SET revoked_at = ?
      WHERE swarm_id = ? AND role = ? AND revoked_at IS NULL
    `).run(timestamp, swarmId, role);
    const inserted = db.prepare(`
      INSERT INTO swarm_authorities (
        swarm_id, role, agent_id, agent_name, assigned_by_agent_id,
        assignment_kind, created_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, 'assigned', ?, NULL)
    `).run(swarmId, role, target.id, target.name, issuer.agent.id, timestamp);
    return db.prepare('SELECT * FROM swarm_authorities WHERE id = ?')
      .get(Number(inserted.lastInsertRowid)) as unknown as SwarmAuthority;
  }) as SwarmAuthority;
}
