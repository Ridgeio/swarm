import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { SwarmDb } from '../src/db.js';
import { AGENT_HELP_ENTRIES, CANONICAL_CLI_COMMANDS, renderAgentHelp } from '../src/agent-help.js';
import { collectBoardData } from '../src/board-data.js';
import { getDbAt, getDbReadOnly } from '../src/db.js';
import { harnessReviewTask } from '../src/harness-review.js';
import {
  runJanitorTick as runJanitorTickRaw,
  type JanitorTickOptions,
  type JanitorTickResult,
  type SwarmVersionGitRunner,
} from '../src/janitor.js';
import { joinAgent, type HostAgentKind, type WorkerVersionRunner } from '../src/registry.js';
import { CLAIM_KINDS } from '../src/tasks.js';
import { REPO_DIR } from '../src/version.js';

const INDEX = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const INDEX_SOURCE = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const NOW = Date.parse('2026-07-20T18:00:00.000Z');
const VERSION_SHA = 'a'.repeat(40);
const VERSION_RUNNER: SwarmVersionGitRunner = (_binary, args) =>
  args[0] === 'ls-remote' ? `${VERSION_SHA}\trefs/heads/master\n` : `${VERSION_SHA}\n`;

function runJanitorTick(
  db: SwarmDb,
  options: JanitorTickOptions = {}
): JanitorTickResult {
  return runJanitorTickRaw(db, { versionRunner: VERSION_RUNNER, ...options });
}

interface CliResult { stdout: string; stderr: string; status: number }

function runCli(home: string, args: string[]): CliResult {
  const env = {
    ...process.env,
    HOME: home,
    SWARM_ID: '',
    SWARM_NAME: '',
    SWARM_AGENT_NAME: '',
    SWARM_SESSION_TOKEN: '',
    CMUX_SURFACE_ID: '',
    CMUX_WORKSPACE_ID: '',
    CODEX_CLI: '',
    CODEX_CI: '',
    CODEX_THREAD_ID: '',
    CODEX_MANAGED_BY_NPM: '',
    CLAUDE_CODE: '',
    GROK_AGENT: '',
    GEMINI_CLI: '',
    SWARM_TEST_DISABLE_BACKGROUND: '1',
  };
  try {
    const stdout = execFileSync('node', ['--import', 'tsx', INDEX, ...args], {
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
      status: typeof error.status === 'number' ? error.status : 1,
    };
  }
}

function controlsFile(root: string, rows: string[]): string {
  const filePath = path.join(root, 'controls.md');
  fs.writeFileSync(filePath, [
    '# controls fixture',
    '',
    '| id | mechanism | guards-against | retest-by | retirement condition |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n'));
  return filePath;
}

function tableChecksums(db: SwarmDb): Map<string, string> {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'janitor_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  return new Map(tables.map(({ name }) => {
    const escaped = name.replace(/"/g, '""');
    const rows = db.prepare(`SELECT * FROM "${escaped}" ORDER BY rowid`).all();
    return [name, createHash('sha256').update(JSON.stringify(rows)).digest('hex')];
  }));
}

function treeMetadata(root: string): string[] {
  const rows: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      rows.push(`${relative}\0${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}\0${stat.size}\0${stat.mtimeMs}`);
      if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return rows.sort();
}

function insertTask(db: SwarmDb, slug: string): void {
  const createdAt = new Date(NOW - 60_000).toISOString();
  db.prepare(`
    INSERT INTO tasks (
      id, swarm_id, title, state, owner_agent, lease_epoch, lease_expires_at,
      repo_path, branch, worktree_path, transcript_hint, disposition, claim_kind,
      created_at, updated_at
    ) VALUES (?, 'default', ?, 'active', 'Worker', 1, NULL,
      NULL, NULL, NULL, NULL, NULL, 'analysis', ?, ?)
  `).run(slug, 'Review the harness', createdAt, createdAt);
}

