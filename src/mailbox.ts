import { withImmediateTransaction, type SwarmDb } from './db.js';
import { deliverToAgent } from './transport-router.js';
import { getAgent, listAgents } from './registry.js';
import type { DeliveryOptions } from './transport-interface.js';
import { listSwarmAuthorities } from './authority.js';
import { observeMonotonicClock } from './clock.js';

export interface Message {
  id: number;
  swarm_id: string;
  from_agent: string;
  from_agent_id: string | null;
  to_agent: string | null;
  to_agent_id: string | null;
  body: string;
  delivered: number;
  created_at: string;
  kind: string | null;
  superseded_by: number | null;
}

export interface MessageDelivery {
  message_id: number;
  swarm_id: string;
  recipient: string;
  recipient_agent_id: string | null;
  status: 'pending' | 'injected' | 'acked';
  first_injected_at: string | null;
  inject_count: number;
  acked_at: string | null;
}

export interface HookInboxEntry {
  message: Message;
  delivery: MessageDelivery;
  collapsed: boolean;
  unackedMinutes: number;
}

export interface InboxWaitOptions {
  timeoutSeconds: number;
  peek?: boolean;
  kind?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
}

export interface InboxWaitResult {
  messages: Message[];
  timedOut: boolean;
}

export interface RequiredMessageResponse {
  id: number;
  swarm_id: string;
  request_message_id: number | null;
  sender_agent_id: string;
  sender_name: string;
  recipient_agent_id: string;
  recipient_name: string;
  required_by: string;
  status: 'pending' | 'resolved' | 'expired';
  created_at: string;
  resolved_at: string | null;
  reply_message_id: number | null;
  expiry_reason: string | null;
}

export interface RequiredResponseSweepResult {
  expired: RequiredMessageResponse[];
}

// Allowed values for the optional message classification tag. Validated at the CLI
// boundary (a typo'd kind would otherwise store an unfilterable message); storage
// itself is a plain nullable TEXT column so builds with a different set stay readable.
export const MESSAGE_KINDS = ['status', 'digest', 'merge-req', 'escalation', 'ack', 'gate', 'handoff'] as const;
export const HOOK_INJECT_COLLAPSE_COUNT = 3;
export const HOOK_INJECT_BACKOFF_MINUTES = 45;
export const HOOK_INJECT_BACKOFF_MS = HOOK_INJECT_BACKOFF_MINUTES * 60_000;

export interface EnqueueDirectMessageOptions {
  createdAt?: string;
  kind?: string | null;
  supersedes?: number;
  fromAgentId?: string | null;
  recipientAgentId?: string;
  requiredBy?: string;
  replyTo?: number;
}

export interface FlushOutboxResult {
  pushed: number;
  queued: number;
}

/**
 * Insert the canonical message, exact-recipient delivery row, and push outbox
 * record. This function deliberately does not open a transaction: callers can
 * compose it into the same IMMEDIATE transaction as an offer/acceptance.
 */
