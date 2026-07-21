import type { SwarmDb } from './db.js';
import { getJanitorStatus, janitorTickAgeMinutes, type JanitorStatus } from './janitor.js';

/**
 * Fleet messaging metrics for the self-improvement loop (docs/self-improvement.md).
 * Read-only over the messages table; computes the numbers the periodic
 * orchestration review needs so experiments can be judged against a baseline
 * instead of vibes.
 */

export interface AgentTraffic {
  agent: string;
  sent: number;
  received: number;
  broadcastsSent: number;
  acksSent: number;
}

/**
 * Stall telemetry: an agent that keeps RECEIVING work but hasn't SENT anything
 * in a long time may be a zombie (hung harness, ack-loop, dead session). Field
 * evidence 2026-07-17: a builder's harness entered an ack-only loop holding
 * critical-path work captive in a local worktree; the fleet noticed by
 * accident. Send-recency makes it visible on purpose.
 */
export interface AgentStall {
  agent: string;
  /** Minutes since this agent last sent any message (Infinity = never sent). */
  minutesSinceLastSend: number;
  /** Messages addressed to the agent after its last send — unanswered inflow. */
  inboundSinceLastSend: number;
}

export interface PairTraffic {
  from: string;
  to: string;
  count: number;
}

export interface UnackedDeliveryStats {
  agent: string;
  count: number;
  maxAgeMinutes: number;
}

export interface FleetStats {
  windowHours: number;
  since: string;
  totalMessages: number;
  directMessages: number;
  broadcasts: number;
  /** Estimated recipient-side reads: direct=1 reader, broadcast=activeAgents-1. */
  estimatedReads: number;
  ackLikeMessages: number;
  avgBodyChars: number;
  perAgent: AgentTraffic[];
  topPairs: PairTraffic[];
  /** Agents silent ≥ stallThresholdMinutes with inbound piling up after their
   *  last send, plus registered agents that have never sent at all. */
  possibleStalls: AgentStall[];
  unackedDeliveries: UnackedDeliveryStats[];
  janitorStatus: JanitorStatus | null;
  janitorAgeMinutes: number | null;
}

const STALL_THRESHOLD_MINUTES = 45;

// ACK-like = messages whose information content is receipt confirmation.
// Heuristic on purpose; used for trend direction, not billing.
const ACK_RE = /^\s*(ACK\b|Ack(nowledged)?\b|ack\b|Received\b|Standing by\b)/;

interface MessageRow {
  from_agent: string;
  to_agent: string | null;
  body: string;
}

interface EncodedMessageRow {
  from_agent: Uint8Array;
  to_agent: Uint8Array | null;
  body: Uint8Array;
}

