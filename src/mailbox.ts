import { withImmediateTransaction, type SwarmDb } from './db.js';
import { deliverToAgent } from './transport-router.js';
import { getAgent, getSwarmById, listAgents, listSurfaceMemberships, type Agent } from './registry.js';
import type { DeliveryOptions } from './transport-interface.js';

/**
 * Pushed text is the recipient's only real-time cue, and `[SWARM from Bob]` alone is
 * ambiguous once a terminal belongs to several swarms — a reply would go to whichever
 * swarm happens to be the default. Name the swarm exactly when that ambiguity exists,
 * so the single-swarm format (and everything parsing it) is untouched.
 */
export function swarmTagFor(db: SwarmDb, target: Agent, swarmId: string): string {
  if (target.agent_type === 'a2a') return '';
  const swarmName = getSwarmById(db, swarmId)?.name;
  if (!swarmName) return '';

  if (target.agent_type === 'cmux') {
    return listSurfaceMemberships(db, target.surface_id).length < 2 ? '' : ` in ${swarmName}`;
  }

  // Headless targets are ALWAYS tagged.
  //
  // There is no reliable way to tell whether a headless recipient holds several
  // memberships — its surface_id is synthetic and per-swarm, and counting same-NAME rows
  // is wrong in both directions because names are unique only within a swarm. But that
  // uncertainty is about WHETHER a tag is needed, never about WHAT it says: the value
  // comes from the message's own swarm, so it cannot name the wrong one. The worst case
  // is a redundant but accurate "in alpha" for a single-swarm agent; the cost of omitting
  // it is a genuinely ambiguous message that the recipient may answer into the wrong
  // swarm. Tag unconditionally until a durable per-session key exists to narrow it.
  return ` in ${swarmName}`;
}

