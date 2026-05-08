import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DEFAULT_SWARM_ID, getDbAt } from '../src/db.js';
import { joinHeadlessAgent, leaveHeadlessAgent, listAgentsSync } from '../src/registry.js';
import { sendMessage, broadcastMessage, getInbox } from '../src/mailbox.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import type Database from 'better-sqlite3';

describe('headless integration', () => {
  let db: Database.Database;
  let tmpDir: string;
  const swarmId = DEFAULT_SWARM_ID;

  before(() => {
    process.env.SWARM_DISABLE_SESSION_MARKER = '1';
    tmpDir = mkdtempSync(join(tmpdir(), 'swarm-headless-'));
    db = getDbAt(join(tmpDir, 'test.db'));
  });

  after(() => {
    delete process.env.SWARM_DISABLE_SESSION_MARKER;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('two headless agents can exchange messages via inbox', async () => {
    // Agent A joins
    const agentA = joinHeadlessAgent(db, swarmId, 'Alice');
    assert.strictEqual(agentA.agent_type, 'headless');
    assert.strictEqual(agentA.surface_id, `headless:${swarmId}:Alice`);

    // Agent B joins
    const agentB = joinHeadlessAgent(db, swarmId, 'Bob');
    assert.strictEqual(agentB.agent_type, 'headless');

    // Both visible
    const agents = listAgentsSync(db, swarmId);
    assert.strictEqual(agents.length, 2);

    // A sends to B
    const sendResult = await sendMessage(db, swarmId, 'Alice', 'Bob', 'hello from Alice');
    assert.strictEqual(sendResult.delivered, true);

    // B checks inbox
    const bobInbox = getInbox(db, swarmId, 'Bob');
    assert.strictEqual(bobInbox.length, 1);
    assert.strictEqual(bobInbox[0].from_agent, 'Alice');
    assert.strictEqual(bobInbox[0].body, 'hello from Alice');

    // B replies
    const replyResult = await sendMessage(db, swarmId, 'Bob', 'Alice', 'reply from Bob');
    assert.strictEqual(replyResult.delivered, true);

    // A checks inbox
    const aliceInbox = getInbox(db, swarmId, 'Alice');
    assert.strictEqual(aliceInbox.length, 1);
    assert.strictEqual(aliceInbox[0].from_agent, 'Bob');
    assert.strictEqual(aliceInbox[0].body, 'reply from Bob');

    // Cleanup
    leaveHeadlessAgent(db, swarmId, 'Alice');
    leaveHeadlessAgent(db, swarmId, 'Bob');
    assert.strictEqual(listAgentsSync(db, swarmId).length, 0);
  });

  it('broadcast reaches all headless agents', async () => {
    joinHeadlessAgent(db, swarmId, 'Lead');
    joinHeadlessAgent(db, swarmId, 'Dev1');
    joinHeadlessAgent(db, swarmId, 'Dev2');

    const result = await broadcastMessage(db, swarmId, 'Lead', 'status check');
    assert.strictEqual(result.sent, 2);
    assert.strictEqual(result.failed, 0);

    const dev1Inbox = getInbox(db, swarmId, 'Dev1');
    assert.strictEqual(dev1Inbox.length, 1);
    assert.strictEqual(dev1Inbox[0].body, 'status check');

    const dev2Inbox = getInbox(db, swarmId, 'Dev2');
    assert.strictEqual(dev2Inbox.length, 1);

    // Lead shouldn't see own broadcast
    const leadInbox = getInbox(db, swarmId, 'Lead');
    assert.strictEqual(leadInbox.length, 0);

    leaveHeadlessAgent(db, swarmId, 'Lead');
    leaveHeadlessAgent(db, swarmId, 'Dev1');
    leaveHeadlessAgent(db, swarmId, 'Dev2');
  });

  it('headless agents are not pruned by stale cleanup', async () => {
    const agent = joinHeadlessAgent(db, swarmId, 'Persistent');

    // Manually set heartbeat to 20 minutes ago (past the 10min threshold)
    const staleTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare('UPDATE agents SET last_heartbeat = ? WHERE swarm_id = ? AND name = ?').run(staleTime, swarmId, 'Persistent');

    // Import listAgents which runs cleanup
    const { listAgents } = await import('../src/registry.js');
    const agents = await listAgents(db, swarmId);

    // Should still be there despite stale heartbeat
    const found = agents.find(a => a.name === 'Persistent');
    assert.ok(found, 'Headless agent should not be pruned even with stale heartbeat');

    leaveHeadlessAgent(db, swarmId, 'Persistent');
  });
});