export function getFleetStats(
  db: SwarmDb,
  swarmId: string,
  windowHours: number,
  /** Registered agent names (for broadcast fanout + never-sent stall checks).
   *  A bare count is accepted for callers that don't need stall telemetry. */
  activeAgents: string[] | number,
  now: number = Date.now()
): FleetStats {
  const agentNames = Array.isArray(activeAgents) ? activeAgents : [];
  const activeAgentCount = Array.isArray(activeAgents) ? activeAgents.length : activeAgents;
  const since = new Date(now - windowHours * 3_600_000).toISOString();
  // node:sqlite exposes TEXT through SQLite's C-string accessor, which truncates
  // embedded NULs. Read the bytes and decode them so stats preserve stored text.
  const decoder = new TextDecoder();
  const encodedRows = db
    .prepare(
      `SELECT
         CAST(from_agent AS BLOB) AS from_agent,
         CASE WHEN to_agent IS NULL THEN NULL ELSE CAST(to_agent AS BLOB) END AS to_agent,
         CAST(body AS BLOB) AS body
       FROM messages WHERE swarm_id = ? AND created_at >= ? ORDER BY id`
    )
    .all(swarmId, since) as unknown as EncodedMessageRow[];
  const rows: MessageRow[] = encodedRows.map(row => ({
    from_agent: decoder.decode(row.from_agent),
    to_agent: row.to_agent === null ? null : decoder.decode(row.to_agent),
    body: decoder.decode(row.body),
  }));

  const byAgent = new Map<string, AgentTraffic>();
  const traffic = (name: string): AgentTraffic => {
    let t = byAgent.get(name);
    if (!t) {
      t = { agent: name, sent: 0, received: 0, broadcastsSent: 0, acksSent: 0 };
      byAgent.set(name, t);
    }
    return t;
  };

  const pairCounts = new Map<string, number>();
  let broadcasts = 0;
  let ackLike = 0;
  let bodyChars = 0;

  for (const row of rows) {
    bodyChars += row.body.length;
    const sender = traffic(row.from_agent);
    sender.sent++;
    const isAck = ACK_RE.test(row.body);
    if (isAck) {
      ackLike++;
      sender.acksSent++;
    }
    if (row.to_agent === null) {
      broadcasts++;
      sender.broadcastsSent++;
    } else {
      traffic(row.to_agent).received++;
      const key = `${row.from_agent}→${row.to_agent}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
  }

  const direct = rows.length - broadcasts;
  const broadcastFanout = Math.max(0, activeAgentCount - 1);

  const topPairs = [...pairCounts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split('→');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Stall telemetry (all-time recency, independent of the stats window):
  // an agent is a possible stall when it hasn't sent for STALL_THRESHOLD_MINUTES
  // while inbound has arrived after its last send, or when it never sent at all.
  const possibleStalls: AgentStall[] = [];
  if (agentNames.length > 0) {
    const lastSentRows = db
      .prepare(
        'SELECT from_agent, max(created_at) AS last_sent FROM messages WHERE swarm_id = ? GROUP BY from_agent'
      )
      .all(swarmId) as Array<{ from_agent: string; last_sent: string }>;
    const lastSent = new Map(lastSentRows.map((r) => [r.from_agent, r.last_sent]));
    const inboundAfter = db.prepare(
      'SELECT count(*) AS n FROM messages WHERE swarm_id = ? AND (to_agent = ? OR to_agent IS NULL) AND created_at > ?'
    );

    for (const name of agentNames) {
      const sentAt = lastSent.get(name);
      const minutes = sentAt
        ? Math.round((now - new Date(sentAt).getTime()) / 60_000)
        : Infinity;
      if (minutes < STALL_THRESHOLD_MINUTES) continue;
      const inbound = sentAt
        ? ((inboundAfter.get(swarmId, name, sentAt) as { n: number }).n)
        : ((inboundAfter.get(swarmId, name, '') as { n: number }).n);
      if (inbound > 0) {
        possibleStalls.push({ agent: name, minutesSinceLastSend: minutes, inboundSinceLastSend: inbound });
      }
    }
    possibleStalls.sort((a, b) => b.inboundSinceLastSend - a.inboundSinceLastSend);
  }

  const unackedRows = db.prepare(`
    SELECT
      d.recipient AS agent,
      COUNT(*) AS count,
      MIN(COALESCE(d.first_injected_at, m.created_at)) AS oldest_at
    FROM message_deliveries d
    JOIN messages m ON m.id = d.message_id AND m.swarm_id = d.swarm_id
    WHERE d.swarm_id = ?
      AND d.status != 'acked'
      AND m.superseded_by IS NULL
    GROUP BY d.recipient COLLATE NOCASE
    ORDER BY count DESC, oldest_at ASC
  `).all(swarmId) as Array<{ agent: string; count: number; oldest_at: string }>;
  const unackedDeliveries = unackedRows.map(row => ({
    agent: row.agent,
    count: row.count,
    maxAgeMinutes: Math.max(0, Math.floor((now - new Date(row.oldest_at).getTime()) / 60_000)),
  }));

  const janitorStatus = getJanitorStatus(db);
  return {
    windowHours,
    since,
    totalMessages: rows.length,
    directMessages: direct,
    broadcasts,
    estimatedReads: direct + broadcasts * broadcastFanout,
    ackLikeMessages: ackLike,
    avgBodyChars: rows.length === 0 ? 0 : Math.round(bodyChars / rows.length),
    perAgent: [...byAgent.values()].sort((a, b) => b.sent + b.received - (a.sent + a.received)),
    topPairs,
    possibleStalls,
    unackedDeliveries,
    janitorStatus,
    janitorAgeMinutes: janitorStatus ? janitorTickAgeMinutes(janitorStatus, now) : null,
  };
}

export function formatFleetStats(stats: FleetStats): string {
  const lines: string[] = [];
  const pct = (n: number, d: number) => (d === 0 ? '0%' : `${Math.round((n / d) * 100)}%`);

  lines.push(`Fleet stats — last ${stats.windowHours}h (since ${stats.since})`);
  lines.push(
    `Messages: ${stats.totalMessages} total | ${stats.directMessages} direct, ${stats.broadcasts} broadcast (${pct(stats.broadcasts, stats.totalMessages)})`
  );
  lines.push(
    `Est. recipient reads: ${stats.estimatedReads} | ack-like: ${stats.ackLikeMessages} (${pct(stats.ackLikeMessages, stats.totalMessages)}) | avg body: ${stats.avgBodyChars} chars`
  );

  if (stats.perAgent.length > 0) {
    lines.push('');
    lines.push('Per agent (sent/received, bcast, acks):');
    for (const a of stats.perAgent) {
      lines.push(
        `  ${a.agent.padEnd(12)} ${String(a.sent).padStart(4)} sent / ${String(a.received).padStart(4)} recv | bcast ${a.broadcastsSent} | ack ${a.acksSent}`
      );
    }
  }

  if (stats.topPairs.length > 0) {
    lines.push('');
    lines.push('Busiest pairs:');
    for (const p of stats.topPairs) {
      lines.push(`  ${p.from} -> ${p.to}: ${p.count}`);
    }
  }

  lines.push('');
  lines.push('Unacked deliveries (count / max age):');
  if (stats.unackedDeliveries.length === 0) {
    lines.push('  none');
  } else {
    for (const delivery of stats.unackedDeliveries) {
      lines.push(`  ${delivery.agent.padEnd(12)} ${delivery.count} unacked | max age ${delivery.maxAgeMinutes}min`);
    }
  }

  if (stats.possibleStalls.length > 0) {
    lines.push('');
    lines.push('POSSIBLE STALLS (silent >45min with unanswered inbound):');
    for (const s of stats.possibleStalls) {
      const age = s.minutesSinceLastSend === Infinity ? 'never sent' : `${s.minutesSinceLastSend}min silent`;
      lines.push(`  ${s.agent.padEnd(12)} ${age}, ${s.inboundSinceLastSend} inbound since — check surface (zombie? ack-loop? captive work?)`);
    }
  }

  lines.push('');
  lines.push('Janitor/debris:');
  if (!stats.janitorStatus) {
    lines.push('  janitor: never run');
  } else {
    const counters = stats.janitorStatus.counters;
    lines.push(`  janitor: tick ${stats.janitorAgeMinutes ?? 0}m ago (${stats.janitorStatus.lastDurationMs}ms)`);
    lines.push(`  worktrees: ${counters.worktrees} total | ${counters.detachedHeads} detached | ${counters.orphanedWorktrees} orphaned`);
    lines.push(`  commits: ${counters.unpushedCommits} unpushed | upstream branches gone: ${counters.goneUpstreamBranches}`);
    lines.push(`  temp strays: ${counters.tempStrays} | junk dirs: ${counters.junkDirs} | repos scanned: ${counters.reposScanned}`);
  }

  if (stats.totalMessages === 0) {
    lines.push('No traffic in window.');
  }
  return lines.join('\n');
}
