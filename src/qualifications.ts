import { withImmediateTransaction, type SwarmDb } from './db.js';
import { requireActiveAgent, requireSwarmAuthority } from './authority.js';
import { observeMonotonicClock } from './clock.js';
import { parseGrantTtl } from './grants.js';
import { deriveModelFamily, type ModelFamily } from './model-family.js';

export const QUALIFICATION_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReviewerQualification {
  id: number;
  swarm_id: string;
  agent_id: string;
  agent_name: string;
  family: ModelFamily;
  worker_version: string;
  binary_sha256: string;
  model_id: string;
  harness_sha256: string;
  prompt_sha256: string;
  tools_sha256: string;
  qualified_by_agent_id: string;
  qualified_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface QualificationBinding {
  modelId: string;
  harnessSha256: string;
  promptSha256: string;
  toolsSha256: string;
}

export interface RecordReviewerQualificationOptions extends QualificationBinding {
  agent: string;
  binarySha256: string;
  ttl: string;
  now?: number;
}

function sha256(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${field} must be an exact lowercase SHA-256 digest.`);
  }
  return normalized;
}

function finiteNow(now: number, operation: string): void {
  if (!Number.isFinite(now) || !Number.isSafeInteger(now)) {
    throw new Error(`${operation} time must be a finite integer millisecond timestamp.`);
  }
}

export function recordReviewerQualification(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  options: RecordReviewerQualificationOptions
): ReviewerQualification {
  const now = options.now ?? Date.now();
  finiteNow(now, 'Qualification');
  const duration = parseGrantTtl(options.ttl);
  if (duration > QUALIFICATION_MAX_TTL_MS) {
    throw new Error('Reviewer qualification TTL must not exceed 7d.');
  }
  const binarySha256 = sha256(options.binarySha256, '--binary-sha');
  const harnessSha256 = sha256(options.harnessSha256, '--harness-sha');
  const promptSha256 = sha256(options.promptSha256, '--prompt-sha');
  const toolsSha256 = sha256(options.toolsSha256, '--tools-sha');
  const modelId = options.modelId.trim();
  if (!modelId) throw new Error('--model-id must not be empty.');

  return withImmediateTransaction(db, () => {
    observeMonotonicClock(db, swarmId, 'qualification', now);
    const issuer = requireSwarmAuthority(db, swarmId, actor, 'record reviewer qualification');
    const target = requireActiveAgent(db, swarmId, options.agent, 'record reviewer qualification');
    const family = deriveModelFamily(target.host_agent);
    if (family === 'unknown') {
      throw new Error(`Reviewer ${target.name} has unknown model family; rejoin through a supported host before qualification.`);
    }
    if (!target.worker_version || !target.worker_binary_sha256) {
      throw new Error(
        `Reviewer ${target.name} lacks captured worker version/binary identity; rejoin before qualification.`
      );
    }
    if (target.worker_binary_sha256 !== binarySha256) {
      throw new Error(
        `Reviewer ${target.name} binary digest is ${target.worker_binary_sha256}; supplied ${binarySha256} is stale or wrong.`
      );
    }
    const qualifiedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + duration).toISOString();
    const result = db.prepare(`
      INSERT INTO reviewer_qualifications (
        swarm_id, agent_id, agent_name, family, worker_version, binary_sha256,
        model_id, harness_sha256, prompt_sha256, tools_sha256,
        qualified_by_agent_id, qualified_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      swarmId,
      target.id,
      target.name,
      family,
      target.worker_version,
      binarySha256,
      modelId,
      harnessSha256,
      promptSha256,
      toolsSha256,
      issuer.agent.id,
      qualifiedAt,
      expiresAt
    );
    return db.prepare('SELECT * FROM reviewer_qualifications WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as unknown as ReviewerQualification;
  }) as ReviewerQualification;
}

export function listReviewerQualifications(
  db: SwarmDb,
  swarmId: string,
  liveOnly: boolean = false,
  now: number = Date.now()
): ReviewerQualification[] {
  finiteNow(now, 'Qualification list');
  const suffix = liveOnly ? 'AND revoked_at IS NULL AND expires_at > ?' : '';
  const args = liveOnly ? [swarmId, new Date(now).toISOString()] : [swarmId];
  return db.prepare(`
    SELECT * FROM reviewer_qualifications
    WHERE swarm_id = ? ${suffix}
    ORDER BY id ASC
  `).all(...args) as unknown as ReviewerQualification[];
}

export function revokeReviewerQualification(
  db: SwarmDb,
  swarmId: string,
  actor: string,
  id: number,
  now: number = Date.now()
): ReviewerQualification | null {
  finiteNow(now, 'Qualification revocation');
  return withImmediateTransaction(db, () => {
    observeMonotonicClock(db, swarmId, 'qualification', now);
    requireSwarmAuthority(db, swarmId, actor, 'revoke reviewer qualification');
    const existing = db.prepare('SELECT * FROM reviewer_qualifications WHERE swarm_id = ? AND id = ?')
      .get(swarmId, id) as unknown as ReviewerQualification | undefined;
    if (!existing) return null;
    if (existing.revoked_at === null) {
      db.prepare(`
        UPDATE reviewer_qualifications SET revoked_at = ?
        WHERE swarm_id = ? AND id = ? AND revoked_at IS NULL
      `).run(new Date(now).toISOString(), swarmId, id);
    }
    return db.prepare('SELECT * FROM reviewer_qualifications WHERE swarm_id = ? AND id = ?')
      .get(swarmId, id) as unknown as ReviewerQualification;
  }) as ReviewerQualification | null;
}

export function findLiveReviewerQualification(
  db: SwarmDb,
  swarmId: string,
  agentId: string,
  now: number = Date.now(),
  binding?: QualificationBinding,
  exactId?: number
): ReviewerQualification | null {
  finiteNow(now, 'Qualification validation');
  const agent = db.prepare('SELECT * FROM agents WHERE swarm_id = ? AND id = ?')
    .get(swarmId, agentId) as {
      id: string;
      host_agent: string | null;
      worker_version: string | null;
      worker_binary_sha256: string | null;
    } | undefined;
  if (!agent || !agent.worker_version || !agent.worker_binary_sha256) return null;
  const family = deriveModelFamily(agent.host_agent);
  const rows = db.prepare(`
    SELECT * FROM reviewer_qualifications
    WHERE swarm_id = ? AND agent_id = ? AND revoked_at IS NULL AND expires_at > ?
      ${exactId === undefined ? '' : 'AND id = ?'}
    ORDER BY id DESC
  `).all(
    swarmId,
    agentId,
    new Date(now).toISOString(),
    ...(exactId === undefined ? [] : [exactId])
  ) as unknown as ReviewerQualification[];
  return rows.find(row =>
    row.family === family &&
    row.worker_version === agent.worker_version &&
    row.binary_sha256 === agent.worker_binary_sha256 &&
    (!binding || (
      row.model_id === binding.modelId &&
      row.harness_sha256 === sha256(binding.harnessSha256, '--harness-sha') &&
      row.prompt_sha256 === sha256(binding.promptSha256, '--prompt-sha') &&
      row.tools_sha256 === sha256(binding.toolsSha256, '--tools-sha')
    ))
  ) ?? null;
}
