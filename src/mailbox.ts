import { withImmediateTransaction, type SwarmDb } from './db.js';
import { deliverToAgent } from './transport-router.js';
import { getAgent, listAgents } from './registry.js';
import type { DeliveryOptions } from './transport-interface.js';

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
      a.id AS active_agent_id
    FROM message_outbox o
    JOIN messages m ON m.id = o.message_id AND m.swarm_id = o.swarm_id
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
      const result = await deliver(target, `[SWARM from ${row.from_agent}]: ${row.body}`);
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
  supersedes?: number
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
    }
  ));
  const deliveryResult = await flushMessageOutbox(
    db,
    [msgId],
    (agent, formatted) => deliverToAgent(agent, formatted, options)
  );
  if (deliveryResult.pushed > 0) {
    return { delivered: true, queued: false, message: `Message sent to ${toName}`, messageId: msgId };
  } else {
    // Push failed but the message is in the DB. Cmux/headless recipients pick it
    // up via `swarm inbox`; a2a recipients get retried by the redeliver worker
    // (their endpoint may be briefly down, e.g. a service restart) and can also
    // read their inbox remotely (getSelf resolves SWARM_AGENT_NAME for a2a).
    // The caller should spawn a redeliver worker so an idle recipient isn't
    // stuck waiting for a turn that never comes (see redeliver.ts).
    return { delivered: true, queued: true, message: `Message sent to ${toName} (queued for retry/inbox)`, messageId: msgId };
  }
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

function advanceCursor(
  db: SwarmDb,
  swarmId: string,
  agentName: string,
  messageIds: number[]
): void {
  if (messageIds.length === 0) return;
  const maxId = Math.max(...messageIds);
  db.prepare(`
    INSERT INTO inbox_cursors (swarm_id, agent_name, last_read_id)
    VALUES (?, ?, ?)
    ON CONFLICT(swarm_id, agent_name) DO UPDATE SET
      last_read_id = MAX(inbox_cursors.last_read_id, excluded.last_read_id)
  `).run(swarmId, agentName, maxId);
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
    for (const id of ids) upsert.run(id, swarmId, agentName, agentId, ackedAt);
    advanceCursor(db, swarmId, agentName, ids);
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
    WHERE m.swarm_id = ?
      AND (m.to_agent = ? COLLATE NOCASE OR m.to_agent IS NULL)
      AND (m.to_agent_id IS NULL OR m.to_agent_id = ?)
      AND m.from_agent != ? COLLATE NOCASE
      AND m.superseded_by IS NULL
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

  // Kind-filtered reads are peek-only by construction. A plain explicit inbox read
  // acknowledges exactly the rows it returned and advances the compatibility cursor.
  if (!peek && !kind && messages.length > 0) {
    acknowledgeMessages(db, swarmId, agentName, messages.map(message => message.id));
  }

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