export function enqueueDirectMessage(
  db: SwarmDb,
  swarmId: string,
  fromName: string,
  toName: string,
  body: string,
  options: EnqueueDirectMessageOptions = {}
): number {
  const target = getAgent(db, swarmId, toName);
  const recipientAgentId = options.recipientAgentId ?? target?.id;
  if (!recipientAgentId) {
    throw new Error(`Agent "${toName}" not found. Run 'swarm members' to see active agents.`);
  }
  const canonicalRecipient = target?.id === recipientAgentId ? target.name : toName;
  const source = getAgent(db, swarmId, fromName);
  const fromAgentId = options.fromAgentId === undefined ? source?.id ?? null : options.fromAgentId;
  if (fromAgentId !== null && source?.id !== fromAgentId) {
    throw new Error(
      `Sender registration changed for "${fromName}" before the message committed; ` +
      're-resolve identity and retry.'
    );
  }
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (options.requiredBy !== undefined && options.replyTo !== undefined) {
    throw new Error('A message cannot both require a reply and resolve another required reply.');
  }
  if (
    options.supersedes !== undefined &&
    (options.requiredBy !== undefined || options.replyTo !== undefined)
  ) {
    throw new Error('Required-reply messages cannot also supersede another message.');
  }
  if ((options.requiredBy !== undefined || options.replyTo !== undefined) && fromAgentId === null) {
    throw new Error('Required replies need an immutable sender registration ID.');
  }
  if (options.requiredBy !== undefined) {
    const requiredByMs = new Date(options.requiredBy).getTime();
    const createdAtMs = new Date(createdAt).getTime();
    if (!Number.isFinite(requiredByMs) || !Number.isFinite(createdAtMs) || requiredByMs <= createdAtMs) {
      throw new Error('Required-reply deadline must be a valid time after message creation.');
    }
    observeMonotonicClock(db, swarmId, 'required-response', createdAtMs);
  }
  const replyRequest = options.replyTo === undefined
    ? undefined
    : db.prepare(`
        SELECT * FROM required_message_responses
        WHERE swarm_id = ? AND request_message_id = ? AND status = 'pending'
      `).get(swarmId, options.replyTo) as RequiredMessageResponse | undefined;
  if (options.replyTo !== undefined) {
    if (
      !replyRequest ||
      replyRequest.recipient_agent_id !== fromAgentId ||
      replyRequest.sender_agent_id !== recipientAgentId
    ) {
      throw new Error(
        `Cannot resolve required reply #${options.replyTo}: it is not pending from this exact sender registration ` +
        'to the exact original requester.'
      );
    }
    const replyAtMs = new Date(createdAt).getTime();
    observeMonotonicClock(db, swarmId, 'required-response', replyAtMs);
    if (replyRequest.required_by <= createdAt) {
      throw new Error(
        `Cannot resolve required reply #${options.replyTo}: its deadline ${replyRequest.required_by} has passed.`
      );
    }
  }

  if (options.supersedes !== undefined) {
    const previous = db.prepare(`
      SELECT id, from_agent_id FROM messages
      WHERE id = ? AND swarm_id = ?
    `).get(options.supersedes, swarmId) as { id: number; from_agent_id: string | null } | undefined;
    const sameImmutableSender = previous && fromAgentId !== null && previous.from_agent_id === fromAgentId;
    if (!sameImmutableSender) {
      throw new Error(
        `Cannot supersede message #${options.supersedes}: you can only supersede your own messages, ` +
        'and ownership is the same authenticated sender registration ID.'
      );
    }
  }

  const result = db.prepare(`
    INSERT INTO messages (
      swarm_id, from_agent, from_agent_id, to_agent, to_agent_id,
      body, delivered, created_at, kind
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    swarmId,
    fromName,
    fromAgentId,
    canonicalRecipient,
    recipientAgentId,
    body,
    createdAt,
    options.kind ?? null
  );
  const messageId = Number(result.lastInsertRowid);

  db.prepare(`
    INSERT INTO message_deliveries (
      message_id, swarm_id, recipient, recipient_agent_id, status
    ) VALUES (?, ?, ?, ?, 'pending')
  `).run(messageId, swarmId, canonicalRecipient, recipientAgentId);
  db.prepare(`
    INSERT INTO message_outbox (
      message_id, swarm_id, recipient_agent_id, state, attempts,
      last_error, created_at, pushed_at
    ) VALUES (?, ?, ?, 'pending', 0, NULL, ?, NULL)
  `).run(messageId, swarmId, recipientAgentId, createdAt);

  if (options.requiredBy !== undefined) {
    db.prepare(`
      INSERT INTO required_message_responses (
        swarm_id, request_message_id, sender_agent_id, sender_name,
        recipient_agent_id, recipient_name, required_by, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      swarmId,
      messageId,
      fromAgentId,
      fromName,
      recipientAgentId,
      canonicalRecipient,
      options.requiredBy,
      createdAt
    );
  }
  if (replyRequest) {
    const changed = db.prepare(`
      UPDATE required_message_responses
      SET status = 'resolved', resolved_at = ?, reply_message_id = ?, expiry_reason = NULL
      WHERE id = ? AND status = 'pending'
    `).run(createdAt, messageId, replyRequest.id);
    if (Number(changed.changes) !== 1) {
      throw new Error(`Required reply #${options.replyTo} changed before the response committed.`);
    }
    if (replyRequest.request_message_id !== null) {
      db.prepare(`
        UPDATE message_deliveries
        SET status = 'acked', acked_at = COALESCE(acked_at, ?)
        WHERE message_id = ? AND swarm_id = ? AND recipient_agent_id = ?
      `).run(createdAt, replyRequest.request_message_id, swarmId, fromAgentId);
      db.prepare(`
        DELETE FROM message_outbox
        WHERE message_id = ? AND recipient_agent_id = ? AND state = 'pending'
      `).run(replyRequest.request_message_id, fromAgentId);
    }
  }

  if (options.supersedes !== undefined) {
    db.prepare('UPDATE messages SET superseded_by = ? WHERE id = ? AND swarm_id = ?')
      .run(messageId, options.supersedes, swarmId);
  }
  return messageId;
}

