import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getDbAt, withImmediateTransaction } from '../src/db.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const FORBIDDEN_PACKAGE = 'better-sqlite3';
const PACKAGE_SPECIFIER = `['"]${FORBIDDEN_PACKAGE}(?:/[^'"]*)?['"]`;
const IMPORT_PATTERNS = [
  new RegExp(`\\bfrom\\s*${PACKAGE_SPECIFIER}`),
  new RegExp(`\\bimport\\s*${PACKAGE_SPECIFIER}`),
  new RegExp(`\\bimport\\s*\\(\\s*${PACKAGE_SPECIFIER}`),
  new RegExp(`\\brequire\\s*\\(\\s*${PACKAGE_SPECIFIER}`),
];

function hasForbiddenImport(source: string): boolean {
  return IMPORT_PATTERNS.some(pattern => pattern.test(source));
}

function typescriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

describe('node:sqlite reintroduction ratchet', () => {
  test('package dependencies contain no better-sqlite3 package', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencyNames = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ];
    const violations = dependencyNames.filter(name => name.includes(FORBIDDEN_PACKAGE));
    assert.deepStrictEqual(violations, []);
  });

  test('source imports contain no better-sqlite3 and the scanner catches a reintroduction fixture', () => {
    assert.strictEqual(hasForbiddenImport(`import LegacyDb from '${FORBIDDEN_PACKAGE}';`), true);
    const violations = typescriptFiles(path.join(ROOT, 'src'))
      .filter(filePath => hasForbiddenImport(fs.readFileSync(filePath, 'utf-8')))
      .map(filePath => path.relative(ROOT, filePath));
    assert.deepStrictEqual(violations, []);
  });
});

describe('node:sqlite connection pragmas', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('getDbAt applies WAL, busy_timeout=5000, and foreign_keys=ON', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-node-sqlite-'));
    tempDirs.push(directory);
    const db = getDbAt(path.join(directory, 'swarm.db'));
    try {
      const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      assert.strictEqual(journal.journal_mode.toLowerCase(), 'wal');
      assert.strictEqual(timeout.timeout, 5000);
      assert.strictEqual(foreignKeys.foreign_keys, 1);
    } finally {
      db.close();
    }
  });

  test('immediate transactions roll back and refuse nesting', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-node-sqlite-tx-'));
    tempDirs.push(directory);
    const db = getDbAt(path.join(directory, 'swarm.db'));
    try {
      db.exec('CREATE TABLE transaction_probe (value TEXT NOT NULL)');
      assert.throws(() => withImmediateTransaction(db, () => {
        db.prepare('INSERT INTO transaction_probe (value) VALUES (?)').run('rolled-back');
        throw new Error('transaction probe failure');
      }), /transaction probe failure/);
      const count = db.prepare('SELECT COUNT(*) AS count FROM transaction_probe').get() as { count: number };
      assert.strictEqual(count.count, 0);
      assert.throws(() => withImmediateTransaction(db, () => {
        withImmediateTransaction(db, () => undefined);
      }), /Nested SQLite transactions are not supported/);
      assert.strictEqual(db.isTransaction, false);
    } finally {
      db.close();
    }
  });
});
