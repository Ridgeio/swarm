#!/usr/bin/env node
/**
 * Swarm CLI entry. On better-sqlite3 NODE_MODULE_VERSION mismatch, download the
 * matching official prebuild for this process's ABI (not `npm rebuild`, which
 * thrash-fetches the wrong ABI and breaks every agent mid-session).
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function isNativeMismatch(err) {
  const msg = String(err?.message ?? err ?? '');
  return (
    msg.includes('NODE_MODULE_VERSION') ||
    msg.includes('Could not locate the bindings file') ||
    (msg.includes('better_sqlite3') && msg.includes('was compiled against'))
  );
}

function prebuildTriple() {
  const platform = process.platform; // darwin | linux | win32
  const arch = process.arch; // arm64 | x64 | ...
  if (platform === 'win32') return `win32-${arch}-msvc`;
  return `${platform}-${arch}`;
}

function repairBetterSqlite3() {
  if (process.env.SWARM_NATIVE_REPAIRED === '1') {
    throw new Error(
      'better-sqlite3 still fails after prebuild repair. ' +
        'Pin a Node matching ~/.swarm/node-path or set SWARM_NODE, then retry.'
    );
  }

  const pkgPath = path.join(ROOT, 'node_modules', 'better-sqlite3', 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`better-sqlite3 not installed at ${pkgPath}`);
  }
  const version = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  const abi = process.versions.modules;
  const triple = prebuildTriple();
  const url =
    `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/` +
    `better-sqlite3-v${version}-node-v${abi}-${triple}.tar.gz`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bsq-'));
  const tgz = path.join(tmpDir, 'bsq.tgz');
  process.stderr.write(
    `swarm: better-sqlite3 ABI mismatch — downloading prebuild for node-v${abi} ${triple}...\n`
  );

  try {
    execFileSync('curl', ['-fsSL', url, '-o', tgz], { stdio: 'inherit' });
  } catch {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(
      `Failed to download better-sqlite3 prebuild from ${url}. ` +
        `Check network, or see TROUBLESHOOTING.md.`
    );
  }

  const pkgRoot = path.join(ROOT, 'node_modules', 'better-sqlite3');
  const buildDir = path.join(pkgRoot, 'build');
  try {
    fs.rmSync(buildDir, { recursive: true, force: true });
    execFileSync('tar', ['-xzf', tgz, '-C', pkgRoot], { stdio: 'inherit' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Re-exec under the same node so the new .node loads cleanly.
  const env = { ...process.env, SWARM_NATIVE_REPAIRED: '1' };
  try {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env,
    });
    process.exit(0);
  } catch (err) {
    process.exit(err?.status ?? 1);
  }
}

try {
  // Probe the native module before loading the full CLI so we can repair once.
  require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
  await import('../dist/index.js');
} catch (err) {
  if (isNativeMismatch(err)) {
    try {
      repairBetterSqlite3();
    } catch (repairErr) {
      console.error(`swarm: ${repairErr.message}`);
      process.exit(1);
    }
  } else {
    throw err;
  }
}
