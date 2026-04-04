import type Database from 'better-sqlite3';
import { deliverToAgent } from './transport-router.js';
import { getAgent, listAgents } from './registry.js';

export interface Message {
  id: number;
  from_agent: string;
  to_agent: string | null;
  body: string;
  delivered: number;
  created_at: string;
}

export async function sendMessage(
  db: Database.Database,
  fromName: string,
  toName: string,
  body: string
): Promise<{ delivered: boolean; message: string }> {
  const target = getAgent(db, toName);
  if (!target) {
    return { delivered: false, message: `Agent "${toName}" not found. Run 'swarm members' to see active agents.` };
  }

  const now = new Date().toISOString();
  const formatted = `[SWARM from ${fromName}]: ${body}`;

  const result = db.prepare(
    'INSERT INTO messages (from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, 0, ?)'
  ).run(fromName, toName, body, now);

  const msgId = result.lastInsertRowid;

  const deliveryResult = await deliverToAgent(target, formatted);
  if (deliveryResult.delivered) {
    db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?').run(msgId);
    return { delivered: true, message: `Message sent to ${toName}` };
  } else {
    // A2A agents can't read the local swarm inbox, so don't claim it was saved there
    const fallback = target.agent_type === 'a2a'
      ? `Failed to deliver to ${toName}: ${deliveryResult.error || 'endpoint unreachable'}`
      : deliveryResult.error || `${toName}'s terminal is not active. Message saved to inbox.`;
    return { delivered: false, message: fallback };
  }
}

export async function broadcastMessage(
  db: Database.Database,
  fromName: string,
  body: string
): Promise<{ sent: number; failed: number }> {
  const agents = await listAgents(db);
  const recipients = agents.filter(a => a.name !== fromName);

  if (recipients.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const now = new Date().toISOString();
  const formatted = `[SWARM from ${fromName}]: ${body}`;

  // Insert message row first (one broadcast row, to_agent = NULL)
  const result = db.prepare(
    'INSERT INTO messages (from_agent, to_agent, body, delivered, created_at) VALUES (?, NULL, ?, 0, ?)'
  ).run(fromName, body, now);

  const msgId = result.lastInsertRowid;

  // Deliver to all recipients in parallel
  const results = await Promise.all(
    recipients.map(agent => deliverToAgent(agent, formatted))
  );

  let sent = 0;
  let failed = 0;
  for (const r of results) {
    if (r.delivered) sent++;
    else failed++;
  }

  if (sent > 0) {
    db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?').run(msgId);
  }

  return { sent, failed };
}

export function getInbox(
  db: Database.Database,
  agentName: string,
  peek: boolean = false
): Message[] {
  // Get cursor
  const cursor = db.prepare('SELECT last_read_id FROM inbox_cursors WHERE agent_name = ?')
    .get(agentName) as { last_read_id: number } | undefined;
  const lastReadId = cursor?.last_read_id ?? 0;

  // Fetch messages: direct messages to me + broadcasts, after cursor, not from me
  const messages = db.prepare(`
    SELECT * FROM messages
    WHERE (to_agent = ? OR to_agent IS NULL)
      AND from_agent != ?
      AND id > ?
    ORDER BY created_at ASC
  `).all(agentName, agentName, lastReadId) as Message[];

  if (!peek && messages.length > 0) {
    const maxId = messages[messages.length - 1].id;
    db.prepare(
      'INSERT OR REPLACE INTO inbox_cursors (agent_name, last_read_id) VALUES (?, ?)'
    ).run(agentName, maxId);
  }

  return messages;
}
