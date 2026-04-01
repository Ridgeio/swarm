import type Database from 'better-sqlite3';
import { sendToSurface, SurfaceGoneError } from './transport.js';
import { getAgent, listAgents } from './registry.js';

export interface Message {
  id: number;
  from_agent: string;
  to_agent: string | null;
  body: string;
  delivered: number;
  created_at: string;
}

export function sendMessage(
  db: Database.Database,
  fromName: string,
  toName: string,
  body: string
): { delivered: boolean; message: string } {
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

  try {
    sendToSurface(target.surface_id, formatted);
    db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?').run(msgId);
    return { delivered: true, message: `Message sent to ${toName}` };
  } catch (err) {
    if (err instanceof SurfaceGoneError) {
      return { delivered: false, message: `${toName}'s terminal is no longer active. Message saved to inbox.` };
    }
    throw err;
  }
}

export function broadcastMessage(
  db: Database.Database,
  fromName: string,
  body: string
): { sent: number; failed: number } {
  const agents = listAgents(db);
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

  // Deliver outside the DB transaction
  let sent = 0;
  let failed = 0;
  for (const agent of recipients) {
    try {
      sendToSurface(agent.surface_id, formatted);
      sent++;
    } catch {
      failed++;
    }
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
