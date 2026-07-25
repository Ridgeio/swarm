import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isTransientCmuxError,
  sendToSurface,
  spawnBrowserPaneInWorkspace,
  spawnSplitInWorkspace,
} from '../src/transport.js';
import { buildPushText, enterCountForDelivery, prefersNotifyDelivery, isCodexScreenIdle, PUSH_MAX_CHARS } from '../src/cmux-transport.js';

const transportModuleUrl = new URL('../src/transport.ts', import.meta.url).href;

function runTransportScript(script: string, pathValue: string, timeout: number) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    {
      cwd: process.cwd(),
      env: { ...process.env, PATH: pathValue },
      encoding: 'utf8',
      timeout,
    }
  );
}

function resolveCmuxInChild(pathValue: string, timeout: number = 9_000) {
  return runTransportScript(`
    const { resolveCmux } = await import(${JSON.stringify(transportModuleUrl)});
    try {
      const first = resolveCmux();
      const second = resolveCmux();
      process.stdout.write(first + '\\n' + second);
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 17;
    }
  `, pathValue, timeout);
}

describe('cmux subprocess bounds', () => {
  test('a looping which fails loudly after five seconds without bundled fallback', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'swarm-looping-which-'));
    const whichPath = join(fixtureDir, 'which');
    writeFileSync(whichPath, '#!/bin/sh\nwhile :; do /bin/sleep 1; done\n');
    chmodSync(whichPath, 0o755);

    try {
      const poisonedPath = `${fixtureDir}:${process.env.PATH ?? ''}`;
      const startedAt = Date.now();
      const result = resolveCmuxInChild(poisonedPath);
      const elapsedMs = Date.now() - startedAt;

      assert.ifError(result.error);
      assert.strictEqual(result.status, 17);
      assert.ok(elapsedMs >= 4_000 && elapsedMs < 8_000, `elapsed ${elapsedMs}ms`);
      assert.match(result.stderr, /Timed out resolving cmux/);
      assert.ok(result.stderr.includes(`PATH=${poisonedPath}`), result.stderr);
      assert.doesNotMatch(result.stdout, /Applications\/cmux\.app/);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('a timeout is not cached and a subsequent resolution can succeed', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'swarm-recovering-which-'));
    const whichPath = join(fixtureDir, 'which');
    const invocationMarker = join(fixtureDir, 'first-invocation');
    const recoveredCmuxPath = join(fixtureDir, 'recovered-cmux');
    writeFileSync(whichPath, [
      '#!/bin/sh',
      `if test ! -e '${invocationMarker}'; then`,
      `  /usr/bin/touch '${invocationMarker}'`,
      '  while :; do /bin/sleep 1; done',
      'fi',
      `printf '%s\\n' '${recoveredCmuxPath}'`,
      '',
    ].join('\n'));
    chmodSync(whichPath, 0o755);

    try {
      const poisonedPath = `${fixtureDir}:${process.env.PATH ?? ''}`;
      const result = runTransportScript(`
        const { resolveCmux } = await import(${JSON.stringify(transportModuleUrl)});
        try {
          resolveCmux();
        } catch (error) {
          process.stderr.write((error instanceof Error ? error.message : String(error)) + '\\n');
        }
        process.stdout.write(resolveCmux());
      `, poisonedPath, 9_000);

      assert.ifError(result.error);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, recoveredCmuxPath);
      assert.match(result.stderr, /Timed out resolving cmux/);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('a non-timeout which failure still falls through to bundled resolution', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'swarm-failing-which-'));
    const whichPath = join(fixtureDir, 'which');
    writeFileSync(whichPath, '#!/bin/sh\nexit 1\n');
    chmodSync(whichPath, 0o755);

    try {
      const result = resolveCmuxInChild(`${fixtureDir}:${process.env.PATH ?? ''}`, 3_000);

      assert.ifError(result.error);
      if (result.status === 0) {
        const bundled = '/Applications/cmux.app/Contents/Resources/bin/cmux';
        assert.strictEqual(result.stdout, `${bundled}\n${bundled}`);
      } else {
        assert.strictEqual(result.status, 17);
        assert.match(result.stderr, /cmux not found/);
        assert.doesNotMatch(result.stderr, /Command failed/);
      }
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('a sane PATH resolves and caches the same cmux executable', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'swarm-cmux-path-'));
    const cmuxPath = join(fixtureDir, 'cmux');
    writeFileSync(cmuxPath, '#!/bin/sh\nexit 0\n');
    chmodSync(cmuxPath, 0o755);

    try {
      const result = resolveCmuxInChild(`${fixtureDir}:${process.env.PATH ?? ''}`, 3_000);

      assert.ifError(result.error);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, `${cmuxPath}\n${cmuxPath}`);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

