import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assertNameNotReserved, assertValidAgentName, loadReservedNames } from '../src/reserved-names.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_ENV = process.env.SWARM_RESERVED_NAMES;
const ORIGINAL_FILE = process.env.SWARM_RESERVED_NAMES_FILE;

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_ENV === undefined) delete process.env.SWARM_RESERVED_NAMES;
  else process.env.SWARM_RESERVED_NAMES = ORIGINAL_ENV;
  if (ORIGINAL_FILE === undefined) delete process.env.SWARM_RESERVED_NAMES_FILE;
  else process.env.SWARM_RESERVED_NAMES_FILE = ORIGINAL_FILE;
});

describe('reserved names (machine-local)', () => {
  test('loads names from env and file, case-insensitive', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-reserved-'));
    process.env.HOME = home;
    delete process.env.SWARM_RESERVED_NAMES;
    delete process.env.SWARM_RESERVED_NAMES_FILE;

    const dir = path.join(home, '.swarm');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reserved-names'), '# comment\nForge\nAnvil\n\n');

    process.env.SWARM_RESERVED_NAMES = 'Cooper, Hermes';

    const names = loadReservedNames();
    assert.ok(names.has('forge'));
    assert.ok(names.has('anvil'));
    assert.ok(names.has('cooper'));
    assert.ok(names.has('hermes'));
    assert.ok(!names.has('scribe'));
  });

  test('assertNameNotReserved rejects reserved names', () => {
    process.env.SWARM_RESERVED_NAMES = 'Forge';
    delete process.env.SWARM_RESERVED_NAMES_FILE;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-reserved-'));

    assert.throws(() => assertNameNotReserved('forge'), /reserved on this machine/i);
    assert.doesNotThrow(() => assertNameNotReserved('Rivet'));
  });
});

describe('model-name policy', () => {
  test('rejects agents named after models, any casing or version suffix', () => {
    delete process.env.SWARM_RESERVED_NAMES;
    delete process.env.SWARM_RESERVED_NAMES_FILE;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-reserved-'));

    for (const bad of ['Fable', 'fable-5', 'Codex', 'codex 5.6', 'GPT_5.6', 'Sonnet', 'grok4', 'Claude', 'Gemini']) {
      assert.throws(() => assertNameNotReserved(bad), /model\/product name/i, bad);
    }
  });

  test('allows ordinary handles, including ones containing digits', () => {
    delete process.env.SWARM_RESERVED_NAMES;
    delete process.env.SWARM_RESERVED_NAMES_FILE;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-reserved-'));

    for (const ok of ['Scribe', 'Rivet', 'Yulan', 'Pixel2', 'Sol', 'Brillo']) {
      assert.doesNotThrow(() => assertNameNotReserved(ok), ok);
    }
  });
});

describe('flag-like agent names', () => {
  test('rejects names that look like flags (the swarm join --help incident)', () => {
    delete process.env.SWARM_RESERVED_NAMES;
    delete process.env.SWARM_RESERVED_NAMES_FILE;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-reserved-'));

    for (const bad of ['--help', '-h', '--force', '-x', '']) {
      assert.throws(() => assertNameNotReserved(bad), /not a valid agent name|looks like a flag/i, JSON.stringify(bad));
    }
  });

  test('assertValidAgentName passes ordinary names through', () => {
    for (const ok of ['Pixel', 'a', 'name-with-dash-inside']) {
      assert.doesNotThrow(() => assertValidAgentName(ok), ok);
    }
  });
});
