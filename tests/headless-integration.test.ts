import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { getDbAt } from '../src/db.js';
import { joinHeadlessAgent, leaveHeadlessAgent, getAgent, listAgentsSync, getSelf } from '../src/registry.js';
import { sendMessage, broadcastMessage, getInbox } from '../src/mailbox.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import type Database from 'better-sqlite3';

describe('headless integration', () => {
  let db: Database.Database;
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'swarm-headless-'));
    db = getDbAt(join(tmpDir, 'test.db'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('two headless agents can exchange messages via inbox', async () => {
    // Agent A joins
    const agentA = joinHeadlessAgent(db, 'Alice');
    assert.strictEqual(agentA.agent_type, 'headless');
    assert.strictEqual(agentA.surface_id, 'headless:Alice');

    // Agent B joins
    const agentB = joinHeadlessAgent(db, 'Bob');
    assert.strictEqual(agentB.agent_type, 'headless');

    // Both visible
    const agents = listAgentsSync(db);
    assert.strictEqual(agents.length, 2);

    // A sends to B
    const sendResult = await sendMessage(db, 'Alice', 'Bob', 'hello from Alice');
    assert.strictEqual(sendResult.delivered, true);

    // B checks inbox
    const bobInbox = getInbox(db, 'Bob');
    assert.strictEqual(bobInbox.length, 1);
    assert.strictEqual(bobInbox[0].from_agent, 'Alice');
    assert.strictEqual(bobInbox[0].body, 'hello from Alice');

    // B replies
    const replyResult = await sendMessage(db, 'Bob', 'Alice', 'reply from Bob');
    assert.strictEqual(replyResult.delivered, true);

    // A checks inbox
    const aliceInbox = getInbox(db, 'Alice');
    assert.strictEqual(aliceInbox.length, 1);
    assert.strictEqual(aliceInbox[0].from_agent, 'Bob');
    assert.strictEqual(aliceInbox[0].body, 'reply from Bob');

    // Cleanup
    leaveHeadlessAgent(db, 'Alice');
    leaveHeadlessAgent(db, 'Bob');
    assert.strictEqual(listAgentsSync(db).length, 0);
  });

  it('broadcast reaches all headless agents', async () => {
    joinHeadlessAgent(db, 'Lead');
    joinHeadlessAgent(db, 'Dev1');
    joinHeadlessAgent(db, 'Dev2');

    const result = await broadcastMessage(db, 'Lead', 'status check');
    assert.strictEqual(result.sent, 2);
    assert.strictEqual(result.failed, 0);

    const dev1Inbox = getInbox(db, 'Dev1');
    assert.strictEqual(dev1Inbox.length, 1);
    assert.strictEqual(dev1Inbox[0].body, 'status check');

    const dev2Inbox = getInbox(db, 'Dev2');
    assert.strictEqual(dev2Inbox.length, 1);

    // Lead shouldn't see own broadcast
    const leadInbox = getInbox(db, 'Lead');
    assert.strictEqual(leadInbox.length, 0);

    leaveHeadlessAgent(db, 'Lead');
    leaveHeadlessAgent(db, 'Dev1');
    leaveHeadlessAgent(db, 'Dev2');
  });

  it('headless agents are not pruned by stale cleanup', async () => {
    const agent = joinHeadlessAgent(db, 'Persistent');

    // Manually set heartbeat to 20 minutes ago (past the 10min threshold)
    const staleTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare('UPDATE agents SET last_heartbeat = ? WHERE name = ?').run(staleTime, 'Persistent');

    // Import listAgents which runs cleanup
    const { listAgents } = await import('../src/registry.js');
    const agents = await listAgents(db);

    // Should still be there despite stale heartbeat
    const found = agents.find(a => a.name === 'Persistent');
    assert.ok(found, 'Headless agent should not be pruned even with stale heartbeat');

    leaveHeadlessAgent(db, 'Persistent');
  });
});
