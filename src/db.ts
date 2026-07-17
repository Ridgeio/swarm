import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SWARM_DIR = path.join(os.homedir(), '.swarm');
const DB_PATH = path.join(SWARM_DIR, 'swarm.db');
export const DEFAULT_SWARM_ID = 'default';
export const DEFAULT_SWARM_NAME = 'default';

let db: Database.Database | null = null;

function ensureDir(): void {
  if (!fs.existsSync(SWARM_DIR)) {
    fs.mkdirSync(SWARM_DIR, { recursive: true });
  }
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map(row => row.name));
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return !!row;
}

function ensureLegacyAgentColumns(db: Database.Database): void {
  if (!tableExists(db, 'agents')) return;

  const columns = tableColumns(db, 'agents');
  if (!columns.has('agent_type')) {
    db.exec("ALTER TABLE agents ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'cmux'");
  }
  if (!columns.has('endpoint_url')) {
    db.exec("ALTER TABLE agents ADD COLUMN endpoint_url TEXT");
  }
  // Host harness (claude-code | codex | grok). Used for delivery quirks such as
  // Grok needing a second Enter to submit interjected input instead of queueing it.
  if (!columns.has('host_agent')) {
    db.exec('ALTER TABLE agents ADD COLUMN host_agent TEXT');
  }
}

function createSwarmsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      root_path TEXT,
      description TEXT,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL
    );
  `);

  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO swarms (id, name, root_path, description, created_at, last_active_at)
    VALUES (?, ?, NULL, NULL, ?, ?)
  `).run(DEFAULT_SWARM_ID, DEFAULT_SWARM_NAME, now, now);
}

function createCurrentTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      swarm_id TEXT NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      description TEXT,
      surface_id TEXT NOT NULL,
      workspace_id TEXT,
      ppid INTEGER NOT NULL,
      joined_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'cmux',
      endpoint_url TEXT,
      host_agent TEXT,
      FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE,
      UNIQUE (swarm_id, name)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      swarm_id TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      to_agent TEXT,
      body TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      kind TEXT,
      FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS inbox_cursors (
      swarm_id TEXT NOT NULL,
      agent_name TEXT NOT NULL COLLATE NOCASE,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE,
      PRIMARY KEY (swarm_id, agent_name)
    );
  `);
}

function migrateAgents(db: Database.Database): void {
  if (!tableExists(db, 'agents')) {
    createCurrentTables(db);
    return;
  }

  ensureLegacyAgentColumns(db);
  const columns = tableColumns(db, 'agents');
  if (columns.has('swarm_id')) return;

  // Run the rebuild atomically (DDL is transactional in SQLite). The leading
  // DROP ... IF EXISTS clears any half-built table from a prior interrupted/failed
  // run; without atomicity a failed INSERT would leave agents_new committed and
  // permanently wedge every future migrate() with "table agents_new already exists".
  db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS agents_new;

      CREATE TABLE agents_new (
        id TEXT PRIMARY KEY,
        swarm_id TEXT NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE,
        description TEXT,
        surface_id TEXT NOT NULL,
        workspace_id TEXT,
        ppid INTEGER NOT NULL,
        joined_at TEXT NOT NULL,
        last_heartbeat TEXT NOT NULL,
        agent_type TEXT NOT NULL DEFAULT 'cmux',
        endpoint_url TEXT,
        host_agent TEXT,
        FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE,
        UNIQUE (swarm_id, name)
      );

      -- The new schema makes name COLLATE NOCASE UNIQUE(swarm_id,name); the legacy schema
      -- used a case-sensitive UNIQUE, so a legacy DB could hold 'Bob' and 'bob'. Keep one
      -- row per case-insensitive name (the most recently active) so the INSERT can't trip
      -- the NOCASE unique constraint and leave the migration permanently failing.
      INSERT INTO agents_new (
        id, swarm_id, name, description, surface_id, workspace_id, ppid,
        joined_at, last_heartbeat, agent_type, endpoint_url, host_agent
      )
      SELECT
        id, '${DEFAULT_SWARM_ID}', name, description, surface_id, workspace_id, ppid,
        joined_at, last_heartbeat, agent_type, endpoint_url, host_agent
      FROM agents a
      WHERE NOT EXISTS (
        SELECT 1 FROM agents b
        WHERE b.name = a.name COLLATE NOCASE AND b.id <> a.id
          AND (b.last_heartbeat > a.last_heartbeat
               OR (b.last_heartbeat = a.last_heartbeat AND b.id > a.id))
      );

      DROP TABLE agents;
      ALTER TABLE agents_new RENAME TO agents;
    `);
  })();
}

