import type Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  boardAgeLabel,
  boardHasTable,
  collectBoardData,
  type BoardAgentData,
  type BoardData,
  type BoardTaskData,
} from './board-data.js';
import { JANITOR_HEARTBEAT_STALE_MS } from './janitor.js';
import { spawnBrowserWorkspace, spawnWorkspace } from './transport.js';
import { fileURLToPath, pathToFileURL } from 'url';

export const BOARD_DEFAULT_WATCH_SECONDS = 5;
export const BOARD_CMUX_GUIDANCE = "cmux not found — run 'swarm board --watch' directly in a terminal you want to watch.";
const MERMAID_VENDOR_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'vendor',
  'mermaid.min.js'
);

export { boardHasTable } from './board-data.js';

export interface BoardRenderOptions {
  now?: number;
}

export interface BoardWatchOptions {
  render: () => string;
  intervalMs?: number;
  clear?: () => void;
  write?: (value: string) => void;
  wait?: (milliseconds: number) => Promise<void>;
  shouldContinue?: (renderCount: number) => boolean;
}

export interface BoardTabOptions {
  cwd?: string;
  watchSeconds?: number;
  spawn?: typeof spawnWorkspace;
  write?: (value: string) => void;
  writeError?: (value: string) => void;
  exit?: (code: number) => void;
}

export interface BoardMermaidOptions {
  now?: number;
}

export interface BoardHtmlOptions {
  watchSeconds?: number;
}

export type BoardGraphFileOptions = BoardHtmlOptions;

export interface BoardGraphWatchOptions {
  regenerate: () => void;
  intervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
  shouldContinue?: (renderCount: number) => boolean;
}

export interface BoardGraphTabOptions {
  cwd?: string;
  spawn?: typeof spawnBrowserWorkspace;
  open?: (filePath: string) => boolean;
  writeError?: (value: string) => void;
}

function section(title: string, lines: string[]): string {
  const rows = lines.length > 0 ? lines : ['not available'];
  const innerWidth = Math.max(title.length + 3, 20, ...rows.map(row => row.length + 2));
  const top = `\u250c\u2500 ${title} ${'\u2500'.repeat(Math.max(1, innerWidth - title.length - 3))}\u2510`;
  const body = rows.map(row => `\u2502 ${row.padEnd(innerWidth - 1)}\u2502`).join('\n');
  const bottom = `\u2514${'\u2500'.repeat(innerWidth)}\u2518`;
  return `${top}\n${body}\n${bottom}`;
}

function isUnavailable(data: BoardData, tables: string[]): boolean {
  return tables.some(table => data.unavailable.includes(table));
}

function branchFacts(task: BoardTaskData): string {
  if (!task.branch) return '-';
  if (!task.repoPath || !task.git) return `${task.branch} (push?/dirty?)`;
  const pushed = task.git.unpushed > 0 ? `unpushed:${task.git.unpushed}` : 'pushed';
  const dirty = task.git.dirty || task.git.untracked > 0 ? 'dirty' : 'clean';
  return `${task.branch} (${pushed}/${dirty})`;
}

function renderNeedsYou(data: BoardData): string[] | null {
  if (isUnavailable(data, [
    'messages', 'message_deliveries', 'tasks', 'task_events', 'janitor_status',
  ])) return null;
  return data.needsYou.length > 0
    ? data.needsYou.map(item => item.label)
    : ['nothing needs you'];
}

function renderTasks(data: BoardData): string[] | null {
  if (isUnavailable(data, ['tasks', 'task_events', 'agents'])) return null;
  const tasks = data.tasks.filter(task => task.state !== 'done');
  if (tasks.length === 0) return ['no non-done tasks'];
  const agents = new Map(data.agents.map(agent => [agent.name.toLowerCase(), agent]));
  return tasks.map(task => {
    const owner = task.owner ?? 'unowned';
    const host = task.owner
      ? agents.get(task.owner.toLowerCase())?.host ?? 'unknown'
      : 'unknown';
    return `${task.id} | ${task.state} | ${owner}(${task.leaseEpoch}) | -/${host} | ` +
      `${task.checkpoint ? `${task.checkpoint.ageMin}m` : 'none'} | ${branchFacts(task)} | ` +
      `${task.checkpoint?.nextAction ?? '(not recorded)'}`;
  });
}