export async function flushMessageOutbox(
  db: SwarmDb,
  messageIds?: readonly number[],
  deliver: typeof deliverToAgent = deliverToAgent
): Promise<FlushOutboxResult> {
  if (messageIds?.length === 0) return { pushed: 0, queued: 0 };
  const params: number[] = [];
  let filter = '';
  if (messageIds) {
    const ids = [...new Set(messageIds)];
    filter = `AND o.message_id IN (${ids.map(() => '?').join(', ')})`;
    params.push(...ids);
  }
  const rows = db.prepare(`
    SELECT
      o.message_id,
      o.recipient_agent_id,
      m.swarm_id,
      m.from_agent,
      m.body,
      required.required_by,
      a.id AS active_agent_id
    FROM message_outbox o
    JOIN messages m ON m.id = o.message_id AND m.swarm_id = o.swarm_id
    LEFT JOIN required_message_responses required
      ON required.swarm_id = m.swarm_id
      AND required.request_message_id = m.id
      AND required.status = 'pending'
    LEFT JOIN agents a
      ON a.id = o.recipient_agent_id AND a.swarm_id = o.swarm_id
    WHERE o.state = 'pending'
      ${filter}
    ORDER BY o.message_id ASC, o.recipient_agent_id ASC
  `).all(...params) as Array<{
    message_id: number;
    recipient_agent_id: string;
    swarm_id: string;
    from_agent: string;
    body: string;
    required_by: string | null;
    active_agent_id: string | null;
  }>;

  let pushed = 0;
  let queued = 0;
  for (const row of rows) {
    const target = row.active_agent_id
      ? db.prepare('SELECT * FROM agents WHERE id = ? AND swarm_id = ?')
        .get(row.recipient_agent_id, row.swarm_id) as unknown as ReturnType<typeof getAgent>
      : null;
    if (!target) {
      db.prepare(`
        UPDATE message_outbox
        SET attempts = attempts + 1, last_error = ?
        WHERE message_id = ? AND recipient_agent_id = ? AND state = 'pending'
      `).run('recipient registration is not active', row.message_id, row.recipient_agent_id);
      queued += 1;
      continue;
    }
    try {
      const requiredReply = row.required_by === null
        ? ''
        : `\n[REPLY REQUIRED: request #${row.message_id}; due ${row.required_by}; ` +
          `resolve with: swarm send ${row.from_agent} "<answer>" --reply-to ${row.message_id}]`;
      const result = await deliver(
        target,
        `[SWARM from ${row.from_agent}]: ${row.body}${requiredReply}`
      );
      if (!result.delivered) {
        db.prepare(`
          UPDATE message_outbox
          SET attempts = attempts + 1, last_error = ?
          WHERE message_id = ? AND recipient_agent_id = ? AND state = 'pending'
        `).run(result.error ?? 'push delivery failed', row.message_id, row.recipient_agent_id);
        queued += 1;
        continue;
      }
      const pushedAt = new Date().toISOString();
      const changed = db.prepare(`
        UPDATE message_outbox
        SET state = 'pushed', attempts = attempts + 1, last_error = NULL, pushed_at = ?
        WHERE message_id = ? AND recipient_agent_id = ? AND state = 'pending'
      `).run(pushedAt, row.message_id, row.recipient_agent_id);
      if (Number(changed.changes) > 0) {
        db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?').run(row.message_id);
        pushed += 1;
      }
    } catch (error: unknown) {
      db.prepare(`
        UPDATE message_outbox
        SET attempts = attempts + 1, last_error = ?
        WHERE message_id = ? AND recipient_agent_id = ? AND state = 'pending'
      `).run(
        error instanceof Error ? error.message : String(error),
        row.message_id,
        row.recipient_agent_id
      );
      queued += 1;
    }
  }
  return { pushed, queued };
}

