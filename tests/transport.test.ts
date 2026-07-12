import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isTransientCmuxError } from '../src/transport.js';
import { buildPushText, enterCountForDelivery, prefersNotifyDelivery, PUSH_MAX_CHARS } from '../src/cmux-transport.js';

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

  test('a long message with no parseable sender still nudges within one chunk', () => {
    const push = buildPushText('x'.repeat(500));
    assert.ok(push.length <= PUSH_MAX_CHARS);
    assert.match(push, /inbox/);
  });
});