function renderFleet(data: BoardData, now: number): string[] | null {
  if (isUnavailable(data, [
    'agents', 'tasks', 'task_events', 'messages', 'message_deliveries',
  ])) return null;
  if (data.agents.length === 0) return ['no registered agents'];
  return data.agents.map(agent =>
    `${agent.name} | ${agent.host} | ${agent.currentTaskId ?? '-'} | ` +
    `progress ${boardAgeLabel(agent.progressEvidenceAt, now)} | ${agent.unackedCount} unacked`
  );
}

function renderDebrisAndQuota(data: BoardData): string[] | null {
  if (isUnavailable(data, ['janitor_status', 'tasks', 'task_events'])) return null;
  const counters = data.debris.counters;
  const debris = data.debris.tickAgeMin === null
    ? 'debris: not recorded'
    : `debris: worktrees ${counters.worktrees} (${counters.detachedHeads} detached) | ` +
      `unpushed ${counters.unpushedCommits} | strays ${counters.tempStrays} | junk ${counters.junkDirs} | ` +
      `tick ${data.debris.tickAgeMin}m ago`;
  return [debris, `quota: ${data.quota ?? 'not recorded'}`];
}

/** Render one read-only snapshot. This function performs no database or file writes. */
export function renderBoard(
  db: Database.Database | null,
  swarmId: string,
  options: BoardRenderOptions = {}
): string {
  const requestedNow = options.now ?? Date.now();
  const now = Number.isFinite(requestedNow) ? requestedNow : Date.now();
  const data = collectBoardData(db, swarmId, { now });
  return [
    section('NEEDS YOU', renderNeedsYou(data) ?? ['not available']),
    section('TASKS', renderTasks(data) ?? ['not available']),
    section('FLEET', renderFleet(data, now) ?? ['not available']),
    section('DEBRIS + QUOTA', renderDebrisAndQuota(data) ?? ['not available']),
  ].join('\n');
}

/** Re-render until the injected exit condition fails (normally Ctrl-C exits the process). */
export async function watchBoard(options: BoardWatchOptions): Promise<number> {
  const intervalMs = options.intervalMs ?? BOARD_DEFAULT_WATCH_SECONDS * 1_000;
  const clear = options.clear ?? (() => process.stdout.write('\x1b[2J\x1b[H'));
  const write = options.write ?? (value => process.stdout.write(value));
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const shouldContinue = options.shouldContinue ?? (() => true);
  let renderCount = 0;

  while (shouldContinue(renderCount)) {
    clear();
    write(`${options.render()}\n`);
    renderCount += 1;
    if (!shouldContinue(renderCount)) break;
    await wait(intervalMs);
  }
  return renderCount;
}

/** Spawn the terminal board in a named cmux workspace and leave its watch loop there. */
export function spawnBoardTab(
  options: BoardTabOptions = {}
): { workspaceRef: string; surfaceRef: string } | null {
  const watchSeconds = options.watchSeconds ?? BOARD_DEFAULT_WATCH_SECONDS;
  const spawn = options.spawn ?? spawnWorkspace;
  const write = options.write ?? (value => console.log(value));
  const writeError = options.writeError ?? (value => console.error(value));
  const exit = options.exit ?? (code => process.exit(code));

  try {
    const result = spawn(
      options.cwd ?? process.cwd(),
      `swarm board --watch ${watchSeconds}`,
      'swarm board'
    );
    if (!result) throw new Error('cmux did not return a workspace and surface');
    write(`Opened swarm board: ${result.workspaceRef} ${result.surfaceRef}`);
    return result;
  } catch {
    writeError(BOARD_CMUX_GUIDANCE);
    exit(1);
    return null;
  }
}