export async function sendMessage(
  db: SwarmDb,
  swarmId: string,
  fromName: string,
  toName: string,
  body: string,
  options?: DeliveryOptions,
  kind?: string | null,
  supersedes?: number,
  coordination?: { requiredBy?: string; replyTo?: number }
): Promise<{ delivered: boolean; queued: boolean; message: string; messageId?: number }> {
  const target = getAgent(db, swarmId, toName);
  if (!target) {
    return { delivered: false, queued: false, message: `Agent "${toName}" not found. Run 'swarm members' to see active agents.` };
  }

  const msgId = withImmediateTransaction(db, () => enqueueDirectMessage(
    db,
    swarmId,
    fromName,
    target.name,
    body,
    {
      kind: kind ?? null,
      supersedes,
      recipientAgentId: target.id,
      requiredBy: coordination?.requiredBy,
      replyTo: coordination?.replyTo,
    }
  ));
  const deliveryResult = await flushMessageOutbox(
    db,
    [msgId],
    (agent, formatted) => deliverToAgent(agent, formatted, options)
  );
  if (deliveryResult.pushed > 0) {
    const required = coordination?.requiredBy
      ? `; reply required by ${coordination.requiredBy} (request #${msgId})`
      : '';
    const reply = coordination?.replyTo ? `; resolves required message #${coordination.replyTo}` : '';
    return { delivered: true, queued: false, message: `Message sent to ${toName}${required}${reply}`, messageId: msgId };
  } else {
    // Push failed but the message is in the DB. Cmux/headless recipients pick it
    // up via `swarm inbox`; a2a recipients get retried by the redeliver worker
    // (their endpoint may be briefly down, e.g. a service restart) and can also
    // read their inbox remotely (getSelf resolves SWARM_AGENT_NAME for a2a).
    // The caller should spawn a redeliver worker so an idle recipient isn't
    // stuck waiting for a turn that never comes (see redeliver.ts).
    const required = coordination?.requiredBy
      ? `; reply required by ${coordination.requiredBy} (request #${msgId})`
      : '';
    const reply = coordination?.replyTo ? `; resolves required message #${coordination.replyTo}` : '';
    return {
      delivered: true,
      queued: true,
      message: `Message sent to ${toName} (queued for retry/inbox)${required}${reply}`,
      messageId: msgId,
    };
  }
}

export function getRequiredResponse(
  db: SwarmDb,
  swarmId: string,
  messageId: number
): RequiredMessageResponse | null {
  const row = db.prepare(`
    SELECT * FROM required_message_responses
    WHERE swarm_id = ? AND request_message_id = ?
  `).get(swarmId, messageId) as RequiredMessageResponse | undefined;
  return row ?? null;
}

export function listPendingRequiredResponsesForRecipient(
  db: SwarmDb,
  swarmId: string,
  recipientName: string
): RequiredMessageResponse[] {
  const recipient = getAgent(db, swarmId, recipientName);
  if (!recipient) return [];
  return db.prepare(`
    SELECT * FROM required_message_responses
    WHERE swarm_id = ?
      AND recipient_agent_id = ?
      AND status = 'pending'
    ORDER BY required_by ASC, id ASC
  `).all(swarmId, recipient.id) as unknown as RequiredMessageResponse[];
}

export function listRequiredResponsesForAgent(
  db: SwarmDb,
  swarmId: string,
  agentName: string,
  includeTerminal: boolean = false
): RequiredMessageResponse[] {
  const agent = getAgent(db, swarmId, agentName);
  if (!agent) return [];
  return db.prepare(`
    SELECT * FROM required_message_responses
    WHERE swarm_id = ?
      AND (sender_agent_id = ? OR recipient_agent_id = ?)
      ${includeTerminal ? '' : "AND status = 'pending'"}
    ORDER BY
      CASE status WHEN 'pending' THEN 0 WHEN 'expired' THEN 1 ELSE 2 END,
      required_by ASC,
      id ASC
  `).all(swarmId, agent.id, agent.id) as unknown as RequiredMessageResponse[];
}

