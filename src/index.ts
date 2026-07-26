import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { DEFAULT_SWARM_ID } from './db.js';
import { getDb, getDbReadOnly } from './db.js';
import {
  Agent,
  Swarm,
  clearActiveSwarmId,
  deleteSwarm,
  findSwarmForCwd,
  forceReap,
  getAgent,
  getAuthenticatedSelf,
  getOrCreateSwarm,
  getSelf,
  getSurfaceMarkerConflictWarning,
  getSwarm,
  getSwarmById,
  joinA2AAgent,
  joinAgent,
  joinHeadlessAgent,
  leaveA2AAgent,
  leaveAgent,
  leaveHeadlessAgent,
  listAgents,
  listAgentsSync,
  listSurfaceMemberships,
  listSwarms,
  reapAll,
  reapIfDead,
  refreshHostAcrossMemberships,
  listHeadlessMarkers,
  readActiveHeadlessSwarmId,
  readActiveSwarmId,
  setActiveHeadlessSwarm,
  touchSurfaceMemberships,
  updateHeartbeat,
  updateHostAgent,
  updateStatus,
  updateWorkspace,
  writeActiveSwarmId,
} from './registry.js';
import {
  acknowledgeAllMessages,
  acknowledgeMessages,
  broadcastMessage,
  countRecentMessages,
  getInbox,
  getRecentMessages,
  MESSAGE_KINDS,
  recordHookInjections,
  sendMessage,
  waitForInbox,
} from './mailbox.js';
import { getFleetStats, formatFleetStats } from './stats.js';
import { formatVersion } from './version.js';
import { redeliverPending, runRedeliverWorker, spawnRedeliverWorker, hasPendingRedeliveries } from './redeliver.js';
import {
  CMUX_LIVENESS_UNKNOWN_MESSAGE,
  identify,
  isCmuxObserverCompetent,
  listWorkspaces,
  moveSurface,
  readScreen,
  renameTab,
  renameWorkspace,
  sendToSurface,
  sleep,
  spawnSplitInWorkspace,
  spawnSurfaceInWorkspace,
  spawnWorkspace,
  type CmuxSplitDirection,
} from './transport.js';
import { installHook, removeHook, detectHost } from './hooks.js';
import { registerSurface, removeSurface, loadSurface as loadSurfaceForHook } from './applescript-transport.js';
import { ensureCodexTrust } from './codex-trust.js';
import { parseGlobalFlags } from './args.js';
import { assertNameNotReserved, assertNotModelName } from './reserved-names.js';
import { detectAdvertiseHost, startA2AServer } from './a2a-server.js';
import {
  checkpointTask,
  claimCloseRequirements,
  closeTask,
  effectiveClaimKind,
  getTask,
  getActiveTaskHookLines,
  handoffTask,
  reopenTask,
  recordDecision,
  runTaskCommand,
  startTask,
  type ClaimKind,
  type TaskDisposition,
} from './tasks.js';
import { listRescueArtifacts, rescueTargets, verifyRescueArtifact } from './rescue.js';
import {
  addJanitorRoot,
  formatJanitorHookLine,
  formatSwarmUpdateBanner,
  getJanitorStatus,
  getSwarmVersionCache,
  handleJoinUpdateAwareness,
  installJanitorLaunchAgent,
  readJanitorRoots,
  removeJanitorRoot,
  runJanitorTick,
  shouldSpawnJanitorTick,
  spawnJanitorTick,
  uninstallJanitorLaunchAgent,
} from './janitor.js';
import {
  BOARD_DEFAULT_WATCH_SECONDS,
  boardHasTable,
  buildBoardMermaid,
  openBoardGraphFile,
  openBoardGraphTab,
  renderBoard,
  resolveBoardWidth,
  spawnBoardTab,
  watchBoard,
  watchBoardGraph,
  writeBoardGraphFile,
} from './board.js';
import {
  boardServerUrl,
  openBoardServerTab,
  openBoardServerUrl,
  startBoardServer,
  waitForBoardServerStop,
} from './board-server.js';
import { createGrant, listGrants, revokeGrant } from './grants.js';
import { escalateTask } from './escalations.js';
import { agentModelFamily, MODEL_FAMILIES, parseModelFamily, requestTaskReview } from './reviews.js';
import { harnessReviewTask } from './harness-review.js';
import { renderAgentHelp } from './agent-help.js';

const rawArgs = process.argv.slice(2);

const parsed = parseGlobalFlags(rawArgs);
const args = parsed.args;
const command = args[0];
const explicitSwarmName = parsed.swarmName;

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function getRepeatedFlags(flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && index + 1 < args.length) values.push(args[index + 1]);
  }
  return values;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

// Resolve and validate the optional --kind flag. Unknown kinds are a usage error:
// a typo'd kind would store an unfilterable message and silently defeat --kind reads.
function requireValidKind(usage: string): string | undefined {
  if (!hasFlag('--kind')) return undefined;
  const kind = getFlag('--kind');
  if (!kind || !(MESSAGE_KINDS as readonly string[]).includes(kind)) {
    console.error(`Invalid --kind${kind ? ` "${kind}"` : ''}. Allowed: ${MESSAGE_KINDS.join(', ')}.`);
    console.error(usage);
    process.exit(1);
  }
  return kind;
}

function requireSupersedes(usage: string): number | undefined {
  if (!hasFlag('--supersedes')) return undefined;
  const raw = getFlag('--supersedes');
  if (!raw || !/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    console.error('Invalid --supersedes value. Message ID must be a positive integer.');
    console.error(usage);
    process.exit(1);
  }
  return Number(raw);
}

