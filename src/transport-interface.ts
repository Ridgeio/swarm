export type AgentType = 'cmux' | 'a2a' | 'headless';

export interface TransportAgent {
  swarm_id: string;
  name: string;
  agent_type: AgentType;
  surface_id: string;
  workspace_id: string | null;
  endpoint_url: string | null;
  /** Host harness (claude-code | codex | grok); drives delivery quirks. */
  host_agent?: string | null;
}

export interface TransportDeliveryResult {
  delivered: boolean;
  error?: string;
}

/**
 * Delivery policy for a push. Default is non-interruptive: type the message and
 * submit once (on Grok this *queues* while a turn is running). Opt into
 * `interject` only when you intentionally want send-now on hosts that queue.
 */
export interface DeliveryOptions {
  /** Grok: second Enter forces send-now instead of queueing. No-op on Claude/Codex. */
  interject?: boolean;
}

export interface Transport {
  deliverMessage(
    agent: TransportAgent,
    formattedText: string,
    options?: DeliveryOptions
  ): Promise<TransportDeliveryResult>;
  isAlive(agent: TransportAgent): Promise<boolean>;
}