// The transient/gone classification decides whether a failed cmux send is retried
// (busy surface) or treated as a dead surface (which lets cleanupStale prune the
// agent). Getting this wrong either drops messages or evicts live agents.
describe('isTransientCmuxError', () => {
  test('classifies the field-observed broken-pipe failure as transient', () => {
    // Exact stderr captured from a live send to a busy agent (2026-07-06).
    const err = { stderr: Buffer.from('Error: Failed to write to socket (Broken pipe, errno 32)') };
    assert.strictEqual(isTransientCmuxError(err), true);
  });

  test('recognizes assorted transient socket signals', () => {
    for (const s of [
      'write EPIPE',
      'Error: connection reset by peer',
      'ECONNRESET',
      'resource temporarily unavailable',
      'EAGAIN',
      'errno 32',
      'Failed to write to socket',
    ]) {
      assert.strictEqual(isTransientCmuxError({ stderr: Buffer.from(s) }), true, s);
    }
  });

  test('reads the signal from message or code, not just stderr', () => {
    assert.strictEqual(isTransientCmuxError({ message: 'write EPIPE' }), true);
    assert.strictEqual(isTransientCmuxError({ code: 'EPIPE' }), true);
  });

  test('classifies a genuinely-gone surface as NOT transient (fail fast)', () => {
    const err = { stderr: Buffer.from('Error: Surface not found: 7C9F5A6A') };
    assert.strictEqual(isTransientCmuxError(err), false);
  });

  test('does not treat an invalid-handle usage error as transient', () => {
    const err = { stderr: Buffer.from('Error: Invalid workspace handle: FAKE (expected UUID)') };
    assert.strictEqual(isTransientCmuxError(err), false);
  });

  test('handles null/undefined/empty without throwing', () => {
    assert.strictEqual(isTransientCmuxError(null), false);
    assert.strictEqual(isTransientCmuxError(undefined), false);
    assert.strictEqual(isTransientCmuxError({}), false);
  });
});