function enqueueRequiredResponseExpiryNotifications(
  db: SwarmDb,
  request: RequiredMessageResponse,
  createdAt: string
): void {
  const recipients: Array<{
    id: string;
    name: string;
    audience: 'sender' | 'authority';
  }> = [];
  const sender = db.prepare(
    'SELECT id, name FROM agents WHERE swarm_id = ? AND id = ?'
  ).get(request.swarm_id, request.sender_agent_id) as { id: string; name: string } | undefined;
  if (sender) recipients.push({ ...sender, audience: 'sender' });
  for (const authority of listSwarmAuthorities(db, request.swarm_id)) {
    const active = db.prepare(
      'SELECT id, name FROM agents WHERE swarm_id = ? AND id = ?'
    ).get(request.swarm_id, authority.agent_id) as { id: string; name: string } | undefined;
    if (!active) continue;
    if (recipients.some(row => row.id === active.id && row.audience === 'authority')) continue;
    recipients.push({ ...active, audience: 'authority' });
  }

  for (const recipient of recipients) {
    const prior = db.prepare(`
      SELECT message_id FROM required_response_expiry_notifications
      WHERE request_id = ? AND recipient_agent_id = ? AND audience = ?
    `).get(request.id, recipient.id, recipient.audience);
    if (prior) continue;
    const body = recipient.audience === 'sender'
      ? `Required reply to message #${request.request_message_id ?? 'deleted'} from ${request.recipient_name} ` +
        `expired unresolved (${request.expiry_reason}). Delivery acknowledgement did not count as a reply.`
      : `ESCALATION: required reply #${request.request_message_id ?? 'deleted'} from ${request.recipient_name} ` +
        `to ${request.sender_name} expired unresolved (${request.expiry_reason}). Inspect the exact registration; ` +
        'use rescue plus authorized reassignment for owned work.';
    const messageId = enqueueDirectMessage(
      db,
      request.swarm_id,
      'swarm-janitor',
      recipient.name,
      body,
      {
        createdAt,
        kind: 'escalation',
        fromAgentId: null,
        recipientAgentId: recipient.id,
      }
    );
    db.prepare(`
      INSERT INTO required_response_expiry_notifications (
        request_id, recipient_agent_id, audience, message_id, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(request.id, recipient.id, recipient.audience, messageId, createdAt);
  }
}

export function sweepRequiredResponses(
  db: SwarmDb,
  swarmId: string,
  now: number = Date.now()
): RequiredResponseSweepResult {
  if (!Number.isFinite(now) || !Number.isSafeInteger(now)) {
    throw new Error('Required-response sweep time must be a finite integer millisecond timestamp.');
  }
  const pending = db.prepare(`
    SELECT * FROM required_message_responses
    WHERE swarm_id = ? AND status = 'pending'
    ORDER BY id ASC
  `).all(swarmId) as unknown as RequiredMessageResponse[];
  if (pending.length === 0) return { expired: [] };
  withImmediateTransaction(db, () => {
    observeMonotonicClock(db, swarmId, 'required-response', now);
  });

  const at = new Date(now).toISOString();
  const expired: RequiredMessageResponse[] = [];
  for (const row of pending) {
    const transitioned = withImmediateTransaction(db, () => {
      const current = db.prepare(`
        SELECT * FROM required_message_responses
        WHERE swarm_id = ? AND id = ? AND status = 'pending'
      `).get(swarmId, row.id) as RequiredMessageResponse | undefined;
      if (!current) return null;
      const activeRecipient = db.prepare(
        'SELECT id FROM agents WHERE swarm_id = ? AND id = ?'
      ).get(swarmId, current.recipient_agent_id);
      const activeSender = db.prepare(
        'SELECT id FROM agents WHERE swarm_id = ? AND id = ?'
      ).get(swarmId, current.sender_agent_id);
      const reason = !activeSender
        ? 'exact requester registration is inactive'
        : !activeRecipient
          ? 'exact recipient registration is inactive'
          : current.required_by <= at
            ? `reply deadline ${current.required_by} passed`
            : null;
      if (!reason) return null;
      const changed = db.prepare(`
        UPDATE required_message_responses
        SET status = 'expired', resolved_at = ?, expiry_reason = ?
        WHERE id = ? AND status = 'pending'
      `).run(at, reason, current.id);
      if (Number(changed.changes) !== 1) return null;
      if (current.request_message_id !== null) {
        db.prepare(`
          DELETE FROM message_outbox
          WHERE message_id = ? AND recipient_agent_id = ? AND state = 'pending'
        `).run(current.request_message_id, current.recipient_agent_id);
      }
      const next = db.prepare('SELECT * FROM required_message_responses WHERE id = ?')
        .get(current.id) as unknown as RequiredMessageResponse;
      enqueueRequiredResponseExpiryNotifications(db, next, at);
      return next;
    }) as RequiredMessageResponse | null;
    if (transitioned) expired.push(transitioned);
  }
  return { expired };
}

export async function broadcastMessage(
  db: SwarmDb,
  swarmId: string,
  fromName: string,
  body: string,
  options?: DeliveryOptions,
  kind?: string | null,
  supersedes?: number
): Promise<{ sent: number; queued: number; failed: number; messageId?: number }> {
  const agents = await listAgents(db, swarmId);
  const recipients = agents.filter(a => a.name.toLowerCase() !== fromName.toLowerCase());

  if (recipients.length === 0) {
    return { sent: 0, queued: 0, failed: 0 };
  }

  const now = new Date().toISOString();
  const formatted = `[SWARM from ${fromName}]: ${body}`;
  const source = getAgent(db, swarmId, fromName);
  const msgId = withImmediateTransaction(db, () => {
    const currentSource = getAgent(db, swarmId, fromName);
    if ((currentSource?.id ?? null) !== (source?.id ?? null)) {
      throw new Error(
        `Sender registration changed for "${fromName}" before the broadcast committed; ` +
        're-resolve identity and retry.'
      );
    }
    if (supersedes !== undefined) {
      const previous = db.prepare(`
        SELECT from_agent_id FROM messages WHERE id = ? AND swarm_id = ?
      `).get(supersedes, swarmId) as { from_agent_id: string | null } | undefined;
      if (!previous || source?.id === undefined || previous.from_agent_id !== source.id) {
        throw new Error(
          `Cannot supersede message #${supersedes}: you can only supersede your own messages, ` +
          'and ownership is the same authenticated sender registration ID.'
        );
      }
    }
    const inserted = db.prepare(`
      INSERT INTO messages (
        swarm_id, from_agent, from_agent_id, to_agent, to_agent_id,
        body, delivered, created_at, kind
      ) VALUES (?, ?, ?, NULL, NULL, ?, 0, ?, ?)
    `).run(swarmId, fromName, source?.id ?? null, body, now, kind ?? null);
    const id = Number(inserted.lastInsertRowid);
    const deliveryInsert = db.prepare(`
      INSERT INTO message_deliveries (
        message_id, swarm_id, recipient, recipient_agent_id, status
      ) VALUES (?, ?, ?, ?, 'pending')
    `);
    const outboxInsert = db.prepare(`
      INSERT INTO message_outbox (
        message_id, swarm_id, recipient_agent_id, state, attempts,
        last_error, created_at, pushed_at
      ) VALUES (?, ?, ?, 'pending', 0, NULL, ?, NULL)
    `);
    for (const recipient of recipients) {
      deliveryInsert.run(id, swarmId, recipient.name, recipient.id);
      outboxInsert.run(id, swarmId, recipient.id, now);
    }
    if (supersedes !== undefined) {
      db.prepare('UPDATE messages SET superseded_by = ? WHERE id = ? AND swarm_id = ?')
        .run(id, supersedes, swarmId);
    }
    return id;
  });

  // Deliver to all recipients in parallel
  const results = await Promise.all(recipients.map(async agent => {
    const result = await deliverToAgent(agent, formatted, options);
    if (result.delivered) {
      db.prepare(`
        UPDATE message_outbox
        SET state = 'pushed', attempts = attempts + 1, last_error = NULL, pushed_at = ?
        WHERE message_id = ? AND recipient_agent_id = ? AND state = 'pending'
      `).run(new Date().toISOString(), msgId, agent.id);
    } else {
      db.prepare(`
        UPDATE message_outbox
        SET attempts = attempts + 1, last_error = ?
        WHERE message_id = ? AND recipient_agent_id = ? AND state = 'pending'
      `).run(result.error ?? 'push delivery failed', msgId, agent.id);
    }
    return { agent, result };
  }));

  let sent = 0;
  let queued = 0;
  let failed = 0;
  for (const { agent, result } of results) {
    if (result.delivered) {
      sent++;
    } else {
      // The broadcast row is in the DB and is inbox-readable (to_agent IS NULL),
      // so the recipient still receives it on their next inbox poll even though
      // the immediate push failed — a2a agents included, since they can read
      // their inbox remotely via SWARM_AGENT_NAME. Mirrors sendMessage.
      queued++;
    }
  }

  if (sent + queued > 0) {
    db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?').run(msgId);
  }

  return { sent, queued, failed, messageId: msgId };
}

