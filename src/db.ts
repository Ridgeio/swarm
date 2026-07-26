import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SWARM_DIR = path.join(os.homedir(), '.swarm');
const DB_PATH = path.join(SWARM_DIR, 'swarm.db');
export const DEFAULT_SWARM_ID = 'default';
export const DEFAULT_SWARM_NAME = 'default';
export type SwarmDb = DatabaseSync;

let db: SwarmDb | null = null;

function ensureDir(): void {
  if (!fs.existsSync(SWARM_DIR)) {
    fs.mkdirSync(SWARM_DIR, { recursive: true });
  }
}

function tableColumns(db: SwarmDb, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map(row => row.name));
}

function tableExists(db: SwarmDb, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return !!row;
}

function ensureLegacyAgentColumns(db: SwarmDb): void {
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
  if (!columns.has('session_token')) {
    db.exec('ALTER TABLE agents ADD COLUMN session_token TEXT');
  }
  if (!columns.has('worker_version')) {
    db.exec('ALTER TABLE agents ADD COLUMN worker_version TEXT');
  }
}

function createSwarmsTable(db: SwarmDb): void {
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

function createCurrentTables(db: SwarmDb): void {
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
      session_token TEXT,
      worker_version TEXT,
      model_family TEXT,
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
      superseded_by INTEGER,
      FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS inbox_cursors (
      swarm_id TEXT NOT NULL,
      agent_name TEXT NOT NULL COLLATE NOCASE,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE,
      PRIMARY KEY (swarm_id, agent_name)
    );

    CREATE TABLE IF NOT EXISTS message_deliveries (
      message_id INTEGER NOT NULL,
      swarm_id TEXT NOT NULL,
      recipient TEXT NOT NULL COLLATE NOCASE,
      status TEXT NOT NULL DEFAULT 'pending',
      first_injected_at TEXT,
      inject_count INTEGER NOT NULL DEFAULT 0,
      acked_at TEXT,
      PRIMARY KEY (message_id, recipient)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT NOT NULL,
      swarm_id TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      owner_agent TEXT COLLATE NOCASE,
      lease_epoch INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      repo_path TEXT,
      branch TEXT,
      worktree_path TEXT,
      transcript_hint TEXT,
      disposition TEXT,
      claim_kind TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (swarm_id, id)
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      swarm_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT,
      data TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      swarm_id TEXT NOT NULL,
      task_id TEXT,
      body TEXT NOT NULL,
      made_by TEXT NOT NULL,
      supersedes INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      swarm_id TEXT NOT NULL,
      op TEXT NOT NULL,
      resource TEXT NOT NULL,
      granted_to TEXT COLLATE NOCASE,
      granted_by TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS janitor_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_tick_at TEXT NOT NULL,
      last_duration_ms INTEGER NOT NULL,
      counters TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS janitor_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      detail TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'hold'
    );

    CREATE TABLE IF NOT EXISTS janitor_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick_at TEXT NOT NULL,
      counters TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS janitor_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function migrateAgents(db: SwarmDb): void {
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
  withImmediateTransaction(db, () => {
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
        session_token TEXT,
        worker_version TEXT,
        FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE,
        UNIQUE (swarm_id, name)
      );

      -- The new schema makes name COLLATE NOCASE UNIQUE(swarm_id,name); the legacy schema
      -- used a case-sensitive UNIQUE, so a legacy DB could hold 'Bob' and 'bob'. Keep one
      -- row per case-insensitive name (the most recently active) so the INSERT can't trip
      -- the NOCASE unique constraint and leave the migration permanently failing.
      INSERT INTO agents_new (
        id, swarm_id, name, description, surface_id, workspace_id, ppid,
        joined_at, last_heartbeat, agent_type, endpoint_url, host_agent, session_token,
        worker_version
      )
      SELECT
        id, '${DEFAULT_SWARM_ID}', name, description, surface_id, workspace_id, ppid,
        joined_at, last_heartbeat, agent_type, endpoint_url, host_agent, session_token,
        worker_version
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
  });
}

function migrateMessages(db: SwarmDb): void {
  if (!tableExists(db, 'messages')) {
    createCurrentTables(db);
    return;
  }

  const columns = tableColumns(db, 'messages');
  if (columns.has('swarm_id')) return;

  withImmediateTransaction(db, () => {
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
  });
}

function migrateInboxCursors(db: SwarmDb): void {
  if (!tableExists(db, 'inbox_cursors')) {
    createCurrentTables(db);
    return;
  }

  const columns = tableColumns(db, 'inbox_cursors');
  if (columns.has('swarm_id')) return;

  withImmediateTransaction(db, () => {
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
  });
}

// messages.kind — nullable classification tag (status | digest | merge-req | ...).
// Additive nullable column, so the lighter guard pattern applies (no table rebuild):
// inspect PRAGMA table_info and ALTER TABLE ADD COLUMN only when absent. Idempotent,
// and tolerant in both directions across the A2A bridge: older builds name their
// INSERT columns explicitly (the new column defaults to NULL) and ignore the extra
// field on SELECT *, while this build sees NULL kinds from rows older builds wrote.
// Runs AFTER migrateMessages so a legacy table rebuilt there also gains the column.
function ensureMessageKindColumn(db: SwarmDb): void {
  if (!tableExists(db, 'messages')) return;
  const columns = tableColumns(db, 'messages');
  if (!columns.has('kind')) {
    db.exec('ALTER TABLE messages ADD COLUMN kind TEXT');
  }
}

function ensureMessageSupersededByColumn(db: SwarmDb): void {
  if (!tableExists(db, 'messages')) return;
  const columns = tableColumns(db, 'messages');
  if (!columns.has('superseded_by')) {
    db.exec('ALTER TABLE messages ADD COLUMN superseded_by INTEGER');
  }
}

// tasks.claim_kind — nullable so databases written by earlier builds retain an
// honest legacy marker. Callers interpret NULL as code-merged; new task starts
// always write an explicit claim kind.
function ensureTaskClaimKindColumn(db: SwarmDb): void {
  if (!tableExists(db, 'tasks')) return;
  const columns = tableColumns(db, 'tasks');
  if (!columns.has('claim_kind')) {
    db.exec('ALTER TABLE tasks ADD COLUMN claim_kind TEXT');
  }
}

function ensureAgentSessionTokenColumn(db: SwarmDb): void {
  if (!tableExists(db, 'agents')) return;
  const columns = tableColumns(db, 'agents');
  if (!columns.has('session_token')) {
    db.exec('ALTER TABLE agents ADD COLUMN session_token TEXT');
  }
}

function ensureAgentWorkerVersionColumn(db: SwarmDb): void {
  if (!tableExists(db, 'agents')) return;
  const columns = tableColumns(db, 'agents');
  if (!columns.has('worker_version')) {
    db.exec('ALTER TABLE agents ADD COLUMN worker_version TEXT');
  }
}

/**
 * Declared model family. Local agents derive it from their harness, but an A2A agent
 * has no harness we can inspect, so it must be able to SAY what it is — otherwise
 * cross-family review routing has to guess, and a guess is what it must never do.
 */
function ensureAgentModelFamilyColumn(db: SwarmDb): void {
  if (!tableExists(db, 'agents')) return;
  const columns = tableColumns(db, 'agents');
  if (!columns.has('model_family')) {
    db.exec('ALTER TABLE agents ADD COLUMN model_family TEXT');
  }
}

function migrate(db: SwarmDb): void {
  createSwarmsTable(db);
  createCurrentTables(db);
  migrateAgents(db);
  migrateMessages(db);
  migrateInboxCursors(db);
  ensureMessageKindColumn(db);
  ensureMessageSupersededByColumn(db);
  ensureTaskClaimKindColumn(db);
  ensureAgentSessionTokenColumn(db);
  ensureAgentWorkerVersionColumn(db);
  ensureAgentModelFamilyColumn(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agents_swarm_joined ON agents(swarm_id, joined_at);
    CREATE INDEX IF NOT EXISTS idx_agents_surface ON agents(surface_id);
    CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(swarm_id, to_agent, id);
    CREATE INDEX IF NOT EXISTS idx_messages_broadcast ON messages(swarm_id, id);
    CREATE INDEX IF NOT EXISTS idx_message_deliveries_recipient ON message_deliveries(swarm_id, recipient, status, message_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner_state ON tasks(swarm_id, owner_agent, state);
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(swarm_id, task_id, id);
    CREATE INDEX IF NOT EXISTS idx_decisions_swarm_task ON decisions(swarm_id, task_id, id);
    CREATE INDEX IF NOT EXISTS idx_grants_swarm_live ON grants(swarm_id, op, revoked_at, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_janitor_findings_kind_path ON janitor_findings(kind, path);
    CREATE INDEX IF NOT EXISTS idx_janitor_findings_state ON janitor_findings(state, kind);
    CREATE INDEX IF NOT EXISTS idx_janitor_snapshots_tick ON janitor_snapshots(tick_at);
  `);
}

export function withImmediateTransaction<T>(database: SwarmDb, fn: () => T): T {
  if (database.isTransaction) {
    throw new Error('Nested SQLite transactions are not supported.');
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the operation error; it is the actionable failure for callers.
      }
    }
    throw error;
  }
}

export function getDb(): SwarmDb {
  if (db) return db;
  ensureDir();
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

// For testing: allow custom DB path
export function getDbAt(dbPath: string): SwarmDb {
  const testDb = new DatabaseSync(dbPath);
  testDb.exec('PRAGMA journal_mode = WAL');
  testDb.exec('PRAGMA busy_timeout = 5000');
  testDb.exec('PRAGMA foreign_keys = ON');
  migrate(testDb);
  return testDb;
}

/**
 * Open the fleet database without creating it, migrating it, or changing its
 * journal settings. Read-only commands such as `swarm board` use this path so
 * observing the fleet cannot itself become fleet activity.
 */
export function getDbReadOnly(dbPath: string = DB_PATH): SwarmDb | null {
  if (!fs.existsSync(dbPath)) return null;
  const readDb = new DatabaseSync(dbPath, { readOnly: true });
  readDb.exec('PRAGMA busy_timeout = 5000');
  readDb.exec('PRAGMA query_only = ON');
  return readDb;
}