function insertEvent(
  db: SwarmDb,
  slug: string,
  kind: string,
  actor: string,
  data: unknown,
  at: string
): void {
  db.prepare(`
    INSERT INTO task_events (swarm_id, task_id, epoch, kind, actor, data, created_at)
    VALUES ('default', ?, 1, ?, ?, ?, ?)
  `).run(slug, kind, actor, JSON.stringify(data), at);
}

describe('T3 worker epochs and control retirement', () => {
  let suiteRoot: string;

  before(() => {
    suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t3-t4-'));
  });

  after(() => {
    fs.rmSync(suiteRoot, { recursive: true, force: true });
  });

  test('join captures the raw first version line with the host binary and tolerates failures', () => {
    const db = getDbAt(path.join(suiteRoot, 'versions.db'));
    const expectedBinaries: Record<HostAgentKind, string> = {
      'claude-code': 'claude',
      codex: 'codex',
      grok: 'grok',
      gemini: 'gemini',
    };
    try {
      for (const [index, host] of (Object.keys(expectedBinaries) as HostAgentKind[]).entries()) {
        const runner: WorkerVersionRunner = (binary, args, options) => {
          assert.strictEqual(binary, expectedBinaries[host]);
          assert.deepStrictEqual(args, ['--version']);
          assert.strictEqual(options.timeout, 2_000);
          return `  ${host} version ${index}\nignored second line\n`;
        };
        const agent = joinAgent(
          db, 'default', `Worker-${index}`, `surface-${index}`, undefined, 1,
          undefined, 'cmux', undefined, host, runner
        );
        assert.strictEqual(agent.worker_version, `  ${host} version ${index}`);
        const stored = db.prepare('SELECT worker_version FROM agents WHERE id = ?')
          .get(agent.id) as { worker_version: string | null };
        assert.strictEqual(stored.worker_version, agent.worker_version);
      }

      const failed = joinAgent(
        db, 'default', 'Null-safe', 'surface-null', undefined, 1,
        undefined, 'cmux', undefined, 'codex', () => { throw new Error('missing binary'); }
      );
      assert.strictEqual(failed.worker_version, null);
      assert.strictEqual(
        (db.prepare("SELECT worker_version FROM agents WHERE name = 'Null-safe'").get() as any).worker_version,
        null
      );
    } finally {
      db.close();
    }
  });

  test('epoch finding fires once per version transition and ignores same-version rejoins', () => {
    const root = fs.mkdtempSync(path.join(suiteRoot, 'epoch-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.swarm'), { recursive: true });
    const db = getDbAt(path.join(home, '.swarm', 'swarm.db'));
    const missingControls = path.join(root, 'missing-controls.md');
    const version = (value: string): WorkerVersionRunner => () => `${value}\n`;
    try {
      joinAgent(db, 'default', 'Worker', 'surface', undefined, 1, undefined, 'cmux', undefined, 'codex', version('codex 1'));
      runJanitorTick(db, { homeDir: home, tempScanPaths: [], controlsFilePath: missingControls, now: NOW });
      assert.strictEqual(
        (db.prepare("SELECT count(*) AS n FROM janitor_findings WHERE kind = 'worker-epoch-change'").get() as any).n,
        0
      );

      joinAgent(db, 'default', 'Worker', 'surface', undefined, 1, undefined, 'cmux', undefined, 'codex', version('codex 1'));
      runJanitorTick(db, { homeDir: home, tempScanPaths: [], controlsFilePath: missingControls, now: NOW + 1_000 });
      assert.strictEqual(
        (db.prepare("SELECT count(*) AS n FROM janitor_findings WHERE kind = 'worker-epoch-change'").get() as any).n,
        0
      );

      joinAgent(db, 'default', 'Worker', 'surface', undefined, 1, undefined, 'cmux', undefined, 'codex', version('codex 2'));
      runJanitorTick(db, { homeDir: home, tempScanPaths: [], controlsFilePath: missingControls, now: NOW + 2_000 });
      const changed = db.prepare("SELECT * FROM janitor_findings WHERE kind = 'worker-epoch-change'").get() as any;
      assert.strictEqual(changed.state, 'hold');
      assert.deepStrictEqual(JSON.parse(changed.detail), {
        host: 'codex',
        from: 'codex 1',
        to: 'codex 2',
        runbook: 'docs/runbooks/requalify-worker.md',
      });

      joinAgent(db, 'default', 'Worker', 'surface', undefined, 1, undefined, 'cmux', undefined, 'codex', version('codex 2'));
      runJanitorTick(db, { homeDir: home, tempScanPaths: [], controlsFilePath: missingControls, now: NOW + 3_000 });
      const unchanged = db.prepare("SELECT * FROM janitor_findings WHERE kind = 'worker-epoch-change'").get() as any;
      assert.strictEqual(unchanged.last_seen_at, changed.last_seen_at);
      assert.strictEqual(
        (db.prepare("SELECT count(*) AS n FROM janitor_findings WHERE kind = 'worker-epoch-change'").get() as any).n,
        1
      );
    } finally {
      db.close();
    }
  });

  test('controls census flags overdue and invalid rows, while a missing file is a no-op', () => {
    const scenarios = [
      {
        name: 'overdue',
        path: (root: string) => controlsFile(root, [
          '| stale-control | fixture guard | fixture failures | 2026-07-19 | retire after proof |',
          '| fresh-control | fixture guard | fixture failures | 2026-07-21 | retire after proof |',
        ]),
        assertRows: (rows: any[]) => {
          assert.deepStrictEqual(rows.map(row => row.kind), ['control-retest-due']);
          assert.deepStrictEqual(JSON.parse(rows[0].detail), { id: 'stale-control', retest_by: '2026-07-19' });
        },
      },
      {
        name: 'invalid',
        path: (root: string) => controlsFile(root, [
          '| bad id | missing | strict | tomorrow | never |',
          '| also-bad | missing column | 2026-01-01 | never |',
        ]),
        assertRows: (rows: any[]) => {
          assert.strictEqual(rows.length, 1);
          assert.strictEqual(rows[0].kind, 'controls-file-invalid');
          assert.deepStrictEqual(JSON.parse(rows[0].detail).lines, [5, 6]);
        },
      },
      {
        name: 'missing',
        path: (root: string) => path.join(root, 'does-not-exist.md'),
        assertRows: (rows: any[]) => assert.deepStrictEqual(rows, []),
      },
    ];

    for (const scenario of scenarios) {
      const root = fs.mkdtempSync(path.join(suiteRoot, `${scenario.name}-`));
      const home = path.join(root, 'home');
      fs.mkdirSync(path.join(home, '.swarm'), { recursive: true });
      const db = getDbAt(path.join(home, '.swarm', 'swarm.db'));
      try {
        runJanitorTick(db, {
          homeDir: home,
          tempScanPaths: [],
          controlsFilePath: scenario.path(root),
          now: NOW,
        });
        const rows = db.prepare(`
          SELECT kind, detail FROM janitor_findings
          WHERE kind IN ('control-retest-due', 'controls-file-invalid')
          ORDER BY kind, path
        `).all() as any[];
        scenario.assertRows(rows);
      } finally {
        db.close();
      }
    }
  });

  test('NEEDS YOU surfaces worker epoch and control-retirement holds', () => {
    const db = getDbAt(path.join(suiteRoot, 'needs-you.db'));
    const at = new Date(NOW).toISOString();
    try {
      db.prepare(`
        INSERT INTO janitor_findings (first_seen_at, last_seen_at, kind, path, detail, state)
        VALUES (?, ?, 'worker-epoch-change', 'worker:codex', ?, 'hold')
      `).run(at, at, JSON.stringify({
        host: 'codex', from: 'codex 1', to: 'codex 2', runbook: 'docs/runbooks/requalify-worker.md',
      }));
      db.prepare(`
        INSERT INTO janitor_findings (first_seen_at, last_seen_at, kind, path, detail, state)
        VALUES (?, ?, 'control-retest-due', 'control:close-git-gates', ?, 'hold')
      `).run(at, at, JSON.stringify({ id: 'close-git-gates', retest_by: '2026-07-19' }));
      const needs = collectBoardData(db, 'default', { now: NOW }).needsYou;
      assert.deepStrictEqual(
        needs.filter(item => item.kind === 'worker-epoch-change' || item.kind === 'control-retest-due')
          .map(item => item.kind),
        ['control-retest-due', 'worker-epoch-change']
      );
      assert.match(needs.find(item => item.kind === 'worker-epoch-change')!.label, /docs\/runbooks\/requalify-worker\.md/);
      assert.match(needs.find(item => item.kind === 'control-retest-due')!.label, /close-git-gates.*2026-07-19/);
    } finally {
      db.close();
    }
  });
});