function getCursor(db: SwarmDb, swarmId: string, agentName: string): number {
  const cursor = db.prepare(`
    SELECT last_read_id FROM inbox_cursors
    WHERE swarm_id = ? AND agent_name = ? COLLATE NOCASE
  `).get(swarmId, agentName) as { last_read_id: number } | undefined;
  return cursor?.last_read_id ?? 0;
}

function ensureDeliveryRows(
  db: SwarmDb,
  swarmId: string,
  agentName: string,
  agentId: string | null,
  messageIds: number[]
): void {
  if (messageIds.length === 0) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO message_deliveries (
      message_id, swarm_id, recipient, recipient_agent_id
    ) VALUES (?, ?, ?, ?)
  `);
  withImmediateTransaction(db, () => {
    for (const id of messageIds) insert.run(id, swarmId, agentName, agentId);
  });
}

export function acknowledgeMessages(
  db: SwarmDb,
  swarmId: string,
  agentName: string,
  messageIds: number[],
  now: number = Date.now()
): number[] {
  const ids = [...new Set(messageIds)];
  if (ids.length === 0) return [];
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Message IDs must be positive integers.');
  }
  const visible = db.prepare(`
    SELECT m.id FROM messages m
    LEFT JOIN message_deliveries d
      ON d.message_id = m.id
      AND d.swarm_id = m.swarm_id
      AND d.recipient = ? COLLATE NOCASE
    WHERE m.id = ? AND m.swarm_id = ?
      AND (m.to_agent = ? COLLATE NOCASE OR m.to_agent IS NULL)
      AND (m.to_agent_id IS NULL OR m.to_agent_id = ?)
      AND (d.message_id IS NULL OR d.recipient_agent_id IS NULL OR d.recipient_agent_id = ?)
      AND m.from_agent != ? COLLATE NOCASE
  `);
  const ackedAt = new Date(now).toISOString();
  const upsert = db.prepare(`
    INSERT INTO message_deliveries (
      message_id, swarm_id, recipient, recipient_agent_id, status, acked_at
    ) VALUES (?, ?, ?, ?, 'acked', ?)
    ON CONFLICT(message_id, recipient) DO UPDATE SET
      status = 'acked',
      recipient_agent_id = COALESCE(message_deliveries.recipient_agent_id, excluded.recipient_agent_id),
      acked_at = COALESCE(message_deliveries.acked_at, excluded.acked_at)
  `);

  withImmediateTransaction(db, () => {
    const agentId = getAgent(db, swarmId, agentName)?.id ?? null;
    for (const id of ids) {
      if (!visible.get(agentName, id, swarmId, agentName, agentId, agentId, agentName)) {
        throw new Error(`Message #${id} was not found in this swarm or is not addressed to you.`);
      }
    }
    for (const id of ids) {
      upsert.run(id, swarmId, agentName, agentId, ackedAt);
      if (agentId) {
        db.prepare(`
          DELETE FROM message_outbox
          WHERE message_id = ? AND recipient_agent_id = ? AND state = 'pending'
        `).run(id, agentId);
      }
    }
    // Do not advance the legacy high-water cursor. Acknowledging message #N
    // must never conceal earlier unacknowledged messages that lack delivery
    // rows (for example when the recipient acks an exact ID before inbox).
    // Exact per-message delivery state is authoritative for new builds.
  });
  return ids;
}