export interface Message {
  id: number;
  swarm_id: string;
  from_agent: string;
  to_agent: string | null;
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

function insertMessage(
  db: SwarmDb,
  swarmId: string,
  fromName: string,
  toName: string | null,
  body: string,
  createdAt: string,
  kind: string | null,
  supersedes?: number
): number {
  return withImmediateTransaction(db, () => {
    if (supersedes !== undefined) {
      const owned = db.prepare(`
        SELECT id FROM messages
        WHERE id = ? AND swarm_id = ? AND from_agent = ? COLLATE NOCASE
      `).get(supersedes, swarmId, fromName);
      if (!owned) {
        throw new Error(`Cannot supersede message #${supersedes}: you can only supersede your own messages in this swarm.`);
      }
    }

    const result = db.prepare(`
      INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at, kind)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(swarmId, fromName, toName, body, createdAt, kind);
    const messageId = Number(result.lastInsertRowid);

    if (supersedes !== undefined) {
      db.prepare('UPDATE messages SET superseded_by = ? WHERE id = ? AND swarm_id = ?')
        .run(messageId, supersedes, swarmId);
    }
    return messageId;
  });
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

  const now = new Date().toISOString();
  const formatted = `[SWARM from ${fromName}${swarmTagFor(db, target, swarmId)}]: ${body}`;

  // Store the canonical registered name (getAgent matches case-insensitively).
  // messages.to_agent is compared case-sensitively in getInbox, so persisting the
  // raw sender-typed casing would make a case-mismatched message invisible to the
  // recipient's inbox while still reporting success.
  const msgId = insertMessage(db, swarmId, fromName, target.name, body, now, kind ?? null, supersedes);

  const deliveryResult = await deliverToAgent(target, formatted, options);
  if (deliveryResult.delivered) {
    db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?').run(msgId);
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
  const recipients = agents.filter(a => a.name !== fromName);

  if (recipients.length === 0) {
    return { sent: 0, queued: 0, failed: 0 };
  }

  const now = new Date().toISOString();

  // Insert message row first (one broadcast row, to_agent = NULL)
  const msgId = insertMessage(db, swarmId, fromName, null, body, now, kind ?? null, supersedes);

  // Deliver to all recipients in parallel. The swarm tag is per-recipient — only the
  // ones sitting in several swarms need disambiguating.
  const results = await Promise.all(
    recipients.map(async agent => ({
      agent,
      result: await deliverToAgent(
        agent,
        `[SWARM from ${fromName}${swarmTagFor(db, agent, swarmId)}]: ${body}`,
        options
      ),
    }))
  );

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
  messageIds: number[]
): void {
  if (messageIds.length === 0) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO message_deliveries (message_id, swarm_id, recipient)
    VALUES (?, ?, ?)
  `);
  withImmediateTransaction(db, () => {
    for (const id of messageIds) insert.run(id, swarmId, agentName);
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
    SELECT id FROM messages
    WHERE id = ? AND swarm_id = ?
      AND (to_agent = ? COLLATE NOCASE OR to_agent IS NULL)
      AND from_agent != ? COLLATE NOCASE
  `);
  const ackedAt = new Date(now).toISOString();
  const upsert = db.prepare(`
    INSERT INTO message_deliveries (
      message_id, swarm_id, recipient, status, acked_at
    ) VALUES (?, ?, ?, 'acked', ?)
    ON CONFLICT(message_id, recipient) DO UPDATE SET
      status = 'acked',
      acked_at = COALESCE(message_deliveries.acked_at, excluded.acked_at)
  `);

  withImmediateTransaction(db, () => {
    for (const id of ids) {
      if (!visible.get(id, swarmId, agentName, agentName)) {
        throw new Error(`Message #${id} was not found in this swarm or is not addressed to you.`);
      }
    }
    for (const id of ids) upsert.run(id, swarmId, agentName, ackedAt);
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

  // A delivery row is authoritative once one exists. The legacy cursor remains the
  // fallback for messages written/read by older builds and for the first-join fence.
  const params: (string | number)[] = [agentName, swarmId, agentName, agentName, lastReadId];
  if (kind) params.push(kind);
  const messages = db.prepare(`
    SELECT m.* FROM messages m
    LEFT JOIN message_deliveries d
      ON d.message_id = m.id
      AND d.swarm_id = m.swarm_id
      AND d.recipient = ? COLLATE NOCASE
    WHERE m.swarm_id = ?
      AND (m.to_agent = ? COLLATE NOCASE OR m.to_agent IS NULL)
      AND m.from_agent != ? COLLATE NOCASE
      AND m.superseded_by IS NULL
      AND ((d.message_id IS NULL AND m.id > ?) OR d.status != 'acked')
      ${kind ? 'AND m.kind = ?' : ''}
    ORDER BY m.id ASC
  `).all(...params) as unknown as Message[];

  ensureDeliveryRows(db, swarmId, agentName, messages.map(message => message.id));

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

export function acknowledgeAllMessages(
  db: SwarmDb,
  swarmId: string,
  agentName: string,
  now: number = Date.now()
): number[] {
  const pending = getInbox(db, swarmId, agentName, true);
  return acknowledgeMessages(db, swarmId, agentName, pending.map(message => message.id), now);
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
      message_id, swarm_id, recipient, status, first_injected_at, inject_count
    ) VALUES (?, ?, ?, 'injected', ?, 1)
    ON CONFLICT(message_id, recipient) DO UPDATE SET
      status = CASE WHEN message_deliveries.status = 'acked' THEN 'acked' ELSE 'injected' END,
      first_injected_at = COALESCE(message_deliveries.first_injected_at, excluded.first_injected_at),
      inject_count = CASE
        WHEN message_deliveries.status = 'acked' THEN message_deliveries.inject_count
        ELSE message_deliveries.inject_count + 1
      END
  `);
  const select = db.prepare(`
    SELECT * FROM message_deliveries
    WHERE message_id = ? AND swarm_id = ? AND recipient = ? COLLATE NOCASE
  `);

  return withImmediateTransaction(db, () => {
    const entries: HookInboxEntry[] = [];
    for (const message of messages) {
      upsert.run(message.id, swarmId, agentName, injectedAt);
      const delivery = select.get(message.id, swarmId, agentName) as unknown as MessageDelivery;
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
  const params: (string | number)[] = [swarmId, agentName, agentName];
  if (kind) params.push(kind);
  params.push(limit);
  const messages = db.prepare(`
    SELECT * FROM messages
    WHERE swarm_id = ?
      AND (to_agent = ? COLLATE NOCASE OR to_agent IS NULL)
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
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE swarm_id = ?
      AND (to_agent = ? COLLATE NOCASE OR to_agent IS NULL)
      AND from_agent != ? COLLATE NOCASE
      AND created_at > ?
  `).get(swarmId, agentName, agentName, cutoff) as { n: number };
  return row.n;
}