function requirePositiveIdFlag(flag: string, label: string, usage: string): number | undefined {
  if (!hasFlag(flag)) return undefined;
  const raw = getFlag(flag);
  if (!raw || !/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    console.error(`Invalid ${flag} value. ${label} must be a positive integer.`);
    console.error(usage);
    process.exit(1);
  }
  return Number(raw);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Quote only when the token needs it — model names are usually plain and
// quoting them garbles the typed TUI command shown to the operator.
function shellToken(value: string): string {
  return /^[A-Za-z0-9@%_+=:,./-]+$/.test(value) ? value : shellQuote(value);
}

function oneLineForCli(value: string, limit: number = 160): string {
  const flattened = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flattened.length <= limit ? flattened : `${flattened.slice(0, limit - 1)}\u2026`;
}

function resolveSelectedSwarm(db: ReturnType<typeof getDb>, create: boolean = false): Swarm {
  if (explicitSwarmName) {
    const existing = getSwarm(db, explicitSwarmName);
    if (existing) return existing;
    if (create) return getOrCreateSwarm(db, explicitSwarmName);
    throw new Error(`Swarm "${explicitSwarmName}" not found. Run "swarm create ${explicitSwarmName}" first.`);
  }

  if (process.env.SWARM_ID) {
    const byId = getSwarmById(db, process.env.SWARM_ID);
    if (byId) return byId;
  }

  if (process.env.SWARM_NAME) {
    const byName = getSwarm(db, process.env.SWARM_NAME);
    if (byName) return byName;
    if (create) return getOrCreateSwarm(db, process.env.SWARM_NAME);
  }

  const self = getSelf(db);
  if (self) {
    const swarm = getSwarmById(db, self.swarm_id);
    if (swarm) return swarm;
  }

  const cwdSwarm = findSwarmForCwd(db);
  if (cwdSwarm) return cwdSwarm;

  return getOrCreateSwarm(db);
}

function resolveSelectedSwarmReadOnly(db: NonNullable<ReturnType<typeof getDbReadOnly>>): Swarm {
  if (explicitSwarmName) {
    const swarm = getSwarm(db, explicitSwarmName);
    if (swarm) return swarm;
    throw new Error(`Swarm "${explicitSwarmName}" not found.`);
  }
  if (process.env.SWARM_ID) {
    const swarm = getSwarmById(db, process.env.SWARM_ID);
    if (swarm) return swarm;
  }
  if (process.env.SWARM_NAME) {
    const swarm = getSwarm(db, process.env.SWARM_NAME);
    if (swarm) return swarm;
  }
  const self = getSelf(db);
  if (self) {
    const swarm = getSwarmById(db, self.swarm_id);
    if (swarm) return swarm;
  }
  const cwdSwarm = findSwarmForCwd(db);
  if (cwdSwarm) return cwdSwarm;
  const fallback = getSwarmById(db, DEFAULT_SWARM_ID);
  if (fallback) return fallback;
  throw new Error('No swarm database state found. Run "swarm create <name>" first.');
}

function requireSelf(authenticate: boolean = false): { db: ReturnType<typeof getDb>; self: Agent; swarm: Swarm; surfaceId: string } {
  const db = getDb();
  const explicitSwarm = explicitSwarmName ? getSwarm(db, explicitSwarmName) : null;
  if (explicitSwarmName && !explicitSwarm) {
    console.error(`Error: Swarm "${explicitSwarmName}" not found.`);
    process.exit(1);
  }

  const self = authenticate
    ? getAuthenticatedSelf(db, explicitSwarm?.id)
    : getSelf(db, explicitSwarm?.id);
  if (!self) {
    const surfaceId = process.env.CMUX_SURFACE_ID;
    const agentName = process.env.SWARM_AGENT_NAME;
    const target = explicitSwarm ? ` "${explicitSwarm.name}"` : '';
    if (!surfaceId && !agentName) {
      console.error(`Error: Not in a swarm context${target}. Set CMUX_SURFACE_ID (Cmux) or join headless with "swarm join <name>".`);
    } else {
      console.error(`Error: Not joined to swarm${target}. Run "swarm join <name>${explicitSwarm ? ` --swarm ${explicitSwarm.name}` : ''}" first.`);
    }
    process.exit(1);
  }

  updateHeartbeat(db, self.swarm_id, self.surface_id);
  // Keep this surface's OTHER memberships alive too — the terminal being up is a fact
  // about the terminal, not about the swarm whose command happened to run.
  if (self.agent_type === 'cmux') touchSurfaceMemberships(db, self.surface_id);
  // Persist host harness when known so delivery can apply host-specific quirks
  // (e.g. Grok double-Enter). Refreshes existing sessions that joined before
  // host_agent was recorded.
  // Never stamp the CALLER's harness onto an A2A row. That row describes a remote agent;
  // a local process acting under its identity (SWARM_AGENT_NAME) is not that agent, and
  // writing host_agent here relabelled a declared-claude seat as codex — a WRONG family,
  // which approves, rather than an unknown one, which refuses.
  const host = self.agent_type === 'a2a' ? null : detectHost();
  if (host) {
    // Unconditional, NOT gated on `self.host_agent !== host`. The selected row being
    // current says nothing about its siblings, and "selected fresh, sibling stale" is
    // precisely the state every pre-fix version leaves behind — i.e. the upgrade state,
    // where the wrong-family sibling would never heal.
    refreshHostAcrossMemberships(db, self, host);
    self.host_agent = host;
  }
  const swarm = getSwarmById(db, self.swarm_id) ?? getOrCreateSwarm(db);
  return { db, self, swarm, surfaceId: self.surface_id };
}

function requireCmuxAgent(agent: { name: string; agent_type: string }, action: string): void {
  if (agent.agent_type === 'a2a') {
    console.error(`Cannot ${action} for A2A agent "${agent.name}". This command only works with Cmux/headless terminal agents.`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`swarm — Cross-terminal agent coordination via Cmux, headless, and A2A

Swarm Selection:
  --swarm <name>, -s <name>                       Run the command in a named swarm
  swarm use <swarm>                               Set which joined swarm unqualified
                                                    commands act on (this surface only)

Swarm Management:
  swarm create <name> [--root <path>]             Create or update a named swarm
    [--description <text>]
  swarm swarms                                    List known swarms
  swarm delete <name>                             Delete a non-default swarm

Agent Management:
  swarm join <name> [--description <text>]        Register in the selected swarm
    [--headless] [--push] [--force] [--force-surface]
    [--root <path>]                                  Force headless / Warp push / reclaim name /
                                                     take surface / set root
  swarm leave                                      Deregister from the current swarm
                                                     (one swarm only — other
                                                      memberships on this surface survive)
  swarm register-a2a <name> --endpoint <url>       Register an A2A agent
    [--description <text>] [--force]                 (--family declares the model family;
    [--family <claude|openai|xai|google>]             without it the agent counts as
                                                      UNKNOWN and cannot review
                                                      across families)
  swarm unregister-a2a <name>                      Remove an A2A agent
  swarm discover <url>                             Fetch and display an A2A agent card
  swarm serve [--name <agent>] [--port <n>]        Expose a local agent's inbox as an A2A
    [--bind <ip>] [--advertise <url>]                endpoint (cross-machine delivery);
    [--advertise-host <ip>] [--description <text>]   defaults: port 18790, bind 0.0.0.0,
                                                     advertise Tailscale IPv4 when present

Communication:
  swarm send <agent>[,<agent>...] <message>        Send message within the current swarm
    [--interject|--now]                              (comma-separated list sends to each);
    [--kind <kind>] [--supersedes <msg-id>]           Grok: force send-now (double Enter);
                                                     default single Enter queues mid-turn
  swarm broadcast <message>                        Send to all agents in the current swarm
    [--interject|--now] [--kind <kind>]              (kinds: status, digest, merge-req,
    [--supersedes <msg-id>]                           escalation, ack, gate, handoff)
  swarm inbox [--peek|--unread|--recent [N]]       Read pending messages
    [--wait <seconds>]
    [--kind <kind>]                                  (--unread is an alias; --peek does not advance cursor;
                                                      --recent N replays last N regardless of cursor;
                                                      --kind filters and never advances the cursor)
  swarm ack <msg-id...> | --all                    Acknowledge messages explicitly
  swarm redeliver [--dry-run]                      Re-push queued messages recipients haven't seen

Task Ledger:
  swarm task start <slug> --title <text>           Create or claim a fenced task lease
    [--repo <path>] [--no-worktree] [--takeover] [--claim <kind>]
  swarm task checkpoint <slug> [--notes <text>]    Record a numbered checkpoint; --notes puts
                                                     text under decisions and fills other
                                                     narrative sections with "- none noted"
  swarm task close <slug> --disposition <kind>     Close with pr|merged|archive|discard evidence
    --not-established <text> [--evidence <kind>:<ref>] [--outcome inconclusive]
    [--force-discard] [--override --reason <text>]
  swarm task reopen <slug> --reason <text>         Reactivate done/abandoned work
    [--takeover]
  swarm run [--task <slug>] -- <cmd> [args...]     Capture full output as task evidence
  swarm grant create --op <op> --resource <r>      Create a scoped, expiring grant
    --ttl <30m|2h|1d> [--to <agent>] [--note <t>]
  swarm grant list [--live]                        List grants
  swarm grant revoke <id>                          Revoke a grant
  swarm escalate <slug> [--question <text>]        Write and send a decision-ready packet
    [--to <agent>]
  swarm review <slug> [--to <agent>]               Route an inverted-family review request
    [--same-family-ok --reason <text>]
  swarm task list                                  List the durable task ledger
  swarm task show <slug>                           Show one task with events and decisions
  swarm handoff <slug> --to <agent> [--stale-ok]   Transfer authority with a checkpoint pointer
  swarm decision <text> [--task <slug>]            Record a durable decision
    [--supersedes <decision-id>]
  swarm harness-review <slug>                      Review the full task handoff timeline
  swarm rescue --worktree <path> | --task <slug>   Create and verify preservation artifacts
    | --agent <name>
  swarm rescue --list                              List rescue manifests and verification state
                                                     (plain files under ~/.swarm/archive/rescue/;
                                                     existing rsync may copy them off-host)

Janitor (observe-only in v1):
  swarm janitor tick --observe                    Run the read-only debris census
  swarm janitor roots list                        List census roots
  swarm janitor roots add|remove <path>           Manage census roots
  swarm janitor install|uninstall                 Manage the 15-minute launchd schedule

Status:
  swarm version [--check]                          Show build (and compare to origin/master)
  swarm board [--watch [N]] [--tab] [--width N]   Render fleet state or split it beside you
    [--own-workspace]                                (--own-workspace creates the named program workspace)
  swarm board --graph [--out <path>] [--open]     Write and print a Mermaid workflow graph
    [--watch [N]] [--tab]                           (--tab: browser pane, workspace fallback, then open)
  swarm board --serve [--port N]                  Serve the live graph on loopback (default 7787)
    [--tab | --open | --print-url]                   (foreground; Ctrl-C stops)
  swarm members                                    List agents in the current swarm
  swarm status [--set <desc>] [--agent <name>]     Update or query status
  swarm whoami                                     Show own registration
  swarm stats [--hours <N>]                        Fleet messaging metrics (default 24h):
                                                     direct/broadcast split, est. reads,
                                                     ack ratio, per-agent traffic, top pairs

Local Agents:
  swarm spawn [--cwd <path>]                       Spawn an agent in a new tab (permission
    [--interactive-permissions]                      dialogs SKIPPED by default — unattended
                                                     workers can't click "allow"; this flag
                                                     restores dialogs)
    [--agent claude|codex|grok|gemini] [--name <name>]
    [--model <model>]                                (claude defaults to opus — Fable is
                                                      never a default, always an explicit
                                                      --model choice; other CLIs use their
                                                      own default unless --model is given)
    [--split [left|right|up|down] | --new-workspace <name>]
    [--terminal auto|cmux|warp]                      (default: auto; permissive adds
                                                      --dangerously-skip-permissions for claude,
                                                      --yolo for codex/gemini, --always-approve
                                                      for grok)

Cmux-only:
  swarm read <agent> [--lines <n>]                 Read agent's terminal
  swarm rename <agent> <title>                     Rename an agent's Cmux tab
  swarm move <agent> --workspace <id>              Move agent to another workspace
  swarm workspaces                                 List Cmux workspaces
  swarm rename-workspace <id> <title>              Rename a workspace

Admin:
  swarm reap [--name <agent>] [--force] [--all]    Prune dead agents after liveness probe
  swarm reset [--all]                              Clear current swarm, or all swarms
  swarm help                                       Show this help
  swarm help --agent                               Show the compact agent catalog`);
}

function safeOscTitlePart(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, '_');
}

function writeWarpOscTitle(surface: { ttyDevice?: string }, swarmName: string, agentName: string): void {
  if (!surface.ttyDevice) return;
  const title = `swarm/${safeOscTitlePart(swarmName)}/${safeOscTitlePart(agentName)}`;
  try {
    fs.writeFileSync(surface.ttyDevice, `\x1b]0;${title}\x07`);
  } catch (err: any) {
    if (err?.code !== 'EACCES' && err?.code !== 'ENOENT') {
      console.warn(`Warning: Could not set Warp tab title for accessibility targeting: ${err.message}`);
    }
  }
}

function joinAsHeadless(db: ReturnType<typeof getDb>, swarm: Swarm, name: string, description?: string, pushEnabled?: boolean): void {
  const host = detectHost();
  const agent = joinHeadlessAgent(db, swarm.id, name, description, { trackSession: true, hostAgent: host });
  const parts: string[] = [`swarm: ${swarm.name}`, 'headless'];

  const surface = registerSurface(swarm.id, name, pushEnabled);
  if (surface) {
    if (surface.app === 'Warp') {
      parts.push(surface.pushEnabled ? 'Warp push' : 'Warp inbox');
      writeWarpOscTitle(surface, swarm.name, name);
    } else {
      parts.push(`${surface.app} push`);
    }
  }

  if (host) {
    installHook(host, name, swarm.id, swarm.name);
    parts.push(`${host} hook`);
  }

  console.log(`Joined swarm "${swarm.name}" as "${agent.name}" (${parts.join(', ')})`);
  if (!surface && !host) {
    console.log('Tip: Run "swarm inbox" periodically to check for messages.');
  }
}

// Headless registrations can't be liveness-probed (no surface to ping) and are orphaned by
// a session resume (the controlling TTY changes, so the per-TTY identity marker no longer
// resolves) — leaving the name registered but un-reclaimable, and blocking re-join under the
// same name. Reclaiming a headless name lets the agent re-attach, but because we can't tell a
// dead orphan from a busy-but-live agent (the heartbeat only refreshes on a prompt turn, not
// during a long autonomous task), reclaiming ALWAYS requires explicit --force. That way a
// same-name join from a different session can never silently knock out an active agent.
function reclaimHeadlessNameOrExit(
  db: ReturnType<typeof getDb>,
  swarm: Swarm,
  existing: Agent | null,
  force: boolean
): void {
  if (!existing || existing.agent_type !== 'headless') return;

  if (!force) {
    const mins = Math.max(1, Math.round((Date.now() - new Date(existing.last_heartbeat).getTime()) / 60000));
    console.error(`Agent "${existing.name}" is already held by a headless agent (last active ~${mins} min ago). If this is your prior session (e.g. you resumed into Cmux) or you are sure it is gone, re-run with --force to reclaim the name; otherwise choose a different name.`);
    process.exit(1);
  }

  forceReap(db, swarm.id, existing.name);
  removeSurface(swarm.id, existing.name);
  const priorHost = detectHost();
  if (priorHost) removeHook(priorHost, existing.name, swarm.id);
  console.log(`Reclaimed headless registration "${existing.name}" from a prior session.`);
}

function swarmNameFor(db: ReturnType<typeof getDb>, swarmId: string): string {
  return getSwarmById(db, swarmId)?.name ?? swarmId;
}

/**
 * This TTY's headless memberships, validated against live rows.
 *
 * Markers are per-TTY, so ALL of them belong to this session — never filter by the
 * active name, because each membership may use a different one. Each is then checked
 * against the database: `swarm reset`/`delete` removes rows without touching markers, so
 * a raw marker list would report a deleted swarm as a live membership.
 */
function headlessMemberships(
  db: ReturnType<typeof getDb>
): Array<{ swarm_id: string; name: string }> {
  return listHeadlessMarkers()
    .filter(marker => getAgent(db, marker.swarm_id, marker.agent_name)?.agent_type === 'headless')
    .map(marker => ({ swarm_id: marker.swarm_id, name: marker.agent_name }));
}

/**
 * `--swarm` selects a swarm only BEFORE the message; inside a command's free-text tail
 * (see FREE_TEXT_TAIL_AT) it is literal text. Now that one terminal can sit in several
 * swarms, a trailing selector delivers to the DEFAULT swarm while looking like it was
 * routed — a silent misroute. Shared by `send` and `broadcast`: broadcast is the more
 * dangerous of the two, because every recipient is then in the wrong swarm.
 */
function refuseTrailingSelector(
  db: ReturnType<typeof getDb>,
  currentSwarmId: string,
  message: string,
  commandHint: string
): void {
  // Matched ANYWHERE in the body, not just at the end. End-anchoring caught
  // `send Bob --swarm docs` but missed the more natural `send Bob --swarm docs hello`,
  // which sailed through to the default swarm — the same silent misroute, one word later.
  // `-s` is the advertised alias and parseGlobalFlags honours it before the free-text
  // boundary, so it is the same trap.
  const match = /(?:^|\s)(?:--swarm[=\s]+|-s\s+)([^\s]+)/.exec(message);
  if (!match) return;
  const target = match[1];

  // Refuse on SYNTAX, not on whether the named swarm happens to exist. Checking the DB
  // meant a typo ("--swarm dcos") sailed through and landed in the default swarm — the
  // very outcome this prevents — and made identical argv safe or unsafe depending on
  // current DB contents.
  const named = getSwarm(db, target);
  const current = swarmNameFor(db, currentSwarmId);
  const detail = !named
    ? `no swarm named "${target}" exists`
    : named.id === currentSwarmId
      ? `"${target}" is already the current swarm`
      : `this would have gone to "${current}" instead of "${target}"`;
  console.error(
    `Refusing: "${match[0].trim()}" appears inside the message, where it is literal text ` +
    `rather than a swarm selector — ${detail}. ` +
    `Put the selector before the subcommand: swarm --swarm ${target} ${commandHint} "<message>". ` +
    `If you really meant to send those words, reword them — a selector-shaped token in the ` +
    `body is refused rather than delivered somewhere you did not choose.`
  );
  process.exit(1);
}

function printHookContext(): void {
  const { db, self, swarm } = requireSelf();

  // Re-emit the Warp OSC tab title so that agents like Claude Code,
  // which set their own title on startup/activity, can't permanently
  // shadow the swarm/<swarm>/<agent> marker we use for accessibility
  // tab targeting (Phase 4). The hook fires on every UserPromptSubmit,
  // so the title is refreshed on each turn.
  if (self.agent_type === 'headless') {
    const surface = loadSurfaceForHook(self.swarm_id, self.name);
    if (surface && surface.app === 'Warp') {
      writeWarpOscTitle(surface, swarm.name, self.name);
    }
  }

  const agents = listAgentsSync(db, self.swarm_id);
  const members = agents.map(agent => agent.name).join(', ');
  const inbox = getInbox(db, self.swarm_id, self.name, true);
  const injected = recordHookInjections(db, self.swarm_id, self.name, inbox);
  const inboxSection = injected.length === 0
    ? ''
    : `\nNEW MESSAGES (respond to these):\n${injected.map(entry => {
      const { message: msg } = entry;
      if (entry.collapsed) {
        return `(#${msg.id} from ${msg.from_agent}, unacked for ${entry.unackedMinutes}m — swarm inbox --recent to review, swarm ack ${msg.id} to clear)`;
      }
      const time = new Date(msg.created_at).toLocaleTimeString();
      return `[#${msg.id} ${time}] ${msg.kind ? `[${msg.kind}] ` : ''}${msg.from_agent}: ${msg.body}`;
    }).join('\n')}`;
  const taskLines = getActiveTaskHookLines(db, self.swarm_id, self.name);
  const taskSection = taskLines.length ? `\n${taskLines.join('\n')}` : '';
  const janitorStatus = getJanitorStatus(db);
  const janitorSection = janitorStatus ? `\n${formatJanitorHookLine(janitorStatus)}` : '';
  const updateBanner = formatSwarmUpdateBanner(getSwarmVersionCache(db));
  const updateSection = updateBanner ? `\n${updateBanner}` : '';

  // A surface can hold memberships in several swarms. Only one is "active", but a
  // message waiting in any of the others is just as real — and invisible unless it
  // is pulled in here, because nothing else polls them. Silence in a joined swarm
  // must never be an artefact of which swarm happens to be selected.
  // Headless sessions can hold memberships in several swarms too (their markers are
  // per-TTY-per-swarm), and nothing else polls the ones that are not active — so leaving
  // them out here recreated, for headless, exactly the invisible-message failure this
  // aggregation exists to prevent.
  const otherMemberships: Array<{ swarm_id: string; name: string }> = self.agent_type === 'cmux'
    ? listSurfaceMemberships(db, self.surface_id)
    : headlessMemberships(db);

  const otherSection = self.agent_type !== 'a2a'
    ? otherMemberships
      .filter(m => m.swarm_id !== self.swarm_id)
      .map(m => {
        const otherSwarm = getSwarmById(db, m.swarm_id);
        const otherName = otherSwarm?.name ?? m.swarm_id;
        const pending = getInbox(db, m.swarm_id, m.name, true);
        const injected = recordHookInjections(db, m.swarm_id, m.name, pending);
        if (injected.length === 0) return '';
        const lines = injected.map(entry => {
          const { message: msg } = entry;
          if (entry.collapsed) {
            // Name the command that actually clears it: --recent is a replay that never
            // advances delivery state, so omitting ack leaves the line nagging forever.
            return `(#${msg.id} from ${msg.from_agent}, unacked for ${entry.unackedMinutes}m — swarm inbox --recent --swarm ${otherName} to review, swarm ack ${msg.id} --swarm ${otherName} to clear)`;
          }
          const time = new Date(msg.created_at).toLocaleTimeString();
          return `[#${msg.id} ${time}] ${msg.kind ? `[${msg.kind}] ` : ''}${msg.from_agent}: ${msg.body}`;
        });
        // Selector goes BEFORE `send` — after the message it is literal text.
        return `\nNEW MESSAGES in swarm "${otherName}" (you are "${m.name}" there; reply with: swarm --swarm ${otherName} send <agent> "<msg>"):\n${lines.join('\n')}`;
      })
      .join('')
    : '';

  const readCommand = self.agent_type === 'a2a' ? '' : ' | read <agent> --lines 20';
  console.log(`You are "${self.name}" in swarm "${swarm.name}". Active agents: ${members || '(none)'}.
Commands: swarm send <agent> "<msg>" | inbox [--wait N] | members | status --set "<desc>" | task start/checkpoint/close | board --tab${readCommand} | help --agent (full map)
When you see [SWARM from <name>]: treat it as a message from another agent and respond.
[SWARM from <name> in <swarm>] came from another swarm — reply with: swarm --swarm <swarm> send <name> "<msg>" (selector BEFORE send).${taskSection}${janitorSection}${updateSection}${inboxSection}${otherSection}`);

  // Opportunistic recovery: if some OTHER agent has a fresh, unseen, push-failed
  // message, kick a detached retry worker. One indexed SELECT when idle, so this
  // adds no meaningful latency to the prompt hook.
  if (hasPendingRedeliveries(db)) spawnRedeliverWorker();
  if (shouldSpawnJanitorTick(janitorStatus)) spawnJanitorTick();
}

