import type Database from 'better-sqlite3';
import { deliverToAgent } from './transport-router.js';
import { getAgent, listAgents } from './registry.js';

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
  body: string
): Promise<{ delivered: boolean; message: string }> {
  const target = getAgent(db, swarmId, toName);
  if (!target) {
    return { delivered: false, message: `Agent "${toName}" not found. Run 'swarm members' to see active agents.` };
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

  const deliveryResult = await deliverToAgent(target, formatted);
  if (deliveryResult.delivered) {
    db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?').run(msgId);
    return { delivered: true, message: `Message sent to ${toName}` };
  } else {
    // A2A agents can't read the local swarm inbox, so don't claim it was saved there
    if (target.agent_type === 'a2a') {
      return { delivered: false, message: `Failed to deliver to ${toName}: ${deliveryResult.error || 'endpoint unreachable'}` };
    }
    // For Cmux and headless agents: push failed but message is in the DB.
    // The recipient will pick it up via `swarm inbox`.
    return { delivered: true, message: `Message sent to ${toName} (queued for inbox)` };
  }
}

export async function broadcastMessage(
  db: Database.Database,
  swarmId: string,
  fromName: string,
  body: string
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
    recipients.map(async agent => ({ agent, result: await deliverToAgent(agent, formatted) }))
  );

  let sent = 0;
  let queued = 0;
  let failed = 0;
  for (const { agent, result } of results) {
    if (result.delivered) {
      sent++;
    } else if (agent.agent_type === 'a2a') {
      // A2A agents can't read the local inbox, so a failed push is a real miss.
      failed++;
    } else {
      // Cmux/headless: the broadcast row is in the DB and is inbox-readable
      // (to_agent IS NULL), so the recipient still receives it on their next
      // inbox poll even though the immediate push nudge failed. Mirrors sendMessage.
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
