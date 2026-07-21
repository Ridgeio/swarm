import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseGlobalFlags } from '../src/args.js';

describe('parseGlobalFlags', () => {
  test('extracts --swarm in the flag region', () => {
    assert.deepStrictEqual(
      parseGlobalFlags(['members', '--swarm', 'proj']),
      { args: ['members'], swarmName: 'proj' }
    );
    assert.deepStrictEqual(
      parseGlobalFlags(['join', 'Foo', '-s', 'proj']),
      { args: ['join', 'Foo'], swarmName: 'proj' }
    );
    assert.deepStrictEqual(
      parseGlobalFlags(['--swarm=proj', 'members']),
      { args: ['members'], swarmName: 'proj' }
    );
  });

  test('--swarm before the command works', () => {
    assert.deepStrictEqual(
      parseGlobalFlags(['--swarm', 'proj', 'send', 'bob', 'hi']),
      { args: ['send', 'bob', 'hi'], swarmName: 'proj' }
    );
    assert.deepStrictEqual(
      parseGlobalFlags(['send', '--swarm', 'proj', 'bob', 'hello there']),
      { args: ['send', 'bob', 'hello there'], swarmName: 'proj' }
    );
  });

  test('does NOT eat -s / --swarm tokens inside a broadcast message', () => {
    // The exact regression: an unquoted message containing -s must survive intact.
    assert.deepStrictEqual(
      parseGlobalFlags(['broadcast', 'deploy', 'with', '-s', 'flag', 'now']),
      { args: ['broadcast', 'deploy', 'with', '-s', 'flag', 'now'], swarmName: undefined }
    );
    assert.deepStrictEqual(
      parseGlobalFlags(['broadcast', 'use', '--swarm', 'is', 'a', 'flag']),
      { args: ['broadcast', 'use', '--swarm', 'is', 'a', 'flag'], swarmName: undefined }
    );
  });

  test('does NOT eat -s tokens inside a send message (after the agent positional)', () => {
    assert.deepStrictEqual(
      parseGlobalFlags(['send', 'bob', 'run', 'rm', '-s', 'now']),
      { args: ['send', 'bob', 'run', 'rm', '-s', 'now'], swarmName: undefined }
    );
  });

  test('does NOT eat -s tokens inside rename / rename-workspace titles', () => {
    assert.deepStrictEqual(
      parseGlobalFlags(['rename', 'bob', 'title', '-s', 'x']),
      { args: ['rename', 'bob', 'title', '-s', 'x'], swarmName: undefined }
    );
    assert.deepStrictEqual(
      parseGlobalFlags(['rename-workspace', 'ws-1', 'my', '-s', 'title']),
      { args: ['rename-workspace', 'ws-1', 'my', '-s', 'title'], swarmName: undefined }
    );
  });

  test('quoted single-token message is preserved', () => {
    assert.deepStrictEqual(
      parseGlobalFlags(['broadcast', 'deploy with -s now']),
      { args: ['broadcast', 'deploy with -s now'], swarmName: undefined }
    );
  });

  test('a literal -- preserves every swarm-like child argv token for swarm run', () => {
    assert.deepStrictEqual(
      parseGlobalFlags(['--swarm', 'proj', 'run', '--task', 'build-it', '--', 'tool', '--swarm', 'child', '-s']),
      {
        args: ['run', '--task', 'build-it', '--', 'tool', '--swarm', 'child', '-s'],
        swarmName: 'proj',
      }
    );
  });
});

describe('swarm version', () => {
  test('formatVersion reports sha, up-to-date, behind, and offline states', async () => {
    const { formatVersion } = await import('../src/version.js');
    const mk = (responses: Record<string, string | Error>) => (args: string[]) => {
      const key = args.join(' ');
      for (const [prefix, value] of Object.entries(responses)) {
        if (key.startsWith(prefix)) {
          if (value instanceof Error) throw value;
          return value as string;
        }
      }
      throw new Error(`unexpected git ${key}`);
    };
    assert.match(formatVersion(false, mk({ 'rev-parse': 'abc1234' })), /^swarm .+ \(abc1234\)$/);
    assert.match(
      formatVersion(true, mk({ 'rev-parse': 'abc1234', 'fetch': '', 'rev-list --count HEAD..origin/master': '0', 'rev-list --count origin/master..HEAD': '0' })),
      /up to date with origin\/master/
    );
    assert.match(
      formatVersion(true, mk({ 'rev-parse': 'abc1234', 'fetch': '', 'rev-list --count HEAD..origin/master': '7', 'rev-list --count origin/master..HEAD': '0' })),
      /behind by 7.*git pull/
    );
    assert.match(
      formatVersion(true, mk({ 'rev-parse': 'abc1234', 'fetch': new Error('could not resolve host') })),
      /check unavailable/
    );
  });
});
