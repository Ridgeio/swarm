import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SWARM_DIR = path.join(os.homedir(), '.swarm');
const DB_PATH = path.join(SWARM_DIR, 'swarm.db');

let db: Database.Database | null = null;

function ensureDir(): void {
  if (!fs.existsSync(SWARM_DIR)) {
    fs.mkdirSync(SWARM_DIR, { recursive: true });
  }
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      surface_id TEXT NOT NULL,
      workspace_id TEXT,
      ppid INTEGER NOT NULL,
      joined_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT,
      body TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbox_cursors (
      agent_name TEXT PRIMARY KEY,
      last_read_id INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export function getDb(): Database.Database {
  if (db) return db;
  ensureDir();
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

// For testing: allow custom DB path
export function getDbAt(dbPath: string): Database.Database {
  const testDb = new Database(dbPath);
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('busy_timeout = 5000');
  migrate(testDb);
  return testDb;
}
