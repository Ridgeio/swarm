import type Database from 'better-sqlite3';
import { deliverToAgent } from './transport-router.js';
import { getAgent, listAgents } from './registry.js';
import type { DeliveryOptions } from './transport-interface.js';

export interface Message {
  id: number;
  swarm_id: string;
  from_agent: string;
  to_agent: string | null;
  body: string;
  delivered: number;
  created_at: string;
}

export async function sendMessage(
  db: Database.Database,
  swarmId: string,
  fromName: string,
  toName: string,
  body: string,
  options?: DeliveryOptions
): Promise<{ delivered: boolean; queued: boolean; message: string }> {
  const target = getAgent(db, swarmId, toName);
  if (!target) {
    return { delivered: false, queued: false, message: `Agent "${toName}" not found. Run 'swarm members' to see active agents.` };
  }

  const now = new Date().toISOString();
  const formatted = `[SWARM from ${fromName}]: ${body}`;

  // Store the canonical registered name (getAgent matches case-insensitively).
  // messages.to_agent is compared case-sensitively in getInbox, so persisting the
  // raw sender-typed casing would make a case-mismatched message invisible to the
  // recipient's inbox while still reporting success.
  const result = db.prepare(
    'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, ?, 0, ?)'
  ).run(swarmId, fromName, target.name, body, now);

  const msgId = result.lastInsertRowid;

  const deliveryResult = await deliverToAgent(target, formatted, options);
  if (deliveryResult.delivered) {
    db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?').run(msgId);
    return { delivered: true, queued: false, message: `Message sent to ${toName}` };
  } else {
    // Push failed but the message is in the DB. Cmux/headless recipients pick it
    // up via `swarm inbox`; a2a recipients get retried by the redeliver worker
    // (their endpoint may be briefly down, e.g. a service restart) and can also
    // read their inbox remotely (getSelf resolves SWARM_AGENT_NAME for a2a).
    // The caller should spawn a redeliver worker so an idle recipient isn't
    // stuck waiting for a turn that never comes (see redeliver.ts).
    return { delivered: true, queued: true, message: `Message sent to ${toName} (queued for retry/inbox)` };
  }
}

export async function broadcastMessage(
  db: Database.Database,
  swarmId: string,
  fromName: string,
  body: string,
  options?: DeliveryOptions
): Promise<{ sent: number; queued: number; failed: number }> {
  const agents = await listAgents(db, swarmId);
  const recipients = agents.filter(a => a.name !== fromName);

  if (recipients.length === 0) {
    return { sent: 0, queued: 0, failed: 0 };
  }

  const now = new Date().toISOString();
  const formatted = `[SWARM from ${fromName}]: ${body}`;

  // Insert message row first (one broadcast row, to_agent = NULL)
  const result = db.prepare(
    'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, NULL, ?, 0, ?)'
  ).run(swarmId, fromName, body, now);

  const msgId = result.lastInsertRowid;

  // Deliver to all recipients in parallel
  const results = await Promise.all(
    recipients.map(async agent => ({ agent, result: await deliverToAgent(agent, formatted, options) }))
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

  return { sent, queued, failed };
}

export function getInbox(
  db: Database.Database,
  swarmId: string,
  agentName: string,
  peek: boolean = false
): Message[] {
  // Get cursor
  const cursor = db.prepare('SELECT last_read_id FROM inbox_cursors WHERE swarm_id = ? AND agent_name = ?')
    .get(swarmId, agentName) as { last_read_id: number } | undefined;
  const lastReadId = cursor?.last_read_id ?? 0;

  // Fetch messages: direct messages to me + broadcasts, after cursor, not from me
  // Match names case-insensitively (agents register COLLATE NOCASE) so a message addressed
  // with non-canonical casing still lands, and an agent never sees its own messages.
  const messages = db.prepare(`
    SELECT * FROM messages
    WHERE swarm_id = ?
      AND (to_agent = ? COLLATE NOCASE OR to_agent IS NULL)
      AND from_agent != ? COLLATE NOCASE
      AND id > ?
    ORDER BY created_at ASC
  `).all(swarmId, agentName, agentName, lastReadId) as Message[];

  if (!peek && messages.length > 0) {
    const maxId = messages[messages.length - 1].id;
    db.prepare(
      'INSERT OR REPLACE INTO inbox_cursors (swarm_id, agent_name, last_read_id) VALUES (?, ?, ?)'
    ).run(swarmId, agentName, maxId);
  }

  return messages;
}