function migrateMessages(db: Database.Database): void {
  if (!tableExists(db, 'messages')) {
    createCurrentTables(db);
    return;
  }

  const columns = tableColumns(db, 'messages');
  if (columns.has('swarm_id')) return;

  db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS messages_new;

      CREATE TABLE messages_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        swarm_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT,
        body TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE
      );

      INSERT INTO messages_new (id, swarm_id, from_agent, to_agent, body, delivered, created_at)
      SELECT id, '${DEFAULT_SWARM_ID}', from_agent, to_agent, body, delivered, created_at
      FROM messages;

      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;
    `);
  })();
}

function migrateInboxCursors(db: Database.Database): void {
  if (!tableExists(db, 'inbox_cursors')) {
    createCurrentTables(db);
    return;
  }

  const columns = tableColumns(db, 'inbox_cursors');
  if (columns.has('swarm_id')) return;

  db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS inbox_cursors_new;

      CREATE TABLE inbox_cursors_new (
        swarm_id TEXT NOT NULL,
        agent_name TEXT NOT NULL COLLATE NOCASE,
        last_read_id INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE,
        PRIMARY KEY (swarm_id, agent_name)
      );

      -- inbox_cursors.agent_name is now COLLATE NOCASE in the PRIMARY KEY; dedupe legacy
      -- case-variant cursors (keep the furthest-read) so the INSERT cannot violate the PK.
      INSERT INTO inbox_cursors_new (swarm_id, agent_name, last_read_id)
      SELECT '${DEFAULT_SWARM_ID}', agent_name, last_read_id
      FROM inbox_cursors a
      WHERE NOT EXISTS (
        SELECT 1 FROM inbox_cursors b
        WHERE b.agent_name = a.agent_name COLLATE NOCASE AND b.agent_name <> a.agent_name
          AND (b.last_read_id > a.last_read_id
               OR (b.last_read_id = a.last_read_id AND b.agent_name > a.agent_name))
      );

      DROP TABLE inbox_cursors;
      ALTER TABLE inbox_cursors_new RENAME TO inbox_cursors;
    `);
  })();
}

// messages.kind — nullable classification tag (status | digest | merge-req | ...).
// Additive nullable column, so the lighter guard pattern applies (no table rebuild):
// inspect PRAGMA table_info and ALTER TABLE ADD COLUMN only when absent. Idempotent,
// and tolerant in both directions across the A2A bridge: older builds name their
// INSERT columns explicitly (the new column defaults to NULL) and ignore the extra
// field on SELECT *, while this build sees NULL kinds from rows older builds wrote.
// Runs AFTER migrateMessages so a legacy table rebuilt there also gains the column.
function ensureMessageKindColumn(db: Database.Database): void {
  if (!tableExists(db, 'messages')) return;
  const columns = tableColumns(db, 'messages');
  if (!columns.has('kind')) {
    db.exec('ALTER TABLE messages ADD COLUMN kind TEXT');
  }
}

function migrate(db: Database.Database): void {
  createSwarmsTable(db);
  createCurrentTables(db);
  migrateAgents(db);
  migrateMessages(db);
  migrateInboxCursors(db);
  ensureMessageKindColumn(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agents_swarm_joined ON agents(swarm_id, joined_at);
    CREATE INDEX IF NOT EXISTS idx_agents_surface ON agents(surface_id);
    CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(swarm_id, to_agent, id);
    CREATE INDEX IF NOT EXISTS idx_messages_broadcast ON messages(swarm_id, id);
  `);
}

export function getDb(): Database.Database {
  if (db) return db;
  ensureDir();
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

// For testing: allow custom DB path
export function getDbAt(dbPath: string): Database.Database {
  const testDb = new Database(dbPath);
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('busy_timeout = 5000');
  testDb.pragma('foreign_keys = ON');
  migrate(testDb);
  return testDb;
}
