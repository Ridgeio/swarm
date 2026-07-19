import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import type { BoardData } from '../src/board-data.js';

interface GraphElement {
  group: 'nodes' | 'edges';
  data: Record<string, unknown> & { id: string };
  classes: string;
}

type BuildElements = (data: BoardData) => {
  elements: GraphElement[];
  topologyHash: string;
};

const ELEMENTS_PATH = path.resolve(fileURLToPath(new URL('../web/board-elements.js', import.meta.url)));

function loadBuilder(): BuildElements {
  const sandbox = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(fs.readFileSync(ELEMENTS_PATH, 'utf-8'), sandbox, {
    filename: ELEMENTS_PATH,
  });
  return sandbox.module.exports as BuildElements;
}

function fixture(): BoardData {
  return {
    generatedAt: '2026-07-19T12:00:00.000Z',
    swarm: { id: 'default', name: 'Ridge Fleet' },
    agents: [
      {
        name: 'Alice',
        agentType: 'cmux',
        host: 'codex',
        joinedAt: '2026-07-19T10:00:00.000Z',
        lastHeartbeat: '2026-07-19T11:59:00.000Z',
        surfaceKnown: true,
        currentTaskId: 'stale-task',
        progressEvidenceAt: '2026-07-19T11:55:00.000Z',
        unackedCount: 1,
        unackedMaxAgeMin: 5,
      },
      {
        name: 'Bob',
        agentType: 'cmux',
        host: 'claude',
        joinedAt: '2026-07-19T10:10:00.000Z',
        lastHeartbeat: '2026-07-19T11:58:00.000Z',
        surfaceKnown: true,
        currentTaskId: 'review-task',
        progressEvidenceAt: '2026-07-19T11:54:00.000Z',
        unackedCount: 0,
        unackedMaxAgeMin: null,
      },
    ],
    tasks: [
      {
        id: 'stale-task',
        title: 'Stale task',
        state: 'active',
        owner: 'alice',
        leaseEpoch: 2,
        repoPath: '/repo',
        branch: 'feat/stale',
        worktreePath: '/repo/worktree',
        createdAt: '2026-07-19T10:00:00.000Z',
        checkpoint: { seq: 3, ageMin: 91, nextAction: 'Recover.', path: '/checkpoint' },
        stale: true,
        git: { dirty: false, untracked: 0, unpushed: 1 },
      },
      {
        id: 'review-task',
        title: 'Review task',
        state: 'awaiting_review',
        owner: 'Bob',
        leaseEpoch: 4,
        repoPath: null,
        branch: null,
        worktreePath: null,
        createdAt: '2026-07-19T11:00:00.000Z',
        checkpoint: null,
        stale: false,
        git: null,
      },
    ],
    edges: {
      ownership: [
        { agent: 'ALICE', taskId: 'stale-task' },
        { agent: 'Bob', taskId: 'review-task' },
      ],
      handoffs: [{
        from: 'Alice',
        to: 'Bob',
        taskId: 'stale-task',
        at: '2026-07-19T11:30:00.000Z',
      }],
      claims: [{
        from: 'Bob',
        to: 'Alice',
        taskId: 'stale-task',
        at: '2026-07-19T11:40:00.000Z',
      }],
    },
    needsYou: [],
    debris: {
      tickAgeMin: 2,
      counters: {
        worktrees: 2,
        detachedHeads: 1,
        orphanedWorktrees: 0,
        unpushedCommits: 1,
        goneUpstreamBranches: 0,
        tempStrays: 0,
        junkDirs: 0,
        reposScanned: 2,
        tickMs: 9,
      },
      findings: [{
        kind: 'unpushed-commits',
        path: '/repo',
        state: 'hold',
        firstSeenAt: '2026-07-19T11:00:00.000Z',
        lastSeenAt: '2026-07-19T11:58:00.000Z',
        detail: { count: 1 },
      }],
    },
    timeline: [],
    quota: null,
    unavailable: [],
  };
}

function byId(elements: GraphElement[], id: string): GraphElement {
  const found = elements.find(element => element.data.id === id);
  assert.ok(found, `missing element ${id}`);
  return found;
}

describe('V1-B boardElements', () => {
  test('maps agents, task states, debris, and all three edge semantics', () => {
    const build = loadBuilder();
    const data = fixture();
    const before = JSON.stringify(data);
    const result = build(data);

    assert.match(byId(result.elements, 'agent:Alice').classes, /\bhost-codex\b/);
    assert.match(byId(result.elements, 'agent:Bob').classes, /\bhost-claude\b/);
    assert.match(byId(result.elements, 'task:stale-task').classes, /\bst-active\b/);
    assert.match(byId(result.elements, 'task:stale-task').classes, /\bstale\b/);
    assert.match(byId(result.elements, 'task:review-task').classes, /\bst-awaiting_review\b/);
    assert.match(byId(result.elements, 'debris').classes, /\bdebris-warn\b/);

    const edges = result.elements.filter(element => element.group === 'edges');
    assert.ok(edges.some(edge => edge.data.kind === 'owns' && /\bsolid\b/.test(edge.classes)));
    assert.ok(edges.some(edge => edge.data.kind === 'handoff' && /\bdashed\b/.test(edge.classes)));
    assert.ok(edges.some(edge => edge.data.kind === 'claim' && /\bdotted\b/.test(edge.classes)));
    assert.strictEqual(JSON.stringify(data), before, 'pure mapping must not mutate BoardData');
  });

  test('topologyHash ignores data-only changes and changes for nodes or edge triples', () => {
    const build = loadBuilder();
    const original = fixture();
    const baseline = build(original).topologyHash;
    const dataOnly = structuredClone(original);
    dataOnly.generatedAt = '2026-07-19T13:00:00.000Z';
    dataOnly.agents[0].lastHeartbeat = '2026-07-19T12:59:00.000Z';
    dataOnly.agents[0].host = 'grok';
    dataOnly.tasks[0].title = 'Changed title';
    dataOnly.tasks[0].state = 'done';
    dataOnly.tasks[0].stale = false;
    dataOnly.edges.handoffs[0].at = '2026-07-19T12:45:00.000Z';
    assert.strictEqual(build(dataOnly).topologyHash, baseline);

    const nodeAdded = structuredClone(original);
    nodeAdded.tasks.push({
      ...nodeAdded.tasks[1],
      id: 'new-task',
      title: 'New task',
      owner: null,
    });
    assert.notStrictEqual(build(nodeAdded).topologyHash, baseline);

    const edgeAdded = structuredClone(original);
    edgeAdded.edges.handoffs.push({
      from: 'Bob',
      to: 'Alice',
      taskId: 'review-task',
      at: '2026-07-19T12:30:00.000Z',
    });
    assert.notStrictEqual(build(edgeAdded).topologyHash, baseline);
  });
});
