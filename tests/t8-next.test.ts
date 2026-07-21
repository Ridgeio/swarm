import { describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const TSX_IMPORT = import.meta.resolve('tsx');

interface CliResult { stdout: string; stderr: string; status: number }

function fakeCmux(root: string): { pathValue: string; log: string } {
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'cmux.log');
  fs.mkdirSync(bin, { recursive: true });
  const cmux = path.join(bin, 'cmux');
  fs.writeFileSync(cmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$SWARM_T8_CMUX_LOG"
case "$1" in
  list-pane-surfaces) printf 'surface:1\\nsurface:2\\n' ;;
  new-split) printf 'OK workspace:9 surface:2\\n' ;;
  new-pane) printf 'OK workspace:9 surface:4\\n' ;;
  new-workspace) printf 'OK workspace:10\\n' ;;
  new-surface) printf 'OK workspace:9 surface:3\\n' ;;
esac
`, { mode: 0o755 });
  fs.chmodSync(cmux, 0o755);
  return { pathValue: `${bin}:${process.env.PATH ?? ''}`, log };
}

function runCli(home: string, args: string[], env: Record<string, string> = {}): CliResult {
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
  try {
    const stdout = execFileSync('node', ['--import', TSX_IMPORT, INDEX, ...args], {
      encoding: 'utf-8',
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        TMPDIR: path.join(home, 'tmp'),
        SWARM_ID: '',
        SWARM_NAME: '',
        SWARM_AGENT_NAME: '',
        SWARM_SESSION_TOKEN: '',
        CMUX_SURFACE_ID: 'surface:caller',
        CMUX_WORKSPACE_ID: 'workspace:caller',
        TERM_PROGRAM: '',
        CODEX_CLI: '',
        CODEX_CI: '',
        CODEX_THREAD_ID: '',
        CODEX_MANAGED_BY_NPM: '',
        CLAUDE_CODE: '',
        GROK_AGENT: '',
        SWARM_TEST_DISABLE_BACKGROUND: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
      status: typeof error.status === 'number' ? error.status : 1,
    };
  }
}

describe('T8 CLI cmux layout discipline', () => {
  test('board --tab splits by default while --own-workspace preserves the named path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t8-board-'));
    const fixture = fakeCmux(root);
    const env = { PATH: fixture.pathValue, SWARM_T8_CMUX_LOG: fixture.log };
    try {
      const split = runCli(path.join(root, 'home-split'), ['board', '--tab', '--watch', '7'], env);
      assert.strictEqual(split.status, 0, split.stderr || split.stdout);
      let log = fs.readFileSync(fixture.log, 'utf-8');
      assert.match(log, /^new-split right$/m);
      assert.match(log, /send --workspace workspace:9 --surface surface:2 .*swarm board$/m);
      assert.match(log, /send --workspace workspace:9 --surface surface:2  --watch 7$/m);

      fs.writeFileSync(fixture.log, '');
      const own = runCli(path.join(root, 'home-own'), ['board', '--tab', '--own-workspace'], env);
      assert.strictEqual(own.status, 0, own.stderr || own.stdout);
      log = fs.readFileSync(fixture.log, 'utf-8');
      assert.match(log, /^new-workspace --name swarm board --cwd .* --command swarm board --watch 5$/m);
      assert.doesNotMatch(log, /^new-split /m);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('spawn --split defaults right and targets the caller workspace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t8-spawn-split-'));
    const fixture = fakeCmux(root);
    try {
      const result = runCli(path.join(root, 'home'), [
        'spawn', '--agent', 'codex', '--terminal', 'cmux', '--split',
      ], { PATH: fixture.pathValue, SWARM_T8_CMUX_LOG: fixture.log });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /right split: workspace:9, surface:2/);
      const log = fs.readFileSync(fixture.log, 'utf-8');
      assert.match(log, /^new-split right --workspace workspace:caller$/m);
      assert.match(log, /send --workspace workspace:9 --surface surface:2/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('spawn default remains a surface in the caller workspace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t8-spawn-tab-'));
    const fixture = fakeCmux(root);
    try {
      const result = runCli(path.join(root, 'home'), [
        'spawn', '--agent', 'codex', '--terminal', 'cmux',
      ], { PATH: fixture.pathValue, SWARM_T8_CMUX_LOG: fixture.log });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /new tab: workspace:9, surface:3/);
      const log = fs.readFileSync(fixture.log, 'utf-8');
      assert.match(log, /^new-surface --workspace workspace:caller$/m);
      assert.doesNotMatch(log, /^new-workspace /m);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('spawn --new-workspace requires and plumbs a context name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t8-spawn-workspace-'));
    const fixture = fakeCmux(root);
    const env = { PATH: fixture.pathValue, SWARM_T8_CMUX_LOG: fixture.log };
    try {
      const refused = runCli(path.join(root, 'home-refused'), [
        'spawn', '--agent', 'codex', '--terminal', 'cmux', '--new-workspace',
      ], env);
      assert.notStrictEqual(refused.status, 0);
      assert.match(refused.stderr, /--new-workspace requires a name/);
      assert.match(refused.stderr, /named program contexts/);

      const created = runCli(path.join(root, 'home-created'), [
        'spawn', '--agent', 'codex', '--terminal', 'cmux',
        '--new-workspace', 'ridge-program',
      ], env);
      assert.strictEqual(created.status, 0, created.stderr || created.stdout);
      assert.match(created.stdout, /named workspace "ridge-program": workspace:10, surface:1/);
      const log = fs.readFileSync(fixture.log, 'utf-8');
      assert.match(log, /^new-workspace --name ridge-program --cwd .* --command codex /m);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
