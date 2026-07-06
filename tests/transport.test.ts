import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isTransientCmuxError } from '../src/transport.js';

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
