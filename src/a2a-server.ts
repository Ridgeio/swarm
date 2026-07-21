import http from 'http';
import os from 'os';
import { randomUUID } from 'crypto';
import type { SwarmDb } from './db.js';
import { getAgent } from './registry.js';
import { deliverToAgent } from './transport-router.js';
import { spawnRedeliverWorker } from './redeliver.js';

/**
 * A2A server — makes a local (usually headless) swarm agent reachable from
 * other machines. Remote swarms register this endpoint via
 * `swarm register-a2a <name> --endpoint http://<tailscale-ip>:<port>`,
 * and their sends land in this machine's swarm DB inbox, where the local
 * agent picks them up via `swarm inbox` / the awareness hook.
 *
 * Uses the @a2a-js/sdk server request handler wired to a plain node:http
 * server (no express), so the wire format always matches the SDK client
 * used by A2ATransport.
 */

export interface A2AServeOptions {
  db: SwarmDb;
  swarmId: string;
  swarmName: string;
  /** Local agent name whose inbox receives incoming messages. */
  agentName: string;
  port: number;
  /** Interface to bind ('0.0.0.0', a specific IP, …). */
  bind: string;
  /** Base URL advertised in the agent card (what remote clients dial). */
  advertiseUrl: string;
  description?: string;
}

/** Prefer the Tailscale CGNAT address (100.64.0.0/10) so cross-machine
 * registration works out of the box; fall back to any external IPv4. */
export function detectAdvertiseHost(): string {
  const ifaces = os.networkInterfaces();
  let fallback: string | null = null;
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const [a, b] = addr.address.split('.').map(Number);
      if (a === 100 && b >= 64 && b <= 127) return addr.address;
      if (!fallback) fallback = addr.address;
    }
  }
  return fallback ?? '127.0.0.1';
}

/** Incoming A2A text arrives pre-formatted by the remote swarm as
 * "[SWARM from <name>]: <body>". Recover sender + body so the message
 * threads into the local inbox with real attribution. */
export function parseSwarmEnvelope(text: string): { from: string; body: string } {
  const match = /^\[SWARM from ([^\]]+)\]:\s?([\s\S]*)$/.exec(text);
  if (match) return { from: match[1], body: match[2] };
  return { from: 'a2a-remote', body: text };
}

export async function startA2AServer(options: A2AServeOptions): Promise<http.Server> {
  const { db, swarmId, swarmName, agentName, port, bind, advertiseUrl } = options;

  const { DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler } =
    await import('@a2a-js/sdk/server');

  const agentCard = {
    protocolVersion: '0.3.0',
    name: agentName,
    description:
      options.description ??
      `Swarm agent "${agentName}" (swarm "${swarmName}") on ${os.hostname()} — messages land in its swarm inbox.`,
    url: advertiseUrl,
    preferredTransport: 'JSONRPC' as const,
    version: '0.1.0',
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'swarm-inbox',
        name: 'Swarm inbox delivery',
        description: 'Delivers A2A messages into the local swarm inbox.',
        tags: ['swarm'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
    ],
  };

  const insertMessage = db.prepare(
    'INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at) VALUES (?, ?, ?, ?, 0, ?)'
  );
  const markDelivered = db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?');

  const executor = {
    async execute(requestContext: any, eventBus: any): Promise<void> {
      const parts: any[] = requestContext.userMessage?.parts ?? [];
      const text = parts
        .filter((p) => p.kind === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n');

      let reply: string;
      if (text.trim()) {
        const { from, body } = parseSwarmEnvelope(text);
        const inserted = insertMessage.run(swarmId, from, agentName, body, new Date().toISOString());
        // Activation parity with local swarm: don't stop at the DB row — push the
        // message into the recipient's terminal surface via the same transport a
        // local `swarm send` uses (cmux keystrokes / Warp AppleScript). A recipient
        // with no surface just falls back to inbox pickup (hook/poll), as locally.
        // delivered stays 0 on push failure so the local redeliver worker retries.
        reply = `Queued to ${agentName}'s inbox in swarm "${swarmName}" on ${os.hostname()}.`;
        const localTarget = getAgent(db, swarmId, agentName);
        if (localTarget && localTarget.agent_type !== 'a2a') {
          try {
            const push = await deliverToAgent(localTarget, `[SWARM from ${from}]: ${body}`);
            if (push.delivered) {
              markDelivered.run(Number(inserted.lastInsertRowid));
              reply = `Delivered to ${agentName} on ${os.hostname()} (pushed to terminal).`;
            } else {
              // Busy surface (e.g. recipient mid-turn). The detached worker retries
              // on backoff and lands the push once the surface frees up — the same
              // recovery path a local send uses.
              console.error(`[a2a-server] push to ${agentName} not delivered: ${push.error ?? 'unknown'}`);
              spawnRedeliverWorker();
              reply = `Queued for ${agentName} on ${os.hostname()} (surface busy, retry worker spawned).`;
            }
          } catch (err: any) {
            // Push is best-effort; the inbox row already guarantees delivery.
            console.error(`[a2a-server] push to ${agentName} threw: ${err?.message ?? err}`);
            spawnRedeliverWorker();
          }
        }
      } else {
        reply = `Ignored: no text content for ${agentName}.`;
      }

      eventBus.publish({
        kind: 'message',
        messageId: randomUUID(),
        role: 'agent',
        parts: [{ kind: 'text', text: reply }],
        contextId: requestContext.contextId,
      });
      eventBus.finished();
    },
    async cancelTask(): Promise<void> {
      // Deliveries are instantaneous; nothing to cancel.
    },
  };

  const requestHandler = new DefaultRequestHandler(
    agentCard as any,
    new InMemoryTaskStore(),
    executor as any
  );
  const rpcHandler = new JsonRpcTransportHandler(requestHandler);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'HEAD') {
        res.writeHead(200).end();
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/.well-known/agent-card.json')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(agentCard));
        return;
      }
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
          return;
        }
        const result = await rpcHandler.handle(body);
        if (result && typeof (result as any)[Symbol.asyncIterator] === 'function') {
          // Streaming method (message/stream etc.) — emit Server-Sent Events.
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          });
          for await (const event of result as AsyncGenerator<unknown>) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        }
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err: any) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: err?.message ?? 'internal error' } }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => resolve());
  });

  // Ephemeral port (0): patch the advertised URL with the real bound port so
  // the card always points somewhere dialable.
  const bound = server.address();
  if (bound && typeof bound === 'object') {
    try {
      const url = new URL(agentCard.url);
      if (url.port === '0' || port === 0) {
        url.port = String(bound.port);
        agentCard.url = url.toString();
      }
    } catch {
      // Leave a hand-crafted advertise URL untouched.
    }
  }

  return server;
}
