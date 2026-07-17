import { describe, test } from 'node:test';
import assert from 'node:assert';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTransientCmuxError, sendToSurface } from '../src/transport.js';
import { buildPushText, enterCountForDelivery, prefersNotifyDelivery, isCodexScreenIdle, PUSH_MAX_CHARS } from '../src/cmux-transport.js';

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