describe('T8 spawnSplitInWorkspace', () => {
  test('diffs pane surfaces, plumbs direction/workspace, and sends into the new split', () => {
    const calls: string[][] = [];
    let listCount = 0;
    const result = spawnSplitInWorkspace(
      '/tmp/swarm project',
      'echo ready',
      'left',
      'workspace:9',
      {
        resolveBinary: () => '/fixture/cmux',
        wait: () => {},
        runner: (_binary, args, options) => {
          assert.deepStrictEqual(options, {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30_000,
          });
          calls.push(args);
          if (args[0] === 'list-pane-surfaces') {
            listCount += 1;
            return listCount === 1 ? 'surface:1\n' : 'surface:1\nsurface:2\n';
          }
          if (args[0] === 'new-split') return 'OK workspace:9';
          return '';
        },
      }
    );

    assert.deepStrictEqual(result, { workspaceRef: 'workspace:9', surfaceRef: 'surface:2' });
    assert.ok(calls.some(args => args.join('\0') === [
      'new-split', 'left', '--workspace', 'workspace:9',
    ].join('\0')));
    assert.ok(calls.some(args => args.join('\0') === [
      'send', '--workspace', 'workspace:9', '--surface', 'surface:2',
      "cd '/tmp/swarm project' && echo ready",
    ].join('\0')));
    assert.ok(calls.some(args => args.join('\0') === [
      'send-key', '--workspace', 'workspace:9', '--surface', 'surface:2', 'Enter',
    ].join('\0')));
  });

  test('browser panes use new-pane with type, direction, URL, and workspace targeting', () => {
    const calls: string[][] = [];
    let listCount = 0;
    const result = spawnBrowserPaneInWorkspace(
      'file:///tmp/swarm%20graph.html',
      'down',
      'workspace:9',
      {
        resolveBinary: () => '/fixture/cmux',
        runner: (_binary, args) => {
          calls.push(args);
          if (args[0] === 'list-pane-surfaces') {
            listCount += 1;
            return listCount === 1 ? 'surface:1\n' : 'surface:1\nsurface:4\n';
          }
          if (args[0] === 'new-pane') return 'OK workspace:9';
          return '';
        },
      }
    );
    assert.deepStrictEqual(result, { workspaceRef: 'workspace:9', surfaceRef: 'surface:4' });
    assert.ok(calls.some(args => args.join('\0') === [
      'new-pane', '--type', 'browser', '--direction', 'down',
      '--workspace', 'workspace:9', '--url', 'file:///tmp/swarm%20graph.html',
    ].join('\0')));
  });
});

// The keystroke push must never exceed one chunk: multi-chunk sends to a busy
// TUI silently drop/duplicate content (delivered=true but only a fragment lands).
describe('buildPushText (single-chunk push, nudge for long messages)', () => {
  test('passes a short message through in full', () => {
    const short = '[SWARM from Atlas]: ping';
    assert.strictEqual(buildPushText(short), short);
  });

  test('a message at the boundary is still sent in full', () => {
    const msg = '[SWARM from A]: ' + 'x'.repeat(PUSH_MAX_CHARS - '[SWARM from A]: '.length);
    assert.strictEqual(msg.length, PUSH_MAX_CHARS);
    assert.strictEqual(buildPushText(msg), msg);
  });

  test('a long message collapses to a nudge naming the sender, within one chunk', () => {
    const long = '[SWARM from Atlas]: ' + '🎯 DEEPSEEK BATTERY (dpl_BpGCa) — STREAM HANG '.repeat(20);
    const push = buildPushText(long);
    assert.ok(push.length <= PUSH_MAX_CHARS, `nudge too long: ${push.length}`);
    assert.match(push, /Atlas/);
    assert.match(push, /inbox/);
  });

  test('the nudge stays within one chunk even for an absurdly long sender name', () => {
    const long = `[SWARM from ${'N'.repeat(200)}]: ` + 'body '.repeat(50);
    const push = buildPushText(long);
    assert.ok(push.length <= PUSH_MAX_CHARS, `nudge too long: ${push.length}`);
  });

  test('default delivery is single Enter (queue on Grok); interject doubles only for Grok', () => {
    assert.strictEqual(enterCountForDelivery('grok'), 1);
    assert.strictEqual(enterCountForDelivery('grok', {}), 1);
    assert.strictEqual(enterCountForDelivery('grok', { interject: false }), 1);
    assert.strictEqual(enterCountForDelivery('grok', { interject: true }), 2);
    assert.strictEqual(enterCountForDelivery('claude-code', { interject: true }), 1);
    assert.strictEqual(enterCountForDelivery('codex', { interject: true }), 1);
    assert.strictEqual(enterCountForDelivery(null, { interject: true }), 1);
  });

  test('Codex prefers non-invasive notify unless interject is requested', () => {
    assert.strictEqual(prefersNotifyDelivery('codex'), true);
    assert.strictEqual(prefersNotifyDelivery('codex', {}), true);
    assert.strictEqual(prefersNotifyDelivery('codex', { interject: true }), false);
    assert.strictEqual(prefersNotifyDelivery('grok'), false);
    assert.strictEqual(prefersNotifyDelivery('claude-code'), false);
    assert.strictEqual(prefersNotifyDelivery(null), false);
  });

  test('Codex idle detection requires a completed-turn boundary at the composer', () => {
    // Mid-turn: status line shows the interrupt hint for the whole turn.
    assert.strictEqual(
      isCodexScreenIdle('• Working (49s • esc to interrupt) · 1 background terminal\n\n› Implement {feature}'),
      false
    );
    // Idle composer: no interrupt hint anywhere on screen.
    assert.strictEqual(
      isCodexScreenIdle('─ Worked for 53m 07s ─────\n\n› Implement {feature}\n\n  gpt-5.6-sol xhigh'),
      true
    );
    assert.strictEqual(
      isCodexScreenIdle('• Final answer\n────────────────────────\n\n› Implement {feature}\n\n  gpt-5.6-luna low'),
      true
    );
  });

  test('Codex idle detection rejects ambiguous frames without a completed-turn boundary', () => {
    // A screen read can briefly omit the working indicator between tool/status
    // frames. Treating that absence as idle queues a nudge behind the active
    // turn; it surfaces later after the matching inbox row has been consumed.
    assert.strictEqual(
      isCodexScreenIdle('• Ran npm test\n  └ 120 tests passed\n\n› Implement {feature}\n\n  gpt-5.6-sol xhigh'),
      false
    );
    assert.strictEqual(isCodexScreenIdle(''), false);
  });

  test('a long message with no parseable sender still nudges within one chunk', () => {
    const push = buildPushText('x'.repeat(500));
    assert.ok(push.length <= PUSH_MAX_CHARS);
    assert.match(push, /inbox/);
  });
});