describe('T4 observer hardening and agent surfaces', () => {
  test('read-only handles enforce PRAGMA query_only and refuse writes', () => {
    const dbPath = path.join(os.tmpdir(), `swarm-query-only-${process.pid}-${Date.now()}.db`);
    const writable = getDbAt(dbPath);
    writable.close();
    const readOnly = getDbReadOnly(dbPath);
    assert.ok(readOnly);
    try {
      const pragma = readOnly!.prepare('PRAGMA query_only').get() as { query_only: number };
      assert.strictEqual(pragma.query_only, 1);
      assert.throws(() => readOnly!.prepare("UPDATE swarms SET name = 'mutated' WHERE id = 'default'").run());
    } finally {
      readOnly!.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch {}
      }
    }
  });

  test('a janitor tick changes only janitor_* tables', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-janitor-scope-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.swarm'), { recursive: true });
    const db = getDbAt(path.join(home, '.swarm', 'swarm.db'));
    try {
      insertTask(db, 'scope-fixture');
      const before = tableChecksums(db);
      const gitDir = execFileSync('git', ['-C', REPO_DIR, 'rev-parse', '--absolute-git-dir'], {
        encoding: 'utf-8',
      }).trim();
      const beforeGit = treeMetadata(gitDir);
      runJanitorTickRaw(db, {
        homeDir: home,
        tempScanPaths: [],
        controlsFilePath: path.join(root, 'missing-controls.md'),
        now: NOW,
      });
      assert.deepStrictEqual(tableChecksums(db), before);
      assert.deepStrictEqual(treeMetadata(gitDir), beforeGit, 'observe tick must not modify the swarm repo .git');
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('help --agent covers each CLI switch command exactly once in compact groups', () => {
    const source = fs.readFileSync(INDEX_SOURCE, 'utf-8');
    const switchCases = [...source.matchAll(/^\s+case '([^']+)':/gm)]
      .map(match => match[1])
      .filter(command => command !== '--help' && command !== '-h');
    assert.deepStrictEqual([...CANONICAL_CLI_COMMANDS].sort(), [...switchCases].sort());
    assert.strictEqual(new Set(CANONICAL_CLI_COMMANDS).size, CANONICAL_CLI_COMMANDS.length);
    assert.deepStrictEqual(AGENT_HELP_ENTRIES.map(entry => entry.command), CANONICAL_CLI_COMMANDS);

    const rendered = renderAgentHelp();
    const lines = rendered.split('\n');
    const closeTeaching = 'close records a disposition; it never performs a merge — landing happens via your operator/gates';
    const boardTeaching = 'board — render fleet state or graph (splits beside you; --own-workspace for program setup)';
    assert.ok(rendered.includes(closeTeaching));
    assert.ok(rendered.includes(boardTeaching));
    assert.ok(rendered.includes('spawn --split | --new-workspace <name>'));
    assert.ok(
      lines.slice(0, -1).filter(line => line !== closeTeaching && line !== boardTeaching).every(line => line.length <= 60),
      `overlong line: ${lines.find(line => line.length > 60 && line !== closeTeaching && line !== boardTeaching)}`
    );
    const footer = lines.at(-1)!;
    assert.ok(path.isAbsolute(footer), footer);
    assert.ok(fs.existsSync(footer), footer);
    assert.strictEqual(path.basename(footer), 'ROUTING.md');
    for (const claimKind of CLAIM_KINDS) {
      const claimLine = new RegExp(`^claim ${claimKind} → `, 'gm');
      assert.strictEqual(rendered.match(claimLine)?.length ?? 0, 1, claimKind);
    }
    for (const entry of AGENT_HELP_ENTRIES) {
      assert.strictEqual(lines.filter(line => line === entry.line).length, 1, entry.command);
    }
    const cli = runCli(os.tmpdir(), ['help', '--agent']);
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.strictEqual(cli.stdout.trimEnd(), rendered);

    const readme = fs.readFileSync(path.resolve(path.dirname(INDEX_SOURCE), '..', 'README.md'), 'utf-8');
    assert.match(readme, /`--disposition merged` verifies that the task commit is reachable from origin's default branch/);
    assert.match(readme, /With a local `file:\/\/` remote, the operator merges in the default-branch checkout and pushes that branch/);
    const troubleshooting = fs.readFileSync(path.resolve(path.dirname(INDEX_SOURCE), '..', 'TROUBLESHOOTING.md'), 'utf-8');
    assert.match(troubleshooting, /^## close refused: commit not on default branch$/m);
    assert.match(troubleshooting, /source SHA, target ref, and target SHA/);
  });

  test('harness-review renders all events and gates its dated skeleton until filled', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-harness-review-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.swarm'), { recursive: true });
    const db = getDbAt(path.join(home, '.swarm', 'swarm.db'));
    const slug = 'handoff-review';
    try {
      insertTask(db, slug);
      insertEvent(db, slug, 'started', 'Worker', { title: 'Review the harness' }, '2026-07-20T17:00:00.000Z');
      insertEvent(db, slug, 'checkpoint', 'Worker', { sequence: 1, path: '/tmp/checkpoint.md' }, '2026-07-20T17:10:00.000Z');
      insertEvent(db, slug, 'run', 'Worker', { logPath: '/tmp/run-001.log', exit: 1 }, '2026-07-20T17:20:00.000Z');
      insertEvent(db, slug, 'close_evidence', 'Reviewer', { kind: 'report', ref: '/tmp/report.md', verified: true }, '2026-07-20T17:30:00.000Z');

      const direct = harnessReviewTask(db, 'default', slug, { homeDir: home, now: new Date(NOW) });
      assert.strictEqual(direct.exitCode, 2);
      assert.match(direct.rendered, /2026-07-20T17:00:00\.000Z \| started \| Worker \| title=Review the harness/);
      assert.match(direct.rendered, /#001 \| 2026-07-20T17:10:00\.000Z \| Worker \| \/tmp\/checkpoint\.md/);
      assert.match(direct.rendered, /report:\/tmp\/report\.md \| verified=true/);
      assert.strictEqual(direct.briefPath, path.join(home, '.swarm', 'briefs', 'harness-reviews', `${slug}--20260720.md`));
      const skeleton = fs.readFileSync(direct.briefPath, 'utf-8');
      assert.strictEqual((skeleton.match(/<FILL>/g) ?? []).length, 4);
      for (const heading of [
        '## earliest failed handoff',
        '## smallest reversible intervention',
        '## owning boundary (CLI refusal | census | hook | doctrine)',
        '## EXP entry + rerun verdict (retain|revise|remove)',
      ]) assert.ok(skeleton.includes(heading));
    } finally {
      db.close();
    }

    const firstCli = runCli(home, ['harness-review', slug]);
    assert.strictEqual(firstCli.status, 2);
    assert.match(firstCli.stdout, /started \| Worker/);
    assert.match(firstCli.stderr, /Edit every <FILL> marker/);
    const briefPath = firstCli.stdout.match(/Harness review: (.+)$/m)?.[1];
    assert.ok(briefPath);
    let contents = fs.readFileSync(briefPath!, 'utf-8');
    for (const replacement of ['handoff', 'intervention', 'CLI refusal', 'retain']) {
      contents = contents.replace('<FILL>', replacement);
    }
    fs.writeFileSync(briefPath!, contents);

    const secondCli = runCli(home, ['harness-review', slug]);
    assert.strictEqual(secondCli.status, 0, secondCli.stderr);
    assert.match(secondCli.stdout, /file the intervention as an EXP entry with a due date/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