export function getInbox(
  db: SwarmDb,
  swarmId: string,
  agentName: string,
  peek: boolean = false,
  kind?: string
): Message[] {
  const lastReadId = getCursor(db, swarmId, agentName);
  const agentId = getAgent(db, swarmId, agentName)?.id ?? null;

  // A delivery row is authoritative once one exists. The legacy cursor remains the
  // fallback for messages written/read by older builds and for the first-join fence.
  const params: Array<string | number | null> = [
    agentName,
    agentId,
    swarmId,
    agentName,
    agentId,
    agentName,
    agentName,
    lastReadId,
  ];
  if (kind) params.push(kind);
  const messages = db.prepare(`
    SELECT m.* FROM messages m
    LEFT JOIN message_deliveries d
      ON d.message_id = m.id
      AND d.swarm_id = m.swarm_id
      AND d.recipient = ? COLLATE NOCASE
      AND (d.recipient_agent_id IS NULL OR d.recipient_agent_id = ?)
    LEFT JOIN required_message_responses required
      ON required.request_message_id = m.id
      AND required.swarm_id = m.swarm_id
    WHERE m.swarm_id = ?
      AND (m.to_agent = ? COLLATE NOCASE OR m.to_agent IS NULL)
      AND (m.to_agent_id IS NULL OR m.to_agent_id = ?)
      AND m.from_agent != ? COLLATE NOCASE
      AND m.superseded_by IS NULL
      AND (required.id IS NULL OR required.status != 'expired')
      AND (
        (
          d.message_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM message_deliveries prior_delivery
            WHERE prior_delivery.message_id = m.id
              AND prior_delivery.swarm_id = m.swarm_id
              AND prior_delivery.recipient = ? COLLATE NOCASE
          )
          AND m.id > ?
        )
        OR d.status != 'acked'
      )
      ${kind ? 'AND m.kind = ?' : ''}
    ORDER BY m.id ASC
  `).all(...params) as unknown as Message[];

  ensureDeliveryRows(db, swarmId, agentName, agentId, messages.map(message => message.id));

  // Display is never acknowledgement. Messages remain pending until the
  // recipient explicitly acknowledges one exact ID with `swarm ack <id>`.
  // The `peek` parameter remains for source compatibility but cannot weaken
  // this invariant.
  return messages;
}

export async function waitForInbox(
  db: SwarmDb,
  swarmId: string,
  agentName: string,
  options: InboxWaitOptions
): Promise<InboxWaitResult> {
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 0) {
    throw new Error('--wait seconds must be a non-negative number.');
  }
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('Inbox poll interval must be a positive number of milliseconds.');
  }
  const deadline = now() + options.timeoutSeconds * 1_000;

  while (true) {
    const messages = getInbox(
      db,
      swarmId,
      agentName,
      options.peek === true || options.kind !== undefined,
      options.kind
    );
    if (messages.length > 0) return { messages, timedOut: false };
    const remaining = deadline - now();
    if (remaining <= 0) return { messages: [], timedOut: true };
    await pause(Math.min(pollIntervalMs, remaining));
  }
}

