// Board v2 client store selectors — pure-function tests (no DOM).
// Added per adversarial review r1 findings 7, 8, 9, 10, and P8 digest math.
import { describe, test } from 'node:test';
import assert from 'node:assert';

// web/store.js is browser ESM with no DOM dependency — import it directly.
const store = await import('../web/store.js');

function agent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Alice',
    agentType: 'cmux',
    host: 'claude-code',
    joinedAt: '2026-07-22T00:00:00.000Z',
    lastHeartbeat: new Date().toISOString(),
    surfaceKnown: true,
    currentTaskId: null,
    progressEvidenceAt: null,
    unackedCount: 0,
    unackedMaxAgeMin: null,
    ...overrides,
  };
}

describe('board v2 store selectors', () => {
  test('agentStatus: only TYPED agent targets mark needs-you; ids never cross kinds', () => {
    const named42 = agent({ name: '42' });
    const needsWithMessageRef = [{ kind: 'gate', label: 'x', refId: '42', target: null, at: null }];
    assert.strictEqual(store.agentStatus(named42, needsWithMessageRef), 'idle');

    const typed = [{ kind: 'gate', label: 'x', refId: '7', target: { kind: 'agent', id: '42' }, at: null }];
    assert.strictEqual(store.agentStatus(named42, typed), 'needs-you');

    // Unread mail alone is the mail chip, not needs-you.
    assert.strictEqual(store.agentStatus(agent({ unackedCount: 3 }), []), 'idle');
  });

  test('agentStatus: stale beats working; headless seats are never stale', () => {
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    assert.strictEqual(
      store.agentStatus(agent({ currentTaskId: 't', lastHeartbeat: old }), []),
      'stale'
    );
    assert.strictEqual(
      store.agentStatus(agent({ agentType: 'headless', currentTaskId: 't', lastHeartbeat: old }), []),
      'working'
    );
  });

  test('rosterRows: idle-collapse thresholds on TOTAL idle; selected idle stays visible', () => {
    const board = {
      agents: ['A', 'B', 'C', 'D'].map(name => agent({ name })),
      needsYou: [],
      tasks: [],
      timeline: [],
      edges: { ownership: [], handoffs: [], claims: [] },
    };
    const collapsed = store.rosterRows(board, null);
    assert.strictEqual(collapsed.collapsedIdle.length, 4);
    assert.strictEqual(collapsed.rows.length, 0);

    const withSelection = store.rosterRows(board, { kind: 'agent', id: 'B' });
    assert.deepStrictEqual(withSelection.rows.map((row: { agent: { name: string } }) => row.agent.name), ['B']);
    assert.strictEqual(withSelection.collapsedIdle.length, 3);
  });

  test('taskSpans: one outcome bar per epoch; refusals aggregate as dots', () => {
    const events = [
      { epoch: 1, kind: 'started', at: 't1' },
      { epoch: 1, kind: 'checkpoint', at: 't2' },
      { epoch: 1, kind: 'refused_stale_epoch', at: 't3' },
      { epoch: 1, kind: 'refused_stale_epoch', at: 't4' },
      { epoch: 2, kind: 'started', at: 't5' },
      { epoch: 2, kind: 'review_requested', at: 't6' },
      { epoch: 2, kind: 'checkpoint', at: 't7' },
      { epoch: 2, kind: 'closed', at: 't8' },
    ];
    const spans = store.taskSpans(events);
    const bars = spans.filter((span: { shape: string }) => span.shape === 'bar');
    assert.strictEqual(bars.length, 2);
    assert.strictEqual(bars[0].group, 'progress');
    assert.strictEqual(bars[1].group, 'closed');
    const refusalDots = spans.filter((span: { group: string }) => span.group === 'refused');
    assert.strictEqual(refusalDots.length, 1);
    assert.strictEqual(refusalDots[0].count, 2);
  });

  test('flowGraph: claimant is claim.to, never claim.from', () => {
    const board = {
      agents: [],
      needsYou: [],
      timeline: [],
      tasks: [{ id: 't1', owner: 'Alice', title: 'x' }],
      edges: {
        ownership: [],
        handoffs: [],
        claims: [{ from: 'Alice', to: 'Bob', taskId: 't1', at: 'now' }],
      },
    };
    const graph = store.flowGraph(board, 't1');
    assert.ok(graph.right.some((node: { id: string }) => node.id === 'Bob'), 'claimant Bob must appear');
    assert.ok(!graph.right.some((node: { id: string }) => node.id === 'Alice'));
  });

  test('computeDigest: null under 10 min away; storage helpers survive a throwing storage', () => {
    const board = { timeline: [{ id: 5, kind: 'closed', actor: 'A', taskId: 't', at: 'x' }], needsYou: [] };
    assert.strictEqual(store.computeDigest(board, { at: Date.now() - 60_000, maxEventId: 1 }), null);
    const digest = store.computeDigest(board, { at: Date.now() - 11 * 60_000, maxEventId: 1 });
    assert.ok(digest && digest.items.length === 1);

    const hostile = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    };
    assert.strictEqual(store.loadLastSeen(hostile), null);
    assert.doesNotThrow(() => store.saveLastSeen(hostile, 5));
  });
});
