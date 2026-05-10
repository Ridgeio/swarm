import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureCodexTrust } from '../src/codex-trust.js';

describe('ensureCodexTrust', () => {
  let codexHome: string;
  const previousCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'codex-trust-'));
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('creates config.toml when none exists', () => {
    ensureCodexTrust('/Users/test/projectA');
    const cfg = readFileSync(join(codexHome, 'config.toml'), 'utf-8');
    assert.match(cfg, /\[projects\."\/Users\/test\/projectA"\]/);
    assert.match(cfg, /trust_level = "trusted"/);
  });

  it('appends to an existing config without modifying existing content', () => {
    const existing = `personality = "pragmatic"\nmodel = "gpt-5"\n\n[projects."/Users/test/projectX"]\ntrust_level = "trusted"\n`;
    writeFileSync(join(codexHome, 'config.toml'), existing);

    ensureCodexTrust('/Users/test/projectY');

    const cfg = readFileSync(join(codexHome, 'config.toml'), 'utf-8');
    assert.ok(cfg.startsWith(existing), 'existing content should be preserved verbatim at the start');
    assert.match(cfg, /\[projects\."\/Users\/test\/projectY"\]/);
    assert.match(cfg, /\[projects\."\/Users\/test\/projectX"\]/);
  });

  it('is idempotent — calling twice for the same path leaves config unchanged on the second call', () => {
    ensureCodexTrust('/Users/test/projectA');
    const after1 = readFileSync(join(codexHome, 'config.toml'), 'utf-8');

    ensureCodexTrust('/Users/test/projectA');
    const after2 = readFileSync(join(codexHome, 'config.toml'), 'utf-8');

    assert.strictEqual(after1, after2, 'second call should not modify config');
  });

  it('does not match a substring path (regex anchors)', () => {
    // Existing trust for /a; ensureCodexTrust('/a/b') should still append a new section, not consider it already trusted.
    writeFileSync(join(codexHome, 'config.toml'), `[projects."/a"]\ntrust_level = "trusted"\n`);
    ensureCodexTrust('/a/b');
    const cfg = readFileSync(join(codexHome, 'config.toml'), 'utf-8');
    assert.match(cfg, /\[projects\."\/a"\]/);
    assert.match(cfg, /\[projects\."\/a\/b"\]/);
  });

  it('handles paths containing regex metacharacters safely', () => {
    const odd = '/Users/test/proj.with+meta(chars)';
    ensureCodexTrust(odd);
    const cfg = readFileSync(join(codexHome, 'config.toml'), 'utf-8');
    assert.ok(cfg.includes(`[projects."${odd}"]`), 'should write the literal path');

    // Idempotent on weird path too
    ensureCodexTrust(odd);
    const cfg2 = readFileSync(join(codexHome, 'config.toml'), 'utf-8');
    assert.strictEqual(cfg, cfg2);
  });

  it('creates the codex home directory if missing', () => {
    const nested = join(codexHome, 'nested', 'subdir');
    process.env.CODEX_HOME = nested;
    assert.ok(!existsSync(nested));

    ensureCodexTrust('/Users/test/projectZ');

    assert.ok(existsSync(join(nested, 'config.toml')));
  });
});