export function recordHookInjections(
  db: SwarmDb,
  swarmId: string,
  agentName: string,
  messages: Message[],
  now: number = Date.now()
): HookInboxEntry[] {
  if (messages.length === 0) return [];
  const injectedAt = new Date(now).toISOString();
  const upsert = db.prepare(`
    INSERT INTO message_deliveries (
      message_id, swarm_id, recipient, recipient_agent_id,
      status, first_injected_at, inject_count
    ) VALUES (?, ?, ?, ?, 'injected', ?, 1)
    ON CONFLICT(message_id, recipient) DO UPDATE SET
      status = CASE WHEN message_deliveries.status = 'acked' THEN 'acked' ELSE 'injected' END,
      recipient_agent_id = COALESCE(message_deliveries.recipient_agent_id, excluded.recipient_agent_id),
      first_injected_at = COALESCE(message_deliveries.first_injected_at, excluded.first_injected_at),
      inject_count = CASE
        WHEN message_deliveries.status = 'acked' THEN message_deliveries.inject_count
        ELSE message_deliveries.inject_count + 1
      END
    WHERE message_deliveries.recipient_agent_id IS NULL
       OR message_deliveries.recipient_agent_id = excluded.recipient_agent_id
  `);
  const select = db.prepare(`
    SELECT * FROM message_deliveries
    WHERE message_id = ? AND swarm_id = ? AND recipient = ? COLLATE NOCASE
      AND (recipient_agent_id IS NULL OR recipient_agent_id = ?)
  `);

  return withImmediateTransaction(db, () => {
    const agentId = getAgent(db, swarmId, agentName)?.id ?? null;
    const entries: HookInboxEntry[] = [];
    for (const message of messages) {
      upsert.run(message.id, swarmId, agentName, agentId, injectedAt);
      const delivery = select.get(
        message.id,
        swarmId,
        agentName,
        agentId
      ) as unknown as MessageDelivery | undefined;
      if (!delivery) continue;
      if (delivery.status === 'acked') continue;
      const firstInjectedAt = new Date(delivery.first_injected_at ?? injectedAt).getTime();
      const elapsedMs = Math.max(0, now - firstInjectedAt);
      entries.push({
        message,
        delivery,
        collapsed:
          delivery.inject_count >= HOOK_INJECT_COLLAPSE_COUNT ||
          elapsedMs > HOOK_INJECT_BACKOFF_MS,
        unackedMinutes: Math.floor(elapsedMs / 60_000),
      });
    }
    return entries;
  });
}

/**
 * Replay the last N messages addressed to this agent REGARDLESS of the read
 * cursor, never advancing it or creating live delivery state. This is the
 * deliberate archaeology path for acknowledged and pre-join history.
 */
export function getRecentMessages(
  db: SwarmDb,
  swarmId: string,
  agentName: string,
  limit: number = 10,
  kind?: string
): Message[] {
  const agentId = getAgent(db, swarmId, agentName)?.id ?? null;
  const params: Array<string | number | null> = [swarmId, agentName, agentId, agentName];
  if (kind) params.push(kind);
  params.push(limit);
  const messages = db.prepare(`
    SELECT * FROM messages
    WHERE swarm_id = ?
      AND (to_agent = ? COLLATE NOCASE OR to_agent IS NULL)
      AND (to_agent_id IS NULL OR to_agent_id = ?)
      AND from_agent != ? COLLATE NOCASE
      ${kind ? 'AND kind = ?' : ''}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params) as unknown as Message[];
  return messages.reverse();
}

/**
 * How many messages addressed to this agent (directly or via broadcast) exist in the
 * last `hours` hours, regardless of the read cursor. Powers the zero-unread inbox hint:
 * "no new messages" plus recent traffic means delivery state or the legacy cursor has
 * already consumed them, and `--recent` is the recovery path.
 */
export function countRecentMessages(
  db: SwarmDb,
  swarmId: string,
  agentName: string,
  hours: number = 24
): number {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  const agentId = getAgent(db, swarmId, agentName)?.id ?? null;
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE swarm_id = ?
      AND (to_agent = ? COLLATE NOCASE OR to_agent IS NULL)
      AND (to_agent_id IS NULL OR to_agent_id = ?)
      AND from_agent != ? COLLATE NOCASE
      AND created_at > ?
  `).get(swarmId, agentName, agentId, agentName, cutoff) as { n: number };
  return row.n;
}