describe('sendToSurface screen guard', () => {
  test('fails closed on an ambiguous frame and sends only after a confirmed idle frame', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-screen-guard-'));
    const fakeCmux = join(dir, 'cmux');
    const log = join(dir, 'cmux.log');
    const priorPath = process.env.PATH;
    const priorScreen = process.env.SWARM_TEST_SCREEN;
    const priorLog = process.env.SWARM_TEST_LOG;

    writeFileSync(fakeCmux, `#!/bin/sh
if [ "$1" = "read-screen" ]; then
  printf "%s" "$SWARM_TEST_SCREEN"
  exit 0
fi
printf "%s\\n" "$*" >> "$SWARM_TEST_LOG"
`);
    chmodSync(fakeCmux, 0o755);

    try {
      process.env.PATH = `${dir}:${priorPath ?? ''}`;
      process.env.SWARM_TEST_LOG = log;
      process.env.SWARM_TEST_SCREEN = '• Ran npm test\n  └ 120 tests passed\n\n› Implement {feature}\n\n  gpt-5.6-sol xhigh';

      const skipped = sendToSurface('SCREEN-GUARD-TEST', 'nudge', null, {
        screenGuard: isCodexScreenIdle,
        confirmDelaySeconds: 0,
      });
      assert.strictEqual(skipped, false);

      process.env.SWARM_TEST_SCREEN = '─ Worked for 1s ─────\n\n› Implement {feature}\n\n  gpt-5.6-sol xhigh';
      const sent = sendToSurface('SCREEN-GUARD-TEST', 'nudge', null, {
        screenGuard: isCodexScreenIdle,
        confirmDelaySeconds: 0,
      });
      assert.strictEqual(sent, true);
      assert.match(readFileSync(log, 'utf8'), /^send .*nudge[\s\S]*send-key .*Enter/m);
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      if (priorScreen === undefined) delete process.env.SWARM_TEST_SCREEN;
      else process.env.SWARM_TEST_SCREEN = priorScreen;
      if (priorLog === undefined) delete process.env.SWARM_TEST_LOG;
      else process.env.SWARM_TEST_LOG = priorLog;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
