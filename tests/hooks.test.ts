import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectHost, installHook, removeHook } from '../src/hooks.js';

const ORIGINAL_HOME = process.env.HOME;
const CODEX_ENV_KEYS = ['CODEX_CLI', 'CODEX_CI', 'CODEX_THREAD_ID', 'CODEX_MANAGED_BY_NPM', 'CODEX_HOME'];
const GROK_ENV_KEYS = ['GROK_AGENT', 'GROK_HOME', 'CMUX_AGENT_LAUNCH_KIND'];
const ORIGINAL_CLAUDE_CODE = process.env.CLAUDE_CODE;
const ORIGINAL_CODEX_ENV = new Map(CODEX_ENV_KEYS.map(key => [key, process.env[key]]));
const ORIGINAL_GROK_ENV = new Map(GROK_ENV_KEYS.map(key => [key, process.env[key]]));

function clearRuntimeEnv(): void {
  delete process.env.CLAUDE_CODE;
  for (const key of CODEX_ENV_KEYS) delete process.env[key];
  for (const key of GROK_ENV_KEYS) delete process.env[key];
}

function withTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-hooks-'));
  process.env.HOME = home;
  clearRuntimeEnv();
  return home;
}

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CLAUDE_CODE === undefined) delete process.env.CLAUDE_CODE;
  else process.env.CLAUDE_CODE = ORIGINAL_CLAUDE_CODE;
  for (const key of CODEX_ENV_KEYS) {
    const value = ORIGINAL_CODEX_ENV.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of GROK_ENV_KEYS) {
    const value = ORIGINAL_GROK_ENV.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('hook host detection', () => {
  test('Codex runtime env wins when both Codex and Claude configs exist', () => {
    const home = withTempHome();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "test"\n');
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}\n');
    process.env.CODEX_THREAD_ID = 'thread-test';

    assert.strictEqual(detectHost(), 'codex');
  });

  test('Grok runtime env is detected via GROK_AGENT or CMUX_AGENT_LAUNCH_KIND', () => {
    const home = withTempHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}\n');
    fs.writeFileSync(path.join(home, '.grok', 'config.toml'), 'model = "test"\n');

    process.env.GROK_AGENT = '1';
    assert.strictEqual(detectHost(), 'grok');

    delete process.env.GROK_AGENT;
    process.env.CMUX_AGENT_LAUNCH_KIND = 'grok';
    assert.strictEqual(detectHost(), 'grok');
  });

  test('config fallback only detects a host when unambiguous', () => {
    const home = withTempHome();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "test"\n');
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}\n');

    assert.strictEqual(detectHost(), null);

    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    assert.strictEqual(detectHost(), 'codex');

    fs.rmSync(path.join(home, '.codex'), { recursive: true, force: true });
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(home, '.grok', 'config.toml'), 'model = "test"\n');
    assert.strictEqual(detectHost(), 'grok');
  });
});

describe('Codex hook state', () => {
  test('Codex session state does not overwrite or remove durable install instructions', () => {
    const home = withTempHome();
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const basePath = path.join(codexHome, 'swarm-instructions.md');
    const sessionPath = path.join(codexHome, 'swarm-session.md');
    const instructionsPath = path.join(codexHome, 'instructions.md');

    fs.writeFileSync(basePath, '# Existing Durable Instructions\n');
    fs.writeFileSync(instructionsPath, '<!-- existing -->\nKeep this line.\n');

    installHook('codex', 'Alice', 'swarm-a', 'project-a');

    assert.strictEqual(fs.readFileSync(basePath, 'utf-8'), '# Existing Durable Instructions\n');
    assert.match(fs.readFileSync(sessionPath, 'utf-8'), /joined swarm "project-a" as "Alice"/);
    assert.match(fs.readFileSync(sessionPath, 'utf-8'), /SWARM_ID="swarm-a"/);
    assert.match(fs.readFileSync(instructionsPath, 'utf-8'), /swarm-instructions/);
    assert.match(fs.readFileSync(instructionsPath, 'utf-8'), /swarm-session/);

    removeHook('codex', 'Alice', 'swarm-a');

    assert.ok(fs.existsSync(basePath), 'durable instructions must remain after leave');
    assert.ok(!fs.existsSync(sessionPath), 'session instructions should be removed after leave');
    const instructions = fs.readFileSync(instructionsPath, 'utf-8');
    assert.match(instructions, /swarm-instructions/);
    assert.doesNotMatch(instructions, /swarm-session/);
    assert.match(instructions, /Keep this line/);
  });

  test('Codex remove leaves another agent session intact', () => {
    const home = withTempHome();
    const sessionPath = path.join(home, '.codex', 'swarm-session.md');

    installHook('codex', 'Alice', 'swarm-a', 'project-a');
    removeHook('codex', 'Bob', 'swarm-a');

    assert.ok(fs.existsSync(sessionPath));
    assert.match(fs.readFileSync(sessionPath, 'utf-8'), /joined swarm "project-a" as "Alice"/);
  });
});

describe('Claude hook state', () => {
  test('removing a headless Claude session keeps the durable installer hook', () => {
    const home = withTempHome();
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: '/repo/hooks/swarm-awareness.sh' },
              { type: 'command', command: 'SWARM_AGENT_NAME="Alice" /repo/hooks/swarm-awareness-headless.sh' },
            ],
          },
        ],
      },
    }));

    removeHook('claude-code', 'Alice');

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const commands = settings.hooks.UserPromptSubmit.flatMap((entry: any) => entry.hooks.map((hook: any) => hook.command));
    assert.deepStrictEqual(commands, ['/repo/hooks/swarm-awareness.sh']);
  });
});

describe('Grok hook state', () => {
  test('installing Grok hook writes durable UserPromptSubmit hook under ~/.grok/hooks', () => {
    const home = withTempHome();
    process.env.GROK_HOME = path.join(home, '.grok');

    installHook('grok', 'Forge', 'swarm-a', 'project-a');

    const hookPath = path.join(home, '.grok', 'hooks', 'swarm-awareness.json');
    assert.ok(fs.existsSync(hookPath));
    const payload = JSON.parse(fs.readFileSync(hookPath, 'utf-8'));
    const command = payload.hooks.UserPromptSubmit[0].hooks[0].command as string;
    assert.match(command, /swarm-awareness/);
    assert.strictEqual(payload.hooks.UserPromptSubmit[0].hooks[0].type, 'command');
    assert.strictEqual(payload.hooks.UserPromptSubmit[0].hooks[0].timeout, 5);

    // Leave keeps the durable global hook (same model as Claude installer).
    removeHook('grok', 'Forge', 'swarm-a');
    assert.ok(fs.existsSync(hookPath));
  });
});
