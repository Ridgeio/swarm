import { describe, test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDbAt } from '../src/db.js';
import { getOrCreateSwarm, joinHeadlessAgent } from '../src/registry.js';
import { getInbox } from '../src/mailbox.js';
import { parseSwarmEnvelope, startA2AServer } from '../src/a2a-server.js';
import { A2ATransport } from '../src/a2a-transport.js';

describe('parseSwarmEnvelope', () => {
  test('recovers sender and body from the swarm wire format', () => {
    const { from, body } = parseSwarmEnvelope('[SWARM from Scribe]: hello over there');
    assert.strictEqual(from, 'Scribe');
    assert.strictEqual(body, 'hello over there');
  });

  test('keeps multi-line bodies intact', () => {
    const { from, body } = parseSwarmEnvelope('[SWARM from Sol]: line one\nline two');
    assert.strictEqual(from, 'Sol');
    assert.strictEqual(body, 'line one\nline two');
  });

  test('falls back to a2a-remote for unenveloped text', () => {
    const { from, body } = parseSwarmEnvelope('raw a2a message');
    assert.strictEqual(from, 'a2a-remote');
    assert.strictEqual(body, 'raw a2a message');
  });
});

// End-to-end over real HTTP with the same SDK client path A2ATransport uses in
// production: remote swarm's deliverMessage → local serve → local inbox row.
describe('swarm serve end-to-end', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-a2a-test-'));
  const db = getDbAt(path.join(tmpDir, 'test.db'));
  let server: import('http').Server | undefined;

  after(() => {
    server?.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('delivers a remote swarm message into the local inbox', async () => {
    const swarm = getOrCreateSwarm(db, 'serve-test');
    joinHeadlessAgent(db, swarm.id, 'Fable', undefined, { trackSession: false });

    server = await startA2AServer({
      db,
      swarmId: swarm.id,
      swarmName: swarm.name,
      agentName: 'Fable',
      port: 0, // ephemeral
      bind: '127.0.0.1',
      advertiseUrl: 'http://127.0.0.1:0/', // rewritten below once the port is known
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const endpoint = `http://127.0.0.1:${address.port}`;

    // Liveness probe the way registry cleanup does it.
    const card = await fetch(`${endpoint}/.well-known/agent-card.json`).then(r => r.json()) as { name: string };
    assert.strictEqual(card.name, 'Fable');

    // Deliver exactly the way a remote swarm does.
    const transport = new A2ATransport();
    const result = await transport.deliverMessage(
      { name: 'Fable', agent_type: 'a2a', endpoint_url: endpoint } as any,
      '[SWARM from Scribe]: ping from the laptop swarm'
    );
    assert.strictEqual(result.delivered, true, result.error);

    const inbox = getInbox(db, swarm.id, 'Fable');
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].from_agent, 'Scribe');
    assert.strictEqual(inbox[0].body, 'ping from the laptop swarm');
  });
});