async function main() {
  try {
    switch (command) {
      case 'create': {
        const name = args[1];
        if (!name) {
          console.error('Usage: swarm create <name> [--root <path>] [--description <text>]');
          process.exit(1);
        }
        const db = getDb();
        const swarm = getOrCreateSwarm(db, name, getFlag('--root'), getFlag('--description'));
        console.log(`Swarm "${swarm.name}" ready${swarm.root_path ? ` (root: ${swarm.root_path})` : ''}.`);
        break;
      }

      case 'swarms': {
        const db = getDb();
        const current = getSelf(db);
        const swarms = listSwarms(db);
        for (const swarm of swarms) {
          const marker = current?.swarm_id === swarm.id ? ' (current)' : '';
          const root = swarm.root_path ? ` — ${swarm.root_path}` : '';
          console.log(`  ${swarm.name}${marker}${root}`);
        }
        console.log(`\n${swarms.length} swarm(s)`);
        break;
      }

      case 'delete': {
        const name = args[1];
        if (!name) {
          console.error('Usage: swarm delete <name>');
          process.exit(1);
        }
        const db = getDb();
        const swarm = deleteSwarm(db, name);
        if (!swarm) {
          console.error(`Swarm "${name}" not found.`);
          process.exit(1);
        }
        console.log(`Deleted swarm "${swarm.name}".`);
        break;
      }

      case 'join': {
        const name = args[1];
        if (!name) {
          console.error('Usage: swarm join <name> [--description <text>] [--headless] [--push] [--force] [--force-surface] [--swarm <name>]');
          process.exit(1);
        }
        try {
          // Machine-local reserved list (~/.swarm/reserved-names) — never baked into the repo.
          assertNameNotReserved(name);
        } catch (err: any) {
          console.error(err.message);
          process.exit(1);
        }
        const headless = hasFlag('--headless');
        const pushEnabled = hasFlag('--push');
        const force = hasFlag('--force');
        const forceSurface = hasFlag('--force-surface');
        if (headless && forceSurface) {
          console.error('--force-surface requires a resolved Cmux surface; remove --headless or use --force to reclaim a headless name.');
          process.exit(1);
        }
        const description = getFlag('--description');
        const db = getDb();
        const swarm = explicitSwarmName
          ? getOrCreateSwarm(db, explicitSwarmName, getFlag('--root'))
          : resolveSelectedSwarm(db, true);

        const identityWarning = getSurfaceMarkerConflictWarning(db, swarm.id);
        if (identityWarning) console.warn(`Warning: ${identityWarning}.`);

        const priorRegistration = getAgent(db, swarm.id, name);
        if (priorRegistration && priorRegistration.agent_type !== 'headless' && !isCmuxObserverCompetent()) {
          console.warn(CMUX_LIVENESS_UNKNOWN_MESSAGE);
        }

        const reaped = await reapIfDead(db, swarm.id, name);
        if (reaped) {
          console.log(`Reaped stale "${reaped.name}" (${reaped.agent_type}) from swarm "${swarm.name}" — surface was dead.`);
        }

        const existing = getAgent(db, swarm.id, name);
        if (existing && existing.agent_type === 'a2a') {
          console.error(`Agent "${name}" is already registered as a live A2A agent in swarm "${swarm.name}". Choose a different name or run "swarm unregister-a2a ${name} --swarm ${swarm.name}" first.`);
          process.exit(1);
        }

        reclaimHeadlessNameOrExit(db, swarm, existing, force);

        if (headless) {
          joinAsHeadless(db, swarm, name, description, pushEnabled);
        } else {
          const { surfaceId, workspaceId } = identify();
          if (!surfaceId) {
            if (forceSurface) {
              console.error('--force-surface requires CMUX_SURFACE_ID to resolve; child or scripted processes should join with --headless.');
              process.exit(1);
            }
            joinAsHeadless(db, swarm, name, description, pushEnabled);
          } else {
            const host = detectHost();
            const agent = joinAgent(
              db, swarm.id, name, surfaceId, workspaceId, process.ppid,
              description, 'cmux', undefined, host, undefined, { forceSurface }
            );
            if (agent.surface_takeover) {
              console.warn(
                `SURFACE TAKEOVER: "${name}" replaced "${agent.surface_takeover.prior_name}" ` +
                `on Cmux surface "${agent.surface_takeover.surface_id}" via --force-surface.`
              );
            }
            // The swarm just joined becomes the default for unqualified commands.
            writeActiveSwarmId(surfaceId, swarm.id);
            renameTab(surfaceId, `${swarm.name}/${name}`, workspaceId);
            // Refresh host session files (critical for Codex: stale
            // ~/.codex/swarm-session.md otherwise points at a previous agent name).
            if (host) {
              try { installHook(host, name, swarm.id, swarm.name); } catch { /* non-fatal */ }
            }
            const hostLabel = host ? ` [${host}]` : '';
            console.log(`Joined swarm "${swarm.name}" as "${agent.name}" (surface: ${agent.surface_id})${hostLabel}`);
            // Joining no longer removes this surface from its other swarms, so say
            // plainly which one plain commands will now act on.
            const others = listSurfaceMemberships(db, surfaceId).filter(m => m.swarm_id !== swarm.id);
            if (others.length > 0) {
              const names = others
                .map(m => `${getSwarmById(db, m.swarm_id)?.name ?? m.swarm_id} (as ${m.name})`)
                .join(', ');
              console.log(
                `Still a member of: ${names}. Commands without --swarm act on "${swarm.name}"; ` +
                `switch the default with "swarm use <swarm>".`
              );
            }
          }
        }
        handleJoinUpdateAwareness(db);
        break;
      }

      case 'leave': {
        const { db, self, swarm } = requireSelf();
        if (self.agent_type === 'headless') {
          leaveHeadlessAgent(db, self.swarm_id, self.name, { trackSession: true });
          removeSurface(self.swarm_id, self.name);
          const host = detectHost();
          if (host) {
            removeHook(host, self.name, self.swarm_id);
          }
        } else {
          leaveAgent(db, self.swarm_id, self.surface_id);
          clearActiveSwarmId(self.surface_id, self.swarm_id);
        }
        console.log(`Left swarm "${swarm.name}" (was "${self.name}")`);
        // Leaving is scoped to one swarm. Name what survives, and re-point the default
        // ONLY if it was the swarm just left — `swarm leave --swarm <other>` must not
        // move a default the agent chose deliberately with `swarm use`.
        if (self.agent_type !== 'headless') {
          const remaining = listSurfaceMemberships(db, self.surface_id);
          if (remaining.length > 0) {
            const stillPointed = readActiveSwarmId(self.surface_id);
            const pointerIsLive = stillPointed !== null
              && remaining.some(m => m.swarm_id === stillPointed);
            if (!pointerIsLive) {
              const next = remaining[remaining.length - 1];
              const nextSwarm = getSwarmById(db, next.swarm_id);
              writeActiveSwarmId(self.surface_id, next.swarm_id);
              console.log(
                `Still a member of ${remaining.length} swarm(s); ` +
                `commands without --swarm now act on "${nextSwarm?.name ?? next.swarm_id}" (as ${next.name}).`
              );
            } else {
              const kept = remaining.find(m => m.swarm_id === stillPointed)!;
              const keptSwarm = getSwarmById(db, kept.swarm_id);
              console.log(
                `Still a member of ${remaining.length} swarm(s); ` +
                `commands without --swarm still act on "${keptSwarm?.name ?? kept.swarm_id}" (as ${kept.name}).`
              );
            }
          }
        }
        break;
      }

      case 'register-a2a': {
        const name = args[1];
        const endpoint = getFlag('--endpoint');
        if (!name || !endpoint) {
          console.error('Usage: swarm register-a2a <name> --endpoint <url> [--description <text>] [--force] [--swarm <name>]');
          process.exit(1);
        }
        // Model-name policy applies to A2A identities too, but NOT the machine-local
        // reserved list — that list exists to hold names FOR remote A2A identities
        // (see reserved-names.ts), so registration is how a reserved name gets claimed.
        assertNotModelName(name);

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(endpoint);
        } catch {
          console.error(`Invalid endpoint URL: "${endpoint}". Must be a valid URL (e.g., http://localhost:18789).`);
          process.exit(1);
        }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          console.error(`Unsupported protocol "${parsedUrl.protocol}". Endpoint must use http:// or https://.`);
          process.exit(1);
        }

        let agentDescription = getFlag('--description');
        let reachable = false;
        try {
          const resp = await fetch(`${endpoint}/.well-known/agent-card.json`, {
            signal: AbortSignal.timeout(5000),
          });
          reachable = true;
          if (resp.ok && !agentDescription) {
            const card = await resp.json() as { description?: string };
            agentDescription = card.description;
          }
        } catch {
          try {
            await fetch(endpoint, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
            reachable = true;
          } catch {
            // Endpoint not reachable
          }
        }
        if (!reachable) {
          console.warn(`Warning: endpoint ${endpoint} is not reachable. Registering anyway.`);
        }

        const db = getDb();
        const swarm = resolveSelectedSwarm(db, true);
        const priorRegistration = getAgent(db, swarm.id, name);
        if (priorRegistration && priorRegistration.agent_type !== 'headless' && !isCmuxObserverCompetent()) {
          console.warn(CMUX_LIVENESS_UNKNOWN_MESSAGE);
        }
        const reaped = await reapIfDead(db, swarm.id, name);
        if (reaped) {
          console.log(`Reaped stale "${reaped.name}" (${reaped.agent_type}) from swarm "${swarm.name}" — surface was dead.`);
        }
        reclaimHeadlessNameOrExit(db, swarm, getAgent(db, swarm.id, name), hasFlag('--force'));
        // Declared family: an A2A agent has no inspectable harness, so without this it
        // stays UNKNOWN and cannot serve as a cross-family reviewer.
        const familyFlag = getFlag('--family');
        if (familyFlag && !parseModelFamily(familyFlag)) {
          console.error(`Invalid --family "${familyFlag}". Expected one of: ${MODEL_FAMILIES.join(', ')}.`);
          process.exit(1);
        }
        const agent = joinA2AAgent(db, swarm.id, name, endpoint, agentDescription, parseModelFamily(familyFlag));
        // Warn on the RESULT, not on the flag: a re-registration without --family keeps
        // any previous declaration, and warning there would report a demotion that did
        // not happen.
        if (agentModelFamily(agent) === 'unknown') {
          console.warn(
            `Note: "${name}" has no declared model family, so it does NOT count as a cross-family reviewer. ` +
            `Re-register with --family <${MODEL_FAMILIES.join('|')}> --force to declare it.`
          );
        }
        console.log(`Registered A2A agent "${agent.name}" in swarm "${swarm.name}" @ ${endpoint}`);
        break;
      }

      case 'unregister-a2a': {
        const name = args[1];
        if (!name) {
          console.error('Usage: swarm unregister-a2a <name> [--swarm <name>]');
          process.exit(1);
        }
        const db = getDb();
        const swarm = resolveSelectedSwarm(db);
        const removed = leaveA2AAgent(db, swarm.id, name);
        if (removed) {
          console.log(`Removed A2A agent "${name}" from swarm "${swarm.name}"`);
        } else {
          console.error(`A2A agent "${name}" not found in swarm "${swarm.name}".`);
          process.exit(1);
        }
        break;
      }

      case 'discover': {
        const url = args[1];
        if (!url) {
          console.error('Usage: swarm discover <url>');
          process.exit(1);
        }
        try {
          const resp = await fetch(`${url}/.well-known/agent-card.json`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!resp.ok) {
            console.error(`Agent card not found at ${url} (HTTP ${resp.status})`);
            process.exit(1);
          }
          const card = await resp.json();
          console.log(JSON.stringify(card, null, 2));
        } catch (err: any) {
          console.error(`Failed to fetch agent card: ${err.message}`);
          process.exit(1);
        }
        break;
      }

      case 'serve': {
        const db = getDb();
        let name = getFlag('--name');
        let swarm: Swarm;
        if (name) {
          swarm = resolveSelectedSwarm(db);
        } else {
          const ctx = requireSelf();
          name = ctx.self.name;
          swarm = ctx.swarm;
        }
        if (!getAgent(db, swarm.id, name)) {
          console.warn(`Warning: no agent named "${name}" in swarm "${swarm.name}" — incoming messages will queue in the inbox anyway, but join first so you can read them as yourself.`);
        }
        const port = parseInt(getFlag('--port') ?? '18790', 10);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          console.error(`Invalid --port: ${getFlag('--port')}`);
          process.exit(1);
        }
        const bind = getFlag('--bind') ?? '0.0.0.0';
        const advertiseHost = getFlag('--advertise-host') ?? detectAdvertiseHost();
        const advertiseUrl = getFlag('--advertise') ?? `http://${advertiseHost}:${port}/`;
        await startA2AServer({
          db,
          swarmId: swarm.id,
          swarmName: swarm.name,
          agentName: name,
          port,
          bind,
          advertiseUrl,
          description: getFlag('--description'),
        });
        console.log(`A2A server for "${name}" (swarm "${swarm.name}") listening on ${bind}:${port}`);
        console.log(`Agent card: ${advertiseUrl.replace(/\/$/, '')}/.well-known/agent-card.json`);
        console.log(`Register from a remote machine with:`);
        console.log(`  swarm register-a2a ${name} --endpoint ${advertiseUrl.replace(/\/$/, '')}`);
        // Keep serving until killed.
        await new Promise(() => {});
        break;
      }

      case 'send': {
        const { db, self } = requireSelf(true);
        const usage = 'Usage: swarm send <agent>[,<agent>...] <message> [--interject|--now] [--kind <kind>] [--supersedes <msg-id>]';
        // Flags may appear anywhere before/among free-text; strip them from the body.
        const interject = hasFlag('--interject') || hasFlag('--now');
        const kind = requireValidKind(usage);
        const supersedes = requireSupersedes(usage);
        const rest = args.slice(1);
        const tokens: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--interject' || rest[i] === '--now') continue;
          if (rest[i] === '--kind' || rest[i] === '--supersedes') { i++; continue; }
          tokens.push(rest[i]);
        }
        const targetName = tokens[0];
        const message = tokens.slice(1).join(' ');
        if (!targetName || !message) {
          console.error(usage);
          process.exit(1);
        }
        // Comma-separated multi-recipient: trim, drop empties, dedupe case-insensitively
        // (getAgent resolves names case-insensitively, so "bob" and "Bob" are one target).
        const recipients: string[] = [];
        const seen = new Set<string>();
        for (const raw of targetName.split(',')) {
          const name = raw.trim();
          if (!name || seen.has(name.toLowerCase())) continue;
          seen.add(name.toLowerCase());
          recipients.push(name);
        }
        if (recipients.length === 0) {
          console.error(usage);
          process.exit(1);
        }
        if (supersedes !== undefined && recipients.length !== 1) {
          console.error('--supersedes requires exactly one recipient so the replaced message has one successor.');
          console.error(usage);
          process.exit(1);
        }
        refuseTrailingSelector(db, self.swarm_id, message, `send ${recipients.join(',')}`);

        // Attempt every recipient even after a failure; exit nonzero if ANY failed.
        let anyFailed = false;
        let anyQueued = false;
        for (const recipient of recipients) {
          if (recipient.toLowerCase() === self.name.toLowerCase()) {
            console.error('Cannot send a message to yourself.');
            anyFailed = true;
            continue;
          }
          const result = await sendMessage(db, self.swarm_id, self.name, recipient, message, { interject }, kind, supersedes);
          console.log(result.message);
          if (!result.delivered && !result.queued) anyFailed = true;
          if (result.queued) anyQueued = true;
        }
        // Push failed → the recipient may be idle with no upcoming turn to poll
        // the inbox. A detached worker retries the push on a backoff schedule.
        if (anyQueued) spawnRedeliverWorker();
        if (anyFailed) process.exit(1);
        break;
      }

      case 'broadcast': {
        const { db, self } = requireSelf(true);
        const usage = 'Usage: swarm broadcast <message> [--interject|--now] [--kind <kind>] [--supersedes <msg-id>]';
        const interject = hasFlag('--interject') || hasFlag('--now');
        const kind = requireValidKind(usage);
        const supersedes = requireSupersedes(usage);
        const rest = args.slice(1);
        const tokens: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--interject' || rest[i] === '--now') continue;
          if (rest[i] === '--kind' || rest[i] === '--supersedes') { i++; continue; }
          tokens.push(rest[i]);
        }
        const message = tokens.join(' ');
        refuseTrailingSelector(db, self.swarm_id, message, 'broadcast');
        if (!message) {
          console.error(usage);
          process.exit(1);
        }
        const result = await broadcastMessage(db, self.swarm_id, self.name, message, { interject }, kind, supersedes);
        const reached = result.sent + result.queued;
        let line = `Broadcast to ${reached} agent(s)`;
        if (result.queued > 0) line += ` (${result.queued} via inbox)`;
        if (result.failed > 0) line += `, ${result.failed} failed`;
        console.log(line);
        // Note: broadcast rows (to_agent NULL) are not retried per-recipient —
        // but a direct-message backlog may exist; sweep it while we're here.
        if (result.queued > 0 && hasPendingRedeliveries(db)) spawnRedeliverWorker();
        break;
      }

      case 'ack': {
        const { db, self } = requireSelf(true);
        const all = hasFlag('--all');
        const rawIds = args.slice(1).filter(arg => arg !== '--all');
        if ((all && rawIds.length > 0) || (!all && rawIds.length === 0)) {
          console.error('Usage: swarm ack <msg-id...> | --all');
          process.exit(1);
        }
        const ids = rawIds.map(raw => Number(raw));
        if (ids.some((id, index) => !/^\d+$/.test(rawIds[index]) || id <= 0 || !Number.isSafeInteger(id))) {
          console.error('Message IDs must be positive integers.');
          console.error('Usage: swarm ack <msg-id...> | --all');
          process.exit(1);
        }
        const acknowledged = all
          ? acknowledgeAllMessages(db, self.swarm_id, self.name)
          : acknowledgeMessages(db, self.swarm_id, self.name, ids);
        if (acknowledged.length === 0) {
          console.log('No messages to acknowledge.');
        } else {
          console.log(`Acknowledged ${acknowledged.length} message(s): ${acknowledged.map(id => `#${id}`).join(', ')}`);
        }
        break;
      }

      case 'task': {
        const subcommand = args[1];
        const slug = args[2];
        if (!subcommand) {
          console.error('Usage: swarm task start|checkpoint|close|reopen|show <slug> [options] | swarm task list');
          process.exit(1);
        }
        const { db, self } = requireSelf(true);
        if (subcommand === 'list') {
          const tasks = db.prepare(`
            SELECT id, title, state, owner_agent, lease_epoch, disposition, claim_kind, updated_at
            FROM tasks
            WHERE swarm_id = ?
            ORDER BY CASE state WHEN 'awaiting_review' THEN 0 WHEN 'active' THEN 1 WHEN 'open' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
                     updated_at DESC, id ASC
          `).all(self.swarm_id) as Array<{
            id: string;
            title: string;
            state: string;
            owner_agent: string | null;
            lease_epoch: number;
            disposition: string | null;
            claim_kind: ClaimKind | null;
          }>;
          if (tasks.length === 0) {
            console.log('No tasks recorded.');
          } else {
            for (const task of tasks) {
              const disposition = task.disposition ? `; disposition ${task.disposition}` : '';
              console.log(`${task.id} [${task.state}] \u2014 ${task.owner_agent ?? 'unowned'}(${task.lease_epoch})${disposition} \u2014 ${task.title}; claim ${effectiveClaimKind(task)}`);
            }
            console.log(`\n${tasks.length} task(s)`);
          }
          break;
        }
        if (subcommand === 'show') {
          if (!slug) {
            console.error('Usage: swarm task show <slug>');
            process.exit(1);
          }
          const task = getTask(db, self.swarm_id, slug);
          if (!task) {
            console.error(`Task "${slug}" not found in this swarm.`);
            process.exit(1);
          }
          console.log(`${task.id}: ${task.title}`);
          console.log(`state: ${task.state}; owner: ${task.owner_agent ?? 'unowned'}; lease epoch: ${task.lease_epoch}`);
          console.log(`claim: ${effectiveClaimKind(task)}`);
          console.log(`lease expires: ${task.lease_expires_at ?? 'none'}; disposition: ${task.disposition ?? 'none'}`);
          console.log(`repo: ${task.repo_path ?? 'none'}`);
          console.log(`branch: ${task.branch ?? 'none'}; worktree: ${task.worktree_path ?? 'none'}`);
          console.log(`transcript: ${task.transcript_hint ?? 'not available'}`);
          const events = db.prepare(`
            SELECT id, epoch, kind, actor, data, created_at
            FROM task_events
            WHERE swarm_id = ? AND task_id = ?
            ORDER BY id ASC
          `).all(self.swarm_id, slug) as Array<{
            id: number;
            epoch: number;
            kind: string;
            actor: string | null;
            data: string | null;
            created_at: string;
          }>;
          const parsedEvents = events.map(event => {
            if (!event.data) return { event, data: null as Record<string, unknown> | null };
            try {
              const parsed = JSON.parse(event.data) as unknown;
              return {
                event,
                data: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
                  ? parsed as Record<string, unknown>
                  : null,
              };
            } catch {
              return { event, data: null as Record<string, unknown> | null };
            }
          });
          const evidence = parsedEvents.filter(({ event }) => event.kind === 'close_evidence');
          console.log('close evidence:');
          if (evidence.length === 0) console.log('  none');
          for (const item of evidence) {
            console.log(`  ${String(item.data?.kind ?? 'unknown')}:${String(item.data?.ref ?? 'unknown')} [verified: ${String(item.data?.verified ?? false)}]`);
          }
          const closed = [...parsedEvents].reverse().find(({ event }) => event.kind === 'closed');
          console.log(`not established: ${String(closed?.data?.not_established ?? 'not recorded')}`);
          const overrides = parsedEvents.filter(({ event }) => event.kind === 'gate_override');
          console.log('gate overrides:');
          if (overrides.length === 0) console.log('  none');
          for (const item of overrides) {
            const gates = Array.isArray(item.data?.bypassed_gates)
              ? item.data.bypassed_gates.map(String).join(', ')
              : 'none';
            console.log(`  #${item.event.id} reason: ${String(item.data?.reason ?? 'not recorded')}; bypassed: ${gates}`);
          }
          const grantUsage = parsedEvents.filter(({ event }) => event.kind === 'grant_used');
          console.log('grant usage:');
          if (grantUsage.length === 0) console.log('  none');
          for (const item of grantUsage) {
            console.log(
              `  #${item.event.id} grant #${String(item.data?.grant_id ?? 'unknown')} ` +
              `${String(item.data?.op ?? 'unknown')} on ${String(item.data?.resource ?? 'unknown')} ` +
              `by ${String(item.data?.actor ?? item.event.actor ?? 'unknown')}`
            );
          }
          console.log('events:');
          if (events.length === 0) console.log('  none');
          for (const event of events) {
            const data = event.data ? ` \u2014 ${oneLineForCli(event.data)}` : '';
            console.log(`  #${event.id} ${event.created_at} ${event.kind} by ${event.actor ?? 'system'} @${event.epoch}${data}`);
          }
          const decisions = db.prepare(`
            SELECT id, body, made_by, supersedes, status, created_at
            FROM decisions
            WHERE swarm_id = ? AND task_id = ?
            ORDER BY id ASC
          `).all(self.swarm_id, slug) as Array<{
            id: number;
            body: string;
            made_by: string;
            supersedes: number | null;
            status: string;
            created_at: string;
          }>;
          console.log('decisions:');
          if (decisions.length === 0) console.log('  none');
          for (const decision of decisions) {
            const supersedes = decision.supersedes ? ` supersedes #${decision.supersedes}` : '';
            console.log(`  #${decision.id} [${decision.status}] ${decision.body} \u2014 ${decision.made_by}${supersedes}`);
          }
          break;
        }
        if (!slug) {
          console.error('Usage: swarm task start|checkpoint|close|reopen|show <slug> [options] | swarm task list');
          process.exit(1);
        }
        if (subcommand === 'start') {
          const result = await startTask(db, self.swarm_id, self.name, slug, {
            title: getFlag('--title'),
            repoPath: getFlag('--repo'),
            noWorktree: hasFlag('--no-worktree'),
            takeover: hasFlag('--takeover'),
            claimKind: getFlag('--claim'),
          });
          const verb = result.eventKind === 'claimed' ? 'claimed' : 'started';
          console.log(`Task "${slug}" ${verb} by ${self.name} at lease epoch ${result.task.lease_epoch}.`);
          if (result.task.branch) console.log(`Branch: ${result.task.branch}`);
          if (result.task.worktree_path) console.log(`Worktree: ${result.task.worktree_path}`);
          const claimKind = effectiveClaimKind(result.task);
          console.log(`claim: ${claimKind} — close requires: ${claimCloseRequirements(claimKind)}`);
          console.log(`change claim: re-run 'swarm task start ${slug} --claim <kind>' (add --takeover if another agent owns it).`);
          if (hasFlag('--no-worktree')) {
            console.log("note: no worktree recorded — 'swarm rescue --task/--agent' will refuse for this task; use 'swarm rescue --worktree <path>' for ad-hoc trees.");
          }
          break;
        }
        if (subcommand === 'checkpoint') {
          const result = checkpointTask(db, self.swarm_id, self.name, slug, getFlag('--notes'));
          if (!result.recorded) {
            console.log(`Checkpoint skeleton: ${result.path}`);
            console.error(`Checkpoint is incomplete. Edit every <FILL> marker, then re-run "swarm task checkpoint ${slug}".`);
            process.exitCode = 2;
          } else {
            console.log(`Checkpoint #${String(result.sequence).padStart(3, '0')} recorded: ${result.path}`);
          }
          break;
        }
        if (subcommand === 'close') {
          const disposition = getFlag('--disposition') as TaskDisposition | undefined;
          if (!disposition) {
            console.error('Usage: swarm task close <slug> --disposition pr|merged|archive|discard --not-established <text> [--evidence <kind>:<ref>] [--outcome inconclusive] [--force-discard] [--override --reason <text>]');
            process.exit(1);
          }
          const task = await closeTask(db, self.swarm_id, self.name, slug, {
            disposition,
            forceDiscard: hasFlag('--force-discard'),
            evidence: getRepeatedFlags('--evidence'),
            notEstablished: getFlag('--not-established'),
            outcome: getFlag('--outcome'),
            override: hasFlag('--override'),
            reason: getFlag('--reason'),
          });
          const verified = task.close_verification
            ? ` (verified: ${task.close_verification.sourceSha} reachable from ${task.close_verification.targetRef})`
            : '';
          console.log(`Task "${slug}" disposition recorded: ${task.disposition}${verified}. Branch ref kept; task worktree removed.`);
          break;
        }
        if (subcommand === 'reopen') {
          const reason = getFlag('--reason');
          if (!reason) {
            console.error('Usage: swarm task reopen <slug> --reason <text> [--takeover]');
            process.exit(1);
          }
          const result = await reopenTask(db, self.swarm_id, self.name, slug, {
            reason,
            takeover: hasFlag('--takeover'),
          });
          console.log(
            `Task "${slug}" reopened by ${self.name} at lease epoch ${result.task.lease_epoch}; ` +
            `prior disposition: ${result.priorDisposition ?? 'none'}.`
          );
          break;
        }
        console.error(`Unknown task command: ${subcommand}`);
        console.error('Usage: swarm task start|checkpoint|close|reopen|show <slug> [options] | swarm task list');
        process.exit(1);
        break;
      }

      case 'grant': {
        const subcommand = args[1];
        const usage = 'Usage: swarm grant create --op <merge|prod|spend|override|custom:name> --resource <r> --ttl <30m|2h|1d> [--to <agent>] [--note <text>] | swarm grant list [--live] | swarm grant revoke <id>';
        if (subcommand === 'create') {
          const op = getFlag('--op');
          const resource = getFlag('--resource');
          const ttl = getFlag('--ttl');
          if (!op || !resource || !ttl) {
            console.error(usage);
            process.exit(1);
          }
          const { db, self } = requireSelf(true);
          const grant = createGrant(db, self.swarm_id, self.name, {
            op,
            resource,
            ttl,
            grantedTo: getFlag('--to'),
            note: getFlag('--note'),
          });
          console.log(`Grant #${grant.id} created; expires ${grant.expires_at}.`);
          break;
        }
        const db = getDb();
        const swarm = resolveSelectedSwarm(db);
        if (subcommand === 'list') {
          const rows = listGrants(db, swarm.id, hasFlag('--live'));
          if (rows.length === 0) {
            console.log(hasFlag('--live') ? 'No live grants.' : 'No grants recorded.');
          } else {
            const now = Date.now();
            for (const grant of rows) {
              const status = grant.revoked_at
                ? `revoked ${grant.revoked_at}`
                : new Date(grant.expires_at).getTime() <= now
                  ? `expired ${grant.expires_at}`
                  : `expires ${grant.expires_at}`;
              const recipient = grant.granted_to ?? 'any';
              const note = grant.note ? `; note ${grant.note}` : '';
              console.log(`#${grant.id} ${grant.op} ${grant.resource} -> ${recipient}; by ${grant.granted_by}; ${status}${note}`);
            }
            console.log(`\n${rows.length} grant(s)`);
          }
          break;
        }
        if (subcommand === 'revoke') {
          const rawId = args[2];
          const id = Number(rawId);
          if (!rawId || !/^\d+$/.test(rawId) || id <= 0 || !Number.isSafeInteger(id)) {
            console.error(usage);
            process.exit(1);
          }
          const grant = revokeGrant(db, swarm.id, id);
          if (!grant) {
            console.error(`Grant #${id} not found in swarm "${swarm.name}".`);
            process.exit(1);
          }
          console.log(`Grant #${grant.id} revoked at ${grant.revoked_at}.`);
          break;
        }
        console.error(usage);
        process.exit(1);
        break;
      }

      case 'escalate': {
        const slug = args[1];
        if (!slug) {
          console.error('Usage: swarm escalate <slug> [--question <text>] [--to <agent>]');
          process.exit(1);
        }
        const { db, self } = requireSelf(true);
        const result = await escalateTask(db, self.swarm_id, self.name, slug, {
          question: getFlag('--question'),
          to: getFlag('--to'),
        });
        console.log(`Escalation packet: ${result.briefPath}`);
        if (result.recipient) {
          console.log(`Pointer sent to ${result.recipient}; task "${slug}" is awaiting_review.`);
        } else {
          console.log(`No active recipient found. Deliver this path manually: ${result.briefPath}`);
        }
        break;
      }

      case 'review': {
        const slug = args[1];
        if (!slug) {
          console.error('Usage: swarm review <slug> [--to <agent>] [--same-family-ok --reason <text>]');
          process.exit(1);
        }
        const { db, self } = requireSelf(true);
        const result = await requestTaskReview(db, self.swarm_id, self.name, slug, {
          to: getFlag('--to'),
          sameFamilyOk: hasFlag('--same-family-ok'),
          reason: getFlag('--reason'),
        });
        console.log(`Review brief: ${result.briefPath}`);
        console.log(
          `Pointer sent to ${result.reviewer} (${result.reviewerFamily}); ` +
          `task "${slug}" is awaiting_review.`
        );
        break;
      }

      case 'run': {
        const usage = 'Usage: swarm run [--task <slug>] -- <cmd> [args...]';
        const separator = args.indexOf('--');
        if (separator === -1 || separator === args.length - 1) {
          console.error(usage);
          process.exit(1);
        }
        let taskId: string | undefined;
        const wrapperArgs = args.slice(1, separator);
        for (let index = 0; index < wrapperArgs.length; index += 1) {
          if (wrapperArgs[index] !== '--task' || index + 1 >= wrapperArgs.length || taskId !== undefined) {
            console.error(usage);
            process.exit(1);
          }
          taskId = wrapperArgs[index + 1];
          index += 1;
        }
        const { db, self } = requireSelf();
        const result = runTaskCommand(db, self.swarm_id, self.name, args.slice(separator + 1), {
          taskId,
          cwd: process.cwd(),
        });
        if (result.summary) console.log(result.summary);
        console.log(`Log: ${result.logPath}`);
        console.log(`Exit status: ${result.exitCode}`);
        process.exitCode = result.exitCode;
        break;
      }

      case 'harness-review': {
        const slug = args[1];
        if (!slug) {
          console.error('Usage: swarm harness-review <task-slug>');
          process.exit(1);
        }
        const db = getDbReadOnly();
        if (!db) throw new Error('No swarm database found. Run "swarm create <name>" first.');
        try {
          const swarm = resolveSelectedSwarmReadOnly(db);
          const result = harnessReviewTask(db, swarm.id, slug);
          console.log(result.rendered.trimEnd());
          console.log(`Harness review: ${result.briefPath}`);
          if (!result.complete) {
            console.error(
              `Harness review is incomplete. Edit every <FILL> marker, then re-run ` +
              `"swarm harness-review ${slug}".`
            );
            process.exitCode = 2;
          } else {
            console.log('file the intervention as an EXP entry with a due date');
          }
        } finally {
          db.close();
        }
        break;
      }

      case 'handoff': {
        const slug = args[1];
        const target = getFlag('--to');
        if (!slug || !target) {
          console.error('Usage: swarm handoff <slug> --to <agent> [--stale-ok]');
          process.exit(1);
        }
        const { db, self } = requireSelf();
        const result = await handoffTask(db, self.swarm_id, self.name, slug, target, hasFlag('--stale-ok'));
        console.log(`Task "${slug}" handed off to ${result.task.owner_agent} at lease epoch ${result.task.lease_epoch}.`);
        console.log(`Brief: ${result.briefPath}${result.stale ? ' (STALE)' : ''}`);
        break;
      }

      case 'decision': {
        const usage = 'Usage: swarm decision <text> [--task <slug>] [--supersedes <decision-id>]';
        const supersedes = requirePositiveIdFlag('--supersedes', 'Decision ID', usage);
        const tokens: string[] = [];
        for (let index = 1; index < args.length; index += 1) {
          if (args[index] === '--task' || args[index] === '--supersedes') { index += 1; continue; }
          tokens.push(args[index]);
        }
        const body = tokens.join(' ');
        if (!body) {
          console.error(usage);
          process.exit(1);
        }
        const { db, self } = requireSelf();
        const result = recordDecision(db, self.swarm_id, self.name, body, getFlag('--task'), supersedes);
        console.log(`Decision #${result.id} recorded.`);
        break;
      }

      case 'rescue': {
        if (hasFlag('--list')) {
          const rows = listRescueArtifacts();
          if (rows.length === 0) {
            console.log('No rescue artifacts found.');
          } else {
            for (const row of rows) {
              if (!row.manifest) {
                console.log(`${row.artifactDir} — INVALID MANIFEST: ${row.error}`);
                continue;
              }
              const attribution = row.manifest.attribution.task_id
                ? `task ${row.manifest.attribution.task_id}`
                : `agent ${row.manifest.attribution.agent}`;
              console.log(`${row.artifactDir} — ${row.manifest.verified ? 'verified' : 'UNVERIFIED'} — ${attribution} — ${row.manifest.head_sha}`);
            }
          }
          break;
        }
        if (hasFlag('--verify')) {
          const artifactDir = getFlag('--verify');
          if (!artifactDir) {
            console.error('Usage: swarm rescue --verify <artifact-dir>');
            process.exit(1);
          }
          const manifest = verifyRescueArtifact(path.resolve(artifactDir));
          console.log(`Rescue verified: ${artifactDir} (${manifest.head_sha})`);
          break;
        }
        const { db, self } = requireSelf();
        const results = rescueTargets(db, self.swarm_id, {
          worktree: getFlag('--worktree'),
          taskId: getFlag('--task'),
          agent: getFlag('--agent'),
        });
        for (const result of results) {
          console.log(`Rescue verified: ${result.artifactDir}`);
          console.log(`Manifest: ${path.join(result.artifactDir, 'manifest.json')}`);
        }
        break;
      }

      case 'janitor': {
        const subcommand = args[1];
        if (subcommand === 'tick') {
          if (!hasFlag('--observe')) {
            console.error('only --observe is implemented; destructive phases are deliberately unbuilt — see docs/design/SWARM-NEXT-V1.md');
            process.exit(1);
          }
          const result = runJanitorTick(getDb());
          if (result.lockedOut) {
            console.log('Janitor tick already running; no-op.');
          } else {
            const counters = result.counters!;
            console.log(
              `Janitor observe tick complete in ${counters.tickMs}ms: ` +
              `${counters.reposScanned} repos, ${counters.worktrees} worktrees, ` +
              `${result.findings} findings.`
            );
          }
          break;
        }

        if (subcommand === 'roots') {
          const action = args[2];
          if (action === 'list') {
            const roots = readJanitorRoots();
            if (roots.length === 0) console.log('No janitor roots configured.');
            else for (const root of roots) console.log(root);
            break;
          }
          const root = args[3];
          if (!root || (action !== 'add' && action !== 'remove')) {
            console.error('Usage: swarm janitor roots list|add <path>|remove <path>');
            process.exit(1);
          }
          const roots = action === 'add' ? addJanitorRoot(root) : removeJanitorRoot(root);
          console.log(`Janitor root ${action === 'add' ? 'added' : 'removed'}: ${path.resolve(root)}`);
          console.log(`${roots.length} root(s) configured.`);
          break;
        }

        if (subcommand === 'install') {
          const plistPath = installJanitorLaunchAgent();
          console.log(`Janitor launch agent installed: ${plistPath}`);
          break;
        }

        if (subcommand === 'uninstall') {
          const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'io.swarm.janitor.plist');
          const removed = uninstallJanitorLaunchAgent();
          console.log(removed ? `Janitor launch agent uninstalled: ${plistPath}` : 'Janitor launch agent is not installed.');
          break;
        }

        console.error('Usage: swarm janitor tick --observe | roots list|add <path>|remove <path> | install | uninstall');
        process.exit(1);
        break;
      }

      case 'board': {
        const graphMode = hasFlag('--graph');
        const serveMode = hasFlag('--serve');
        const tabMode = hasFlag('--tab');
        const ownWorkspaceMode = hasFlag('--own-workspace');
        const rawWidth = getFlag('--width');
        const boardWidth = rawWidth === undefined ? undefined : Number(rawWidth);
        if (hasFlag('--width') && (
          !rawWidth || !/^\d+$/.test(rawWidth) ||
          !Number.isSafeInteger(boardWidth) || boardWidth! <= 0
        )) {
          console.error('Board width must be a positive integer number of columns (example: swarm board --width 80).');
          console.error('Usage: swarm board [--watch [N]] [--tab] [--width N]');
          process.exit(1);
        }
        const serveOpenModes = ['--tab', '--open', '--print-url'].filter(flag => hasFlag(flag));
        const boardServeUsage = 'Usage: swarm board --serve [--port N] [--tab | --open | --print-url]';
        if (serveMode && (graphMode || hasFlag('--watch') || hasFlag('--out'))) {
          console.error(boardServeUsage);
          process.exit(1);
        }
        if (serveMode && serveOpenModes.length > 1) {
          console.error(`${serveOpenModes.join(', ')} are mutually exclusive.`);
          console.error(boardServeUsage);
          process.exit(1);
        }
        if (ownWorkspaceMode && (!tabMode || graphMode || serveMode)) {
          console.error('--own-workspace requires "swarm board --tab" for the terminal board.');
          process.exit(1);
        }
        const rawServePort = getFlag('--port');
        const servePort = rawServePort === undefined ? undefined : Number(rawServePort);
        if (serveMode && hasFlag('--port') && (
          !rawServePort || !/^\d+$/.test(rawServePort) ||
          !Number.isInteger(servePort) || servePort! < 1 || servePort! > 65_535
        )) {
          console.error('Board port must be an integer from 1 through 65535.');
          console.error(boardServeUsage);
          process.exit(1);
        }
        const watchIndex = args.indexOf('--watch');
        const rawInterval = watchIndex === -1 ? undefined : args[watchIndex + 1];
        const intervalSeconds = rawInterval === undefined || rawInterval.startsWith('--')
          ? BOARD_DEFAULT_WATCH_SECONDS
          : Number(rawInterval);
        if (watchIndex !== -1 && (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0)) {
          console.error('Usage: swarm board [--watch [N]] [--tab] | --graph [--out <path>] [--open] [--watch [N]] [--tab] (N must be a positive number of seconds)');
          process.exit(1);
        }

        const rawOutputPath = getFlag('--out');
        if (graphMode && hasFlag('--out') && (!rawOutputPath || rawOutputPath.startsWith('--'))) {
          console.error('Usage: swarm board --graph [--out <path>] [--open] [--watch [N]] [--tab]');
          process.exit(1);
        }

        if (tabMode && !graphMode && !serveMode) {
          spawnBoardTab({
            cwd: process.cwd(),
            watchSeconds: intervalSeconds,
            width: boardWidth,
            ownWorkspace: ownWorkspaceMode,
          });
          break;
        }

        const db = getDbReadOnly();
        let swarmId = DEFAULT_SWARM_ID;
        if (db && boardHasTable(db, 'swarms')) {
          let swarm: Swarm | null = null;
          if (explicitSwarmName) {
            swarm = getSwarm(db, explicitSwarmName);
            if (!swarm) {
              db.close();
              console.error(`Error: Swarm "${explicitSwarmName}" not found.`);
              process.exit(1);
            }
          } else if (process.env.SWARM_ID) {
            swarm = getSwarmById(db, process.env.SWARM_ID);
          } else if (process.env.SWARM_NAME) {
            swarm = getSwarm(db, process.env.SWARM_NAME);
          }
          if (!swarm && boardHasTable(db, 'agents')) {
            const self = getSelf(db);
            if (self) swarm = getSwarmById(db, self.swarm_id);
          }
          if (!swarm) swarm = findSwarmForCwd(db);
          if (!swarm) swarm = getSwarmById(db, DEFAULT_SWARM_ID);
          if (swarm) swarmId = swarm.id;
        }

        const snapshot = (width: number = resolveBoardWidth({ width: boardWidth })) =>
          renderBoard(db, swarmId, { width });
        try {
          if (serveMode) {
            const running = await startBoardServer({ db, swarmId, port: servePort });
            const url = boardServerUrl(running);
            console.log(url);
            if (tabMode) {
              const result = openBoardServerTab(url, { cwd: process.cwd() });
              if (result) console.error(`Opened served board: ${result.workspaceRef} ${result.surfaceRef}`);
            } else if (hasFlag('--open') && !openBoardServerUrl(url)) {
              console.error(`Could not open the served board automatically; open ${url} in a browser.`);
            }
            await waitForBoardServerStop(running);
          } else if (graphMode) {
            const outputPath = rawOutputPath ?? path.join(os.homedir(), '.swarm', 'board.html');
            let opened = false;
            const regenerate = () => {
              const mermaid = buildBoardMermaid(db, swarmId, { now: Date.now() });
              const writtenPath = writeBoardGraphFile(outputPath, mermaid, {
                watchSeconds: watchIndex === -1 ? undefined : intervalSeconds,
              });
              console.log(mermaid);
              console.error(writtenPath);
              if (!opened) {
                if (tabMode) {
                  const result = openBoardGraphTab(writtenPath, { cwd: process.cwd() });
                  if (result) console.error(`Opened swarm graph: ${result.workspaceRef} ${result.surfaceRef}`);
                } else if (hasFlag('--open')) {
                  openBoardGraphFile(writtenPath);
                }
                opened = true;
              }
            };

            if (watchIndex === -1) {
              regenerate();
            } else {
              await watchBoardGraph({ regenerate, intervalMs: intervalSeconds * 1_000 });
            }
          } else if (watchIndex === -1) {
            console.log(snapshot());
          } else {
            await watchBoard({
              render: snapshot,
              width: boardWidth,
              intervalMs: intervalSeconds * 1_000,
            });
          }
        } finally {
          db?.close();
        }
        break;
      }

      case 'inbox': {
        const { db, self } = requireSelf();
        const usage = 'Usage: swarm inbox [--peek|--unread|--recent [N]] [--kind <kind>] [--wait <seconds>]';
        // --unread: common agent habit; same as default (show unread, advance cursor).
        // --peek: show without advancing.
        // --recent [N]: replay last N messages (default 10) IGNORING the read
        // cursor and delivery state, never advancing or acknowledging them.
        // --kind <k>: show only messages of that kind. Filtered reads NEVER advance
        // the cursor (they'd skip past unfiltered messages that were never shown).
        const kind = requireValidKind(usage);
        const kindPrefix = (msgKind: string | null) => msgKind ? `[${msgKind}] ` : '';
        const waitRaw = getFlag('--wait');
        if (hasFlag('--wait') && (!waitRaw || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(waitRaw))) {
          console.error(usage);
          process.exit(1);
        }
        if (hasFlag('--recent') && hasFlag('--wait')) {
          console.error(`${usage}\n--wait cannot be combined with --recent because recent is a historical replay.`);
          process.exit(1);
        }
        if (hasFlag('--recent')) {
          const limitRaw = getFlag('--recent');
          const limit = limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : 10;
          const recent = getRecentMessages(db, self.swarm_id, self.name, limit, kind);
          if (recent.length === 0) {
            console.log('No messages on record.');
          } else {
            for (const msg of recent) {
              const time = new Date(msg.created_at).toLocaleTimeString();
              const superseded = msg.superseded_by === null ? '' : ` [superseded by #${msg.superseded_by}]`;
              console.log(`[#${msg.id} ${time}] ${kindPrefix(msg.kind)}${msg.from_agent}: ${msg.body}${superseded}`);
            }
            console.log(`\n${recent.length} recent message(s) (replay — cursor unchanged)`);
          }
          break;
        }
        const peek = hasFlag('--peek');
        const waitResult = waitRaw === undefined
          ? null
          : await waitForInbox(db, self.swarm_id, self.name, {
              timeoutSeconds: Number(waitRaw),
              peek,
              kind,
            });
        const messages = waitResult?.messages
          ?? getInbox(db, self.swarm_id, self.name, peek || !!kind, kind);
        if (messages.length === 0) {
          if (waitResult?.timedOut) {
            console.log(`Inbox wait timed out after ${waitRaw} second(s); no new messages.`);
          } else if (kind) {
            console.log(`No new "${kind}" messages (kind filter — cursor unchanged).`);
          } else {
            // Zero unread + recent traffic means delivery state or the legacy cursor
            // already consumed them; point at the archaeology path.
            const recentCount = countRecentMessages(db, self.swarm_id, self.name);
            if (recentCount > 0) {
              const n = Math.min(recentCount, 50);
              console.log(`No new messages (read cursor is current). ${n} message(s) in the last 24h — replay with: swarm inbox --recent ${n}`);
            } else {
              console.log('No new messages.');
            }
          }
        } else {
          for (const msg of messages) {
            const time = new Date(msg.created_at).toLocaleTimeString();
            console.log(`[#${msg.id} ${time}] ${kindPrefix(msg.kind)}${msg.from_agent}: ${msg.body}`);
          }
          const suffix = kind
            ? ` (kind filter — cursor not advanced)`
            : peek ? ' (peek mode, not marked as read)' : '';
          console.log(`\n${messages.length} message(s)${suffix}`);
        }
        if (hasPendingRedeliveries(db)) spawnRedeliverWorker();
        break;
      }

      case 'members': {
        const db = getDb();
        const swarm = resolveSelectedSwarm(db);
        const agents = await listAgents(db, swarm.id);
        if (agents.length === 0) {
          console.log(`No agents in swarm "${swarm.name}".`);
        } else {
          const self = getSelf(db, swarm.id);
          console.log(`Swarm: ${swarm.name}`);
          for (const agent of agents) {
            const you = self && agent.name.toLowerCase() === self.name.toLowerCase() ? ' (you)' : '';
            const desc = agent.description ? ` — ${agent.description}` : '';
            const host = agent.host_agent ? `/${agent.host_agent}` : '';
            // Show the model family on the roster. Cross-family review is the fleet's
            // main control, and deciding it required inferring family from the harness
            // string — impossible for a2a seats, which read as "some other family" by
            // default. Print it, and print UNKNOWN as a word rather than an absence.
            const family = agentModelFamily(agent);
            const familyLabel = family === 'unknown' ? ' family=UNKNOWN' : ` family=${family}`;
            const type = agent.agent_type === 'a2a'
              ? ` [a2a] @ ${agent.endpoint_url}`
              : agent.agent_type === 'headless'
                ? ` [headless${host}]`
                : ` [cmux${host}]`;
            console.log(`  ${agent.name}${type}${familyLabel}${you}${desc}`);
          }
          console.log(`\n${agents.length} agent(s)`);
          const families = new Set(agents.map(a => agentModelFamily(a)).filter(f => f !== 'unknown'));
          const unknownCount = agents.filter(a => agentModelFamily(a) === 'unknown').length;
          if (families.size < 2) {
            console.log(
              `Model families live: ${families.size === 0 ? 'none known' : [...families].join(', ')}` +
              `${unknownCount > 0 ? ` (+${unknownCount} UNKNOWN, which cannot review across families)` : ''}` +
              ` — cross-family review is NOT available in this swarm.`
            );
          }
        }
        if (agents.some(agent => agent.agent_type !== 'headless') && !isCmuxObserverCompetent()) {
          console.warn(CMUX_LIVENESS_UNKNOWN_MESSAGE);
        }
        break;
      }

      case 'status': {
        const setDesc = getFlag('--set');
        const agentName = getFlag('--agent');

        if (setDesc) {
          const { db, self } = requireSelf();
          updateStatus(db, self.swarm_id, self.surface_id, setDesc);
          console.log(`Status updated: ${setDesc}`);
        } else if (agentName) {
          const db = getDb();
          const swarm = resolveSelectedSwarm(db);
          const agent = getAgent(db, swarm.id, agentName);
          if (!agent) {
            console.error(`Agent "${agentName}" not found in swarm "${swarm.name}".`);
            process.exit(1);
          }
          console.log(`${agent.name}: ${agent.description ?? '(no status set)'}`);
        } else {
          const { self } = requireSelf();
          console.log(`${self.name}: ${self.description ?? '(no status set)'}`);
        }
        break;
      }

      case 'stats': {
        const db = getDbReadOnly();
        if (!db) throw new Error('No swarm database found. Run "swarm create <name>" first.');
        try {
          const swarm = resolveSelectedSwarmReadOnly(db);
          const hoursRaw = getFlag('--hours');
          const hours = hoursRaw && /^\d+$/.test(hoursRaw) ? parseInt(hoursRaw, 10) : 24;
          const activeAgents = listAgentsSync(db, swarm.id).map((a) => a.name);
          const stats = getFleetStats(db, swarm.id, hours, activeAgents);
          console.log(formatFleetStats(stats));
        } finally {
          db.close();
        }
        break;
      }

      case 'whoami': {
        const { db, self, swarm } = requireSelf();
        console.log(`Name: ${self.name}`);
        console.log(`Swarm: ${swarm.name}`);
        console.log(`Swarm ID: ${self.swarm_id}`);
        console.log(`Type: ${self.agent_type}`);
        if (self.host_agent) console.log(`Host: ${self.host_agent}`);
        console.log(`Model family: ${agentModelFamily(self)}`);
        console.log(`Surface: ${self.surface_id}`);
        console.log(`Workspace: ${self.workspace_id ?? 'N/A'}`);
        console.log(`Joined: ${self.joined_at}`);
        if (self.description) console.log(`Status: ${self.description}`);
        if (self.endpoint_url) console.log(`Endpoint: ${self.endpoint_url}`);
        if (self.agent_type !== 'a2a') {
          const memberships = self.agent_type === 'cmux'
            ? listSurfaceMemberships(db, self.surface_id)
            : headlessMemberships(db);
          if (memberships.length > 1) {
            // The default is whatever the pointer names — NOT self.swarm_id, which is
            // the swarm this invocation selected via --swarm/SWARM_ID and would
            // mislabel the default whenever those are used.
            // Headless sessions carry their default in the unscoped TTY marker rather
            // than the surface pointer, so ask the right one for this agent type.
            const pointed = self.agent_type === 'cmux'
              ? readActiveSwarmId(self.surface_id)
              : readActiveHeadlessSwarmId();
            const defaultSwarmId = memberships.some(m => m.swarm_id === pointed)
              ? pointed
              : memberships[memberships.length - 1].swarm_id;
            console.log(`\nMemberships (${memberships.length}) — this session is in more than one swarm:`);
            for (const m of memberships) {
              const mSwarm = getSwarmById(db, m.swarm_id);
              const marker = m.swarm_id === defaultSwarmId ? ' <- default for commands without --swarm' : '';
              console.log(`  ${mSwarm?.name ?? m.swarm_id} — as "${m.name}"${marker}`);
            }
            console.log('Switch the default with "swarm use <swarm>"; target one command with --swarm <swarm>.');
          }
        }
        break;
      }

      case 'use': {
        // Sets which swarm unqualified commands act on for THIS surface.
        const target = args[1] ?? explicitSwarmName;
        if (!target) {
          console.error('Usage: swarm use <swarm>');
          process.exit(1);
        }
        const db = getDb();
        const targetSwarm = getSwarm(db, target);
        if (!targetSwarm) {
          console.error(`Error: Swarm "${target}" not found.`);
          process.exit(1);
        }
        // Resolve who is actually calling. CMUX_SURFACE_ID is inherited by every child
        // process of a tab, so trusting it alone would let a scripted subprocess
        // retarget the parent agent's default swarm.
        const { self: caller } = requireSelf();
        if (caller.agent_type === 'headless') {
          if (!setActiveHeadlessSwarm(targetSwarm.id)) {
            console.error(
              `Error: this session has no headless membership in "${targetSwarm.name}". ` +
              `Run "swarm join <name> --swarm ${targetSwarm.name}" first.`
            );
            process.exit(1);
          }
          console.log(`Default swarm is now "${targetSwarm.name}".`);
          break;
        }
        // Refuse to point the default at a swarm this surface has not joined —
        // otherwise every later command fails with a confusing "not joined".
        const membership = listSurfaceMemberships(db, caller.surface_id)
          .find(m => m.swarm_id === targetSwarm.id);
        if (!membership) {
          console.error(
            `Error: this surface is not a member of "${targetSwarm.name}". ` +
            `Run "swarm join <name> --swarm ${targetSwarm.name}" first.`
          );
          process.exit(1);
        }
        writeActiveSwarmId(caller.surface_id, targetSwarm.id);
        console.log(`Default swarm is now "${targetSwarm.name}" (you are "${membership.name}" there).`);
        break;
      }

      case 'read': {
        const { db, self } = requireSelf();
        const targetName = args[1];
        if (!targetName) {
          console.error('Usage: swarm read <agent> [--lines <n>]');
          process.exit(1);
        }
        const target = getAgent(db, self.swarm_id, targetName);
        if (!target) {
          console.error(`Agent "${targetName}" not found in this swarm.`);
          process.exit(1);
        }
        requireCmuxAgent(target, 'read terminal');
        const lines = getFlag('--lines');
        const screen = readScreen(target.surface_id, lines ? parseInt(lines, 10) : undefined, target.workspace_id);
        console.log(`--- ${target.name}'s terminal ---`);
        console.log(screen);
        break;
      }

      case 'spawn': {
        // `swarm spawn --help` must not spawn a tab (it once did).
        if (hasFlag('--help') || hasFlag('-h')) {
          printHelp();
          break;
        }
        const splitIndex = args.indexOf('--split');
        const splitValue = splitIndex === -1 ? undefined : args[splitIndex + 1];
        const splitDirection = splitValue === undefined || splitValue.startsWith('--')
          ? 'right'
          : splitValue.toLowerCase();
        const splitDirections: readonly CmuxSplitDirection[] = ['left', 'right', 'up', 'down'];
        if (splitIndex !== -1 && !splitDirections.includes(splitDirection as CmuxSplitDirection)) {
          console.error(`Invalid --split direction "${splitValue}". Use left, right, up, or down.`);
          process.exit(1);
        }
        const newWorkspaceRequested = hasFlag('--new-workspace');
        const newWorkspaceName = getFlag('--new-workspace');
        if (newWorkspaceRequested && (!newWorkspaceName || newWorkspaceName.startsWith('--') || !newWorkspaceName.trim())) {
          console.error('--new-workspace requires a name. Use --new-workspace <name>; workspaces are named program contexts.');
          process.exit(1);
        }
        if (splitIndex !== -1 && newWorkspaceRequested) {
          console.error('--split and --new-workspace <name> are mutually exclusive.');
          process.exit(1);
        }
        const name = getFlag('--name');
        const cwd = getFlag('--cwd') || process.cwd();
        // Spawned swarm workers run WITHOUT permission dialogs by DEFAULT (Tom,
        // 2026-07-21): an unattended agent cannot click "allow", so a dialog is a
        // stall, not a safeguard, on this trusted machine. --interactive-permissions
        // opts back into dialogs; --autonomous is retained as a compat no-op.
        const permissive = !hasFlag('--interactive-permissions');
        // Fable is never a default (Tom, 2026-07-22): a spawned claude worker
        // rides the workhorse tier unless a model is explicitly chosen —
        // reviewer/builder seats need the FAMILY, not the frontier tier.
        const modelFlag = getFlag('--model');
        const agentFlag = (getFlag('--agent') || (hasFlag('--codex') ? 'codex' : 'claude')).toLowerCase();
        const terminalFlag = (getFlag('--terminal') || 'auto').toLowerCase();
        let selectedTerminal: 'cmux' | 'warp';
        if (terminalFlag === 'auto') {
          selectedTerminal = process.env.TERM_PROGRAM === 'WarpTerminal' ? 'warp' : 'cmux';
        } else if (terminalFlag === 'cmux' || terminalFlag === 'warp') {
          selectedTerminal = terminalFlag;
        } else {
          console.error(`Unknown --terminal "${terminalFlag}". Supported: auto, cmux, warp.`);
          process.exit(1);
        }
        if (selectedTerminal === 'warp' && (splitIndex !== -1 || newWorkspaceRequested)) {
          console.error('--split and --new-workspace are cmux layout options; use --terminal cmux.');
          process.exit(1);
        }
        const db = getDb();
        const swarm = resolveSelectedSwarm(db, true);

        let agentCmd: string;
        let agentLabel: string;
        // Agents that receive join instructions as their initial prompt (no post-spawn /join-swarm).
        let joinViaPrompt = false;
        if (agentFlag === 'claude') {
          const model = ` --model ${shellToken(modelFlag ?? 'opus')}`;
          agentCmd = permissive ? `claude${model} --dangerously-skip-permissions` : `claude${model}`;
          agentLabel = 'Claude Code';
        } else if (agentFlag === 'codex') {
          // Pre-trust the cwd in ~/.codex/config.toml so spawned codex
          // sessions don't get stuck on the "Do you trust this folder?"
          // prompt. The prompt blocks the agent until someone presses
          // Enter to select "Yes" — fatal for unattended swarm workers.
          // Codex stores trust as: [projects."<absolute-path>"]
          //                         trust_level = "trusted"
          // Use the resolved absolute path everywhere — Codex keys its
          // trust map by absolute path, and we want our trust write and
          // codex --cd to agree on the same string.
          const absoluteCwd = path.resolve(cwd);
          ensureCodexTrust(absoluteCwd);

          // Codex doesn't have a /join-swarm slash command; pass the join
          // instructions as Codex's initial prompt instead of relying on
          // a post-spawn keystroke.
          const perms = permissive ? ' --yolo' : '';
          const model = modelFlag ? ` -m ${shellToken(modelFlag)}` : '';
          const swarmBin = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'swarm');
          const swarmFlag = `--swarm ${swarm.name}`;
          const joinInstruction = name
            ? `Join the local swarm as "${name}" by running: ${swarmBin} join "${name}" ${swarmFlag}. Then run ${swarmBin} inbox and ${swarmBin} members ${swarmFlag}. Stay available for swarm messages and respond using ${swarmBin} send <agent> "<message>".`
            : `Join the local swarm. First run ${swarmBin} members ${swarmFlag}. If there are no agents, join as "Lead"; otherwise choose a short unique creative name. Join by running ${swarmBin} join "<chosen-name>" ${swarmFlag}. Then run ${swarmBin} inbox and ${swarmBin} members ${swarmFlag}. Stay available for swarm messages and respond using ${swarmBin} send <agent> "<message>".`;
          agentCmd = `codex --cd ${shellQuote(absoluteCwd)}${perms}${model} ${shellQuote(joinInstruction)}`;
          agentLabel = 'Codex CLI';
          joinViaPrompt = true;
        } else if (agentFlag === 'grok') {
          // Grok CLI: pass join as the initial TUI prompt (positional [PROMPT]),
          // same reliability pattern as Codex. Skills install provides /join-swarm
          // for interactive use, but spawn shouldn't depend on TUI boot timing.
          const absoluteCwd = path.resolve(cwd);
          const perms = permissive ? ' --always-approve' : '';
          const model = modelFlag ? ` -m ${shellToken(modelFlag)}` : '';
          const swarmBin = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'swarm');
          const swarmFlag = `--swarm ${swarm.name}`;
          const joinInstruction = name
            ? `Join the local swarm as "${name}" by running: ${swarmBin} join "${name}" ${swarmFlag}. Then run ${swarmBin} inbox and ${swarmBin} members ${swarmFlag}. Stay available for swarm messages and respond using ${swarmBin} send <agent> "<message>".`
            : `Join the local swarm. First run ${swarmBin} members ${swarmFlag}. If there are no agents, join as "Lead"; otherwise choose a short unique creative name. Join by running ${swarmBin} join "<chosen-name>" ${swarmFlag}. Then run ${swarmBin} inbox and ${swarmBin} members ${swarmFlag}. Stay available for swarm messages and respond using ${swarmBin} send <agent> "<message>".`;
          agentCmd = `grok --cwd ${shellQuote(absoluteCwd)}${perms}${model} ${shellQuote(joinInstruction)}`;
          agentLabel = 'Grok CLI';
          joinViaPrompt = true;
        } else if (agentFlag === 'gemini' || agentFlag === 'agy') {
          // Gemini CLI: -i runs the prompt then stays interactive; --yolo skips
          // approval dialogs (unattended workers cannot click "allow").
          const absoluteCwd = path.resolve(cwd);
          const perms = permissive ? ' --yolo' : '';
          const model = modelFlag ? ` -m ${shellToken(modelFlag)}` : '';
          const swarmBin = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'swarm');
          const swarmFlag = `--swarm ${swarm.name}`;
          const joinInstruction = name
            ? `Join the local swarm as "${name}" by running: ${swarmBin} join "${name}" ${swarmFlag}. Then run ${swarmBin} inbox and ${swarmBin} members ${swarmFlag}. Stay available for swarm messages and respond using ${swarmBin} send <agent> "<message>".`
            : `Join the local swarm. First run ${swarmBin} members ${swarmFlag}. If there are no agents, join as "Lead"; otherwise choose a short unique creative name. Join by running ${swarmBin} join "<chosen-name>" ${swarmFlag}. Then run ${swarmBin} inbox and ${swarmBin} members ${swarmFlag}. Stay available for swarm messages and respond using ${swarmBin} send <agent> "<message>".`;
          agentCmd = `gemini${perms}${model} -i ${shellQuote(joinInstruction)}`;
          agentLabel = 'Gemini CLI';
          joinViaPrompt = true;
        } else {
          console.error(`Unknown --agent "${agentFlag}". Supported: claude, codex, grok, gemini.`);
          process.exit(1);
        }

        if (selectedTerminal === 'warp') {
          // Two paths:
          //  --window: open a fresh Warp window via launch configuration YAML
          //            (auto-runs the join+exec command — no keystrokes needed,
          //            but spawns a separate window which can clutter and is
          //            vulnerable to keystroke races if the user is typing
          //            while the launch fires).
          //  default:  open a NEW TAB in the active Warp window via
          //            warp://action/new_tab?path=<cwd>, then clipboard-paste
          //            the join+exec command into the new tab. Warp's
          //            `command` query param on new_tab is silently ignored
          //            (verified empirically), so we paste post-open.
          //            Requires Accessibility access to Warp.app.
          const useWindow = hasFlag('--window');
          let warpCommand: string;
          let willAutoJoin = false;

          const pushFlag = hasFlag('--push') ? ' --push' : '';

          if (agentFlag === 'claude' && name) {
            warpCommand = `swarm join ${shellQuote(name)} --swarm ${shellQuote(swarm.name)}${pushFlag} && exec ${agentCmd}`;
            willAutoJoin = true;
          } else if (joinViaPrompt) {
            warpCommand = agentCmd;
            willAutoJoin = true;
          } else {
            warpCommand = agentCmd;
          }

          if (useWindow) {
            const launchConfigsDir = path.join(os.homedir(), '.warp', 'launch_configurations');
            fs.mkdirSync(launchConfigsDir, { recursive: true });
            const configName = `swarm-spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const configPath = path.join(launchConfigsDir, `${configName}.yaml`);
            const yamlEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const yaml = [
              '---',
              `name: ${configName}`,
              'windows:',
              '  - tabs:',
              '      - layout:',
              `          cwd: ${JSON.stringify(cwd)}`,
              '          commands:',
              `            - exec: "${yamlEscape(warpCommand)}"`,
              '',
            ].join('\n');
            fs.writeFileSync(configPath, yaml, 'utf-8');

            execFileSync('open', [`warp://launch/${configName}`], { stdio: 'ignore' });
            setTimeout(() => { try { fs.unlinkSync(configPath); } catch { /* ignore */ } }, 5000).unref();
            console.log(`Opened new Warp window in ${cwd} running ${agentLabel}.${willAutoJoin ? ' The new tab will auto-join the swarm.' : ` Run /join-swarm --swarm ${swarm.name} in the new tab to join.`}`);
            break;
          }

          // Tab path: new_tab with path, then paste command via Accessibility.
          execFileSync('open', [`warp://action/new_tab?path=${encodeURIComponent(cwd)}`], { stdio: 'ignore' });
          // Wait for the new tab to spawn and grab focus before pasting.
          sleep(0.8);

          const escapedForApplescript = warpCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const args = [
            '-e', 'tell application "Warp" to activate',
            '-e', `set the clipboard to "${escapedForApplescript}"`,
            '-e', 'tell application "System Events" to keystroke "v" using command down',
            '-e', 'delay 0.1',
            '-e', 'tell application "System Events" to keystroke return',
          ];
          try {
            execFileSync('osascript', args, { stdio: 'ignore' });
            console.log(`Opened new Warp tab in ${cwd} running ${agentLabel}.${willAutoJoin ? ' The new tab will auto-join the swarm.' : ` Run /join-swarm --swarm ${swarm.name} in the new tab to join.`}`);
          } catch (err: any) {
            console.error(`Opened new Warp tab in ${cwd}, but failed to type the join command (Accessibility?). Run manually in the new tab: ${warpCommand}`);
            console.error(`Underlying error: ${err.message ?? err}`);
          }
          break;
        }

        const { workspaceId } = identify();
        let result: { workspaceRef: string | null; surfaceRef: string } | null = null;
        let location = 'new tab';

        if (newWorkspaceRequested) {
          try {
            result = spawnWorkspace(cwd, agentCmd, newWorkspaceName!.trim());
            location = `named workspace "${newWorkspaceName!.trim()}"`;
          } catch {
            result = null;
          }
        } else if (splitIndex !== -1) {
          try {
            result = spawnSplitInWorkspace(
              cwd,
              agentCmd,
              splitDirection as CmuxSplitDirection,
              workspaceId
            );
            location = `${splitDirection} split`;
          } catch {
            result = null;
          }
        } else {
          try {
            result = spawnSurfaceInWorkspace(cwd, agentCmd, workspaceId);
          } catch {
            result = null;
          }
        }

        if (!result) {
          console.error(`Failed to spawn ${agentLabel} session. Run from a cmux workspace or use --new-workspace <name> to create a named program context.`);
          process.exit(1);
        }

        const joinArg = name || '';
        const swarmArg = `--swarm ${swarm.name}`;
        console.log(`Spawned new ${agentLabel} session in ${cwd} (${location}: ${result.workspaceRef ?? 'current workspace'}, ${result.surfaceRef})`);

        if (joinViaPrompt) {
          console.log(`${agentLabel} received the join instructions as its initial prompt.`);
          break;
        }

        console.log(`Waiting for ${agentLabel} to initialize...`);
        sleep(8);

        try {
          sendToSurface(result.surfaceRef, `/join-swarm ${joinArg} ${swarmArg}`.trim(), result.workspaceRef);
          console.log(`Sent /join-swarm ${joinArg} ${swarmArg}`.trim());
        } catch {
          console.log(`Could not auto-join. Run /join-swarm ${joinArg} ${swarmArg}`.trim());
        }
        break;
      }

      case 'rename': {
        const { db, self } = requireSelf();
        const targetName = args[1];
        const title = args.slice(2).join(' ');
        if (!targetName || !title) {
          console.error('Usage: swarm rename <agent> <title>');
          process.exit(1);
        }
        const target = getAgent(db, self.swarm_id, targetName);
        if (!target) {
          console.error(`Agent "${targetName}" not found in this swarm.`);
          process.exit(1);
        }
        requireCmuxAgent(target, 'rename tab');
        renameTab(target.surface_id, title, target.workspace_id);
        console.log(`Renamed ${targetName}'s tab to "${title}"`);
        break;
      }

      case 'move': {
        const { db, self } = requireSelf();
        const targetName = args[1];
        const targetWorkspace = getFlag('--workspace');
        if (!targetName || !targetWorkspace) {
          console.error('Usage: swarm move <agent> --workspace <id>');
          process.exit(1);
        }
        const target = getAgent(db, self.swarm_id, targetName);
        if (!target) {
          console.error(`Agent "${targetName}" not found in this swarm.`);
          process.exit(1);
        }
        requireCmuxAgent(target, 'move');
        try {
          moveSurface(target.surface_id, targetWorkspace);
          updateWorkspace(db, target.swarm_id, target.surface_id, targetWorkspace);
          console.log(`Moved ${targetName} to workspace ${targetWorkspace}`);
        } catch (err: any) {
          console.error(`Failed to move ${targetName}: ${err.message}`);
          process.exit(1);
        }
        break;
      }

      case 'workspaces': {
        const output = listWorkspaces();
        console.log(output);
        break;
      }

      case 'rename-workspace': {
        const givenId = args[1];
        const title = args.slice(2).join(' ');
        if (!givenId || !title) {
          console.error('Usage: swarm rename-workspace <workspace-id> <title>');
          process.exit(1);
        }
        const db = getDb();
        // `swarm whoami` prints both a Surface id and a Workspace id; agents frequently
        // pass the Surface id by mistake (cmux then fails with "Workspace not found").
        // If the given id matches a known agent's surface, resolve to its workspace id.
        let wsId = givenId;
        const bySurface = db.prepare('SELECT name, workspace_id FROM agents WHERE surface_id = ? LIMIT 1')
          .get(givenId) as { name: string; workspace_id: string | null } | undefined;
        if (bySurface?.workspace_id && bySurface.workspace_id !== givenId) {
          wsId = bySurface.workspace_id;
          console.log(`Note: "${givenId}" is ${bySurface.name}'s Surface id; using their Workspace id ${wsId}.`);
        }
        try {
          renameWorkspace(wsId, title);
          console.log(`Renamed workspace ${wsId} to "${title}"`);
        } catch (err: any) {
          console.error(`Failed to rename workspace ${wsId}: ${err.message} (Tip: pass the Workspace id from "swarm whoami", not the Surface id.)`);
          process.exit(1);
        }
        break;
      }

      case 'reap': {
        const db = getDb();
        const name = getFlag('--name');
        const force = hasFlag('--force');
        const all = hasFlag('--all');
        const swarm = all ? null : resolveSelectedSwarm(db);

        if (force && !name) {
          console.error('Usage: swarm reap --name <agent> --force  (--force requires --name)');
          process.exit(1);
        }

        if (name) {
          if (!swarm) {
            console.error('Usage: swarm reap --name <agent> [--force] [--swarm <name>]  (--name cannot be used with --all)');
            process.exit(1);
          }
          if (force) {
            const removed = forceReap(db, swarm.id, name);
            if (removed) {
              if (removed.agent_type === 'headless') {
                removeSurface(removed.swarm_id, removed.name);
                const host = detectHost();
                if (host) removeHook(host, removed.name, removed.swarm_id);
              }
              console.log(`Force-reaped "${removed.name}" (${removed.agent_type}) from swarm "${swarm.name}".`);
            } else {
              console.error(`No agent named "${name}" found in swarm "${swarm.name}".`);
              process.exit(1);
            }
          } else {
            const target = getAgent(db, swarm.id, name);
            if (target && target.agent_type !== 'headless' && !isCmuxObserverCompetent()) {
              console.log(CMUX_LIVENESS_UNKNOWN_MESSAGE);
              break;
            }
            const removed = await reapIfDead(db, swarm.id, name);
            if (removed) {
              console.log(`Reaped "${removed.name}" (${removed.agent_type}) from swarm "${swarm.name}" — surface confirmed dead.`);
            } else {
              const still = getAgent(db, swarm.id, name);
              if (!still) {
                console.error(`No agent named "${name}" found in swarm "${swarm.name}".`);
                process.exit(1);
              } else if (still.agent_type === 'headless') {
                console.error(`"${name}" is a headless agent; has no probeable surface. Use --force to remove.`);
                process.exit(1);
              } else {
                console.log(`"${name}" is alive; not reaped. Use --force to remove anyway.`);
              }
            }
          }
        } else {
          const targets = listAgentsSync(db, swarm?.id);
          const cmuxUnknown = targets.some(agent => agent.agent_type !== 'headless') &&
            !isCmuxObserverCompetent();
          const removed = await reapAll(db, swarm?.id);
          if (cmuxUnknown) console.log(CMUX_LIVENESS_UNKNOWN_MESSAGE);
          if (removed.length === 0 && !cmuxUnknown) {
            console.log('No dead agents found.');
          } else if (removed.length > 0) {
            console.log(`Reaped ${removed.length} agent(s):`);
            for (const a of removed) console.log(`  ${a.name} (${a.agent_type})${swarm ? '' : ` from ${getSwarmById(db, a.swarm_id)?.name ?? a.swarm_id}`}`);
          }
        }
        break;
      }

      case 'version': {
        console.log(formatVersion(hasFlag('--check')));
        break;
      }

      case 'reset': {
        const db = getDb();
        const all = hasFlag('--all');
        const agents = listAgentsSync(db, all ? undefined : resolveSelectedSwarm(db).id);
        const host = detectHost();
        for (const a of agents.filter(agent => agent.agent_type === 'headless')) {
          removeSurface(a.swarm_id, a.name);
          if (host) removeHook(host, a.name, a.swarm_id);
        }

        if (all) {
          db.exec('DELETE FROM agents');
          db.exec('DELETE FROM message_deliveries');
          db.exec('DELETE FROM messages');
          db.exec('DELETE FROM inbox_cursors');
          db.prepare('DELETE FROM swarms WHERE id != ?').run(DEFAULT_SWARM_ID);
          console.log(`Swarm reset. Cleared ${agents.length} agent(s), all messages, and all non-default swarms.`);
        } else {
          const swarm = resolveSelectedSwarm(db);
          db.prepare('DELETE FROM agents WHERE swarm_id = ?').run(swarm.id);
          db.prepare('DELETE FROM message_deliveries WHERE swarm_id = ?').run(swarm.id);
          db.prepare('DELETE FROM messages WHERE swarm_id = ?').run(swarm.id);
          db.prepare('DELETE FROM inbox_cursors WHERE swarm_id = ?').run(swarm.id);
          console.log(`Swarm "${swarm.name}" reset. Cleared ${agents.length} agent(s) and its messages.`);
        }
        break;
      }

      case 'redeliver': {
        const db = getDb();
        if (hasFlag('--worker')) {
          // Detached background retry loop (spawned on push failure). Exits when drained.
          await runRedeliverWorker(db);
          break;
        }
        const dryRun = hasFlag('--dry-run');
        const result = await redeliverPending(db, { dryRun });
        if (dryRun) {
          console.log(`${result.eligible} message(s) eligible for redelivery (dry run, nothing pushed).`);
        } else {
          console.log(`Redelivered ${result.redelivered}/${result.eligible} pending message(s).`);
        }
        break;
      }

      case 'hook-context':
        printHookContext();
        break;

      case 'help':
      case '--help':
      case '-h':
      case undefined:
        if (hasFlag('--agent')) console.log(renderAgentHelp());
        else printHelp();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