function mermaidLabel(value: string): string {
  return value
    .replace(/#/g, '#35;')
    .replace(/&/g, '#38;')
    .replace(/"/g, '#quot;')
    .replace(/`/g, '#96;')
    .replace(/</g, '#60;')
    .replace(/>/g, '#62;')
    .replace(/\|/g, '#124;')
    .replace(/\r\n|\r|\n/g, '<br/>')
    .replace(/\t/g, ' ');
}

function hostClass(agent: BoardAgentData): string {
  const host = agent.host.toLowerCase();
  if (host.includes('claude')) return 'hostClaude';
  if (host.includes('codex')) return 'hostCodex';
  if (host.includes('grok')) return 'hostGrok';
  if (host.includes('gemini')) return 'hostGemini';
  if (host.includes('a2a')) return 'hostA2A';
  if (host.includes('headless')) return 'hostHeadless';
  return 'hostUnknown';
}

function taskClass(task: BoardTaskData): string {
  if (task.state === 'done') return 'stDone';
  if (task.state === 'awaiting_review') return 'stAwaiting';
  if (task.state === 'active') return task.checkpoint && task.stale ? 'stStale' : 'stActive';
  return 'stOpen';
}

function graphClassDefinitions(): string[] {
  return [
    'classDef hostClaude fill:#d9ccff,stroke:#6d4aff,color:#24164f;',
    'classDef hostCodex fill:#c7e9ff,stroke:#1677a8,color:#0b3550;',
    'classDef hostGrok fill:#ffd0d0,stroke:#bb3e3e,color:#561b1b;',
    'classDef hostGemini fill:#c9f2dc,stroke:#27845a,color:#123f2a;',
    'classDef hostA2A fill:#ffe2ad,stroke:#a86600,color:#513200;',
    'classDef hostHeadless fill:#e4e4e7,stroke:#71717a,color:#27272a;',
    'classDef hostUnknown fill:#f1f5f9,stroke:#64748b,color:#334155;',
    'classDef stActive fill:#c8f3d1,stroke:#238636,color:#123d1d;',
    'classDef stAwaiting fill:#ffe7a3,stroke:#b77900,color:#513600;',
    'classDef stStale fill:#ffd0d0,stroke:#d1242f,color:#5c1118,stroke-width:3px;',
    'classDef stOpen fill:#e5e7eb,stroke:#6b7280,color:#374151;',
    'classDef stDone fill:#e5e7eb,stroke:#9ca3af,color:#6b7280,opacity:0.55,text-decoration:line-through;',
    'classDef debrisWarn fill:#ffd8a8,stroke:#d97706,color:#5f2c00;',
    'classDef debrisOk fill:#e2e8f0,stroke:#64748b,color:#334155;',
    'classDef debrisStale stroke:#dc2626,stroke-width:4px;',
    'classDef note fill:#f8fafc,stroke:#94a3b8,color:#475569,stroke-dasharray:4 3;',
  ];
}

function graphLegend(): string[] {
  return [
    'subgraph legend["Legend"]',
    '  direction TB',
    '  legendClaude("Claude host"):::hostClaude',
    '  legendCodex("Codex host"):::hostCodex',
    '  legendGrok("Grok host"):::hostGrok',
    '  legendGemini("Gemini host"):::hostGemini',
    '  legendA2A("A2A host"):::hostA2A',
    '  legendHeadless("Headless host"):::hostHeadless',
    '  legendUnknown("Unknown host"):::hostUnknown',
    '  legendActive["active task"]:::stActive',
    '  legendAwaiting["awaiting review"]:::stAwaiting',
    '  legendStale["stale task"]:::stStale',
    '  legendOpen["open task"]:::stOpen',
    '  legendDone["recently done"]:::stDone',
    '  legendDebrisWarn["debris present"]:::debrisWarn',
    '  legendDebrisOk["debris clear"]:::debrisOk',
    '  legendDebrisStale["janitor stale"]:::debrisStale',
    '  legendEdges["solid owns · dashed handoff · dotted claimed"]:::note',
    'end',
  ];
}

function minimalBoardMermaid(swarmId: string, missing: string[], now: number): string {
  const title = `Swarm ${swarmId} · ${new Date(now).toISOString()} · graph not available`;
  const detail = missing.length > 0 ? `missing tables: ${missing.join(', ')}` : 'database not available';
  return [
    'flowchart LR',
    `accTitle: ${mermaidLabel(title)}`,
    `unavailable["board graph not available<br/>${mermaidLabel(detail)}"]:::note`,
    'classDef note fill:#f8fafc,stroke:#94a3b8,color:#475569,stroke-dasharray:4 3;',
  ].join('\n');
}

/** Build a deterministic, read-only Mermaid view of live ownership and handoffs. */
export function buildBoardMermaid(
  db: Database.Database | null,
  swarmId: string,
  options: BoardMermaidOptions = {}
): string {
  const requestedNow = options.now ?? Date.now();
  const now = Number.isFinite(requestedNow) ? requestedNow : Date.now();
  const data = collectBoardData(db, swarmId, { now });
  const required = ['agents', 'tasks', 'task_events', 'janitor_status'];
  const missing = required.filter(table => data.unavailable.includes(table));
  if (!db || missing.length > 0) return minimalBoardMermaid(swarmId, missing, now);

  const counters = data.debris.counters;
  const title = `Swarm ${data.swarm.name} · ${data.generatedAt} · ` +
    `${data.agents.length} agents · ${data.tasks.length} tasks · debris ` +
    `${counters.worktrees} worktrees/${counters.detachedHeads} detached/${counters.unpushedCommits} unpushed`;
  const lines = ['flowchart LR', `accTitle: ${mermaidLabel(title)}`];
  const agentIds = new Map<string, string>();
  const taskIds = new Map<string, string>();

  data.agents.forEach((agent, index) => {
    const id = `agent${index}`;
    agentIds.set(agent.name.toLowerCase(), id);
    lines.push(`${id}("${mermaidLabel(agent.name)}<br/>${mermaidLabel(agent.host)}"):::${hostClass(agent)}`);
  });

  data.tasks.forEach((task, index) => {
    const id = `task${index}`;
    taskIds.set(task.id, id);
    const checkpointText = task.checkpoint ? `ckpt ${task.checkpoint.ageMin}m` : 'no ckpt';
    lines.push(
      `${id}["${mermaidLabel(task.id)}<br/>[${mermaidLabel(task.state)}] · ${checkpointText}"]:::` +
      taskClass(task)
    );
  });

  let linkIndex = 0;
  for (const ownership of data.edges.ownership) {
    const agentId = agentIds.get(ownership.agent.toLowerCase());
    const taskId = taskIds.get(ownership.taskId);
    if (!agentId || !taskId) continue;
    lines.push(`${agentId} -->|owns| ${taskId}`);
    linkIndex += 1;
  }

  const appendAgentEdges = (
    edges: BoardData['edges']['handoffs'],
    label: string,
    styleIndexes: number[]
  ): void => {
    const seen = new Set<string>();
    for (const edge of edges) {
      const fromId = agentIds.get(edge.from.toLowerCase());
      const toId = agentIds.get(edge.to.toLowerCase());
      if (!fromId || !toId || fromId === toId) continue;
      const edgeKey = `${fromId}\u0000${toId}`;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);
      lines.push(`${fromId} -.->|${label}| ${toId}`);
      styleIndexes.push(linkIndex);
      linkIndex += 1;
    }
  };
  const handoffStyleIndexes: number[] = [];
  const claimStyleIndexes: number[] = [];
  appendAgentEdges(data.edges.handoffs, 'handoff', handoffStyleIndexes);
  appendAgentEdges(data.edges.claims, 'claimed', claimStyleIndexes);
  if (handoffStyleIndexes.length > 0) {
    lines.push(`linkStyle ${handoffStyleIndexes.join(',')} stroke-dasharray:8 4;`);
  }
  if (claimStyleIndexes.length > 0) {
    lines.push(`linkStyle ${claimStyleIndexes.join(',')} stroke-dasharray:2 3;`);
  }

  const heartbeatStale = data.debris.tickAgeMin === null ||
    data.debris.tickAgeMin * 60_000 > JANITOR_HEARTBEAT_STALE_MS;
  const hasDebris = [
    counters.worktrees,
    counters.detachedHeads,
    counters.orphanedWorktrees,
    counters.unpushedCommits,
    counters.goneUpstreamBranches,
    counters.tempStrays,
    counters.junkDirs,
  ].some(count => count > 0);
  const tickAge = data.debris.tickAgeMin === null ? 'never' : `${data.debris.tickAgeMin}m ago`;
  lines.push(
    `debris0["debris<br/>${counters.worktrees} worktrees (${counters.detachedHeads} detached)` +
    `<br/>${counters.unpushedCommits} unpushed<br/>tick ${tickAge}"]`
  );
  const debrisClasses = [hasDebris ? 'debrisWarn' : 'debrisOk'];
  if (heartbeatStale) debrisClasses.push('debrisStale');
  lines.push(`class debris0 ${debrisClasses.join(',')}`);

  if (data.agents.length === 0 && data.tasks.length === 0) {
    lines.push('idle["idle swarm"]:::note');
  }

  lines.push(...graphLegend(), ...graphClassDefinitions());
  return lines.join('\n');
}

function decodeMermaidEntities(value: string): string {
  return value
    .replace(/#quot;/g, '"')
    .replace(/#96;/g, '`')
    .replace(/#124;/g, '|')
    .replace(/#62;/g, '>')
    .replace(/#60;/g, '<')
    .replace(/#38;/g, '&')
    .replace(/#35;/g, '#');
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wrap Mermaid source without pre-rendering it, preserving an offline raw-source fallback. */
export function buildBoardHtml(mermaid: string, options: BoardHtmlOptions = {}): string {
  const titleLine = mermaid.split(/\r?\n/).find(line => line.startsWith('accTitle: '));
  const header = decodeMermaidEntities(titleLine?.slice('accTitle: '.length) ?? 'Swarm workflow graph');
  const refresh = options.watchSeconds === undefined
    ? ''
    : `  <meta http-equiv="refresh" content="${options.watchSeconds}">\n`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}  <title>${htmlEscape(header)}</title>
  <style>
    :root { color-scheme: light dark; --bg: #f8fafc; --fg: #172033; --muted: #64748b; --panel: #ffffff; }
    body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
    header { margin: 0 auto 18px; max-width: 1600px; }
    h1 { margin: 0; font-size: 17px; font-weight: 650; }
    p { margin: 4px 0 0; color: var(--muted); }
    .mermaid { box-sizing: border-box; max-width: 1600px; min-height: 160px; margin: 0 auto; overflow: auto; padding: 20px; border-radius: 12px; background: var(--panel); white-space: pre-wrap; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #0f172a; --fg: #e2e8f0; --muted: #94a3b8; --panel: #111827; }
    }
  </style>
</head>
<body>
  <header><h1>${htmlEscape(header)}</h1><p>Live ownership, handoffs, task state, and fleet debris</p></header>
  <pre class="mermaid">${mermaid}</pre>
  <script src="./board-assets/mermaid.min.js"></script>
  <script>
    try {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      mermaid.initialize({ startOnLoad: true, theme: dark ? 'dark' : 'default' });
    } catch (error) {
      console.warn('Mermaid unavailable; leaving raw diagram source visible.', error);
    }
  </script>
</body>
</html>
`;
}

function fileSha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copyBoardMermaidAsset(htmlDir: string): string {
  // Beside the HTML file, not a fixed ~/.swarm location: the generated page
  // references ./board-assets/ relative to itself, so a custom --out path must
  // get its own copy or the offline render silently loses mermaid.
  const assetsDir = path.join(htmlDir, 'board-assets');
  const destination = path.join(assetsDir, 'mermaid.min.js');
  fs.mkdirSync(assetsDir, { recursive: true });
  let unchanged = false;
  try {
    const sourceStat = fs.statSync(MERMAID_VENDOR_PATH);
    const destinationStat = fs.statSync(destination);
    unchanged = sourceStat.size === destinationStat.size &&
      fileSha256(MERMAID_VENDOR_PATH) === fileSha256(destination);
  } catch {
    unchanged = false;
  }
  if (!unchanged) fs.copyFileSync(MERMAID_VENDOR_PATH, destination);
  return destination;
}

export function writeBoardGraphFile(
  outputPath: string,
  mermaid: string,
  options: BoardGraphFileOptions = {}
): string {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  copyBoardMermaidAsset(path.dirname(resolved));
  fs.writeFileSync(resolved, buildBoardHtml(mermaid, options), 'utf-8');
  return resolved;
}

export function openBoardGraphFile(filePath: string): boolean {
  try {
    execFileSync('open', [filePath], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Prefer a cmux browser surface; when unavailable, use the best-effort macOS opener. */
export function openBoardGraphTab(
  filePath: string,
  options: BoardGraphTabOptions = {}
): { workspaceRef: string; surfaceRef: string } | null {
  const spawn = options.spawn ?? spawnBrowserWorkspace;
  const open = options.open ?? openBoardGraphFile;
  const writeError = options.writeError ?? (value => console.error(value));
  try {
    const result = spawn(
      options.cwd ?? process.cwd(),
      pathToFileURL(path.resolve(filePath)).href,
      'swarm graph'
    );
    if (result) return result;
  } catch {
    // The documented fallback below keeps graph output useful without cmux.
  }
  if (!open(filePath)) {
    writeError(`Could not open graph automatically; open ${path.resolve(filePath)} in a browser.`);
  } else {
    writeError('cmux browser unavailable; opened the graph with the system browser instead.');
  }
  return null;
}

/** Regenerate graph output until the injected exit condition fails. */
export async function watchBoardGraph(options: BoardGraphWatchOptions): Promise<number> {
  const intervalMs = options.intervalMs ?? BOARD_DEFAULT_WATCH_SECONDS * 1_000;
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const shouldContinue = options.shouldContinue ?? (() => true);
  let renderCount = 0;

  while (shouldContinue(renderCount)) {
    options.regenerate();
    renderCount += 1;
    if (!shouldContinue(renderCount)) break;
    await wait(intervalMs);
  }
  return renderCount;
}
