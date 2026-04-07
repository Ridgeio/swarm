export type AgentType = 'cmux' | 'a2a' | 'headless';

export interface TransportAgent {
  name: string;
  agent_type: AgentType;
  surface_id: string;
  workspace_id: string | null;
  endpoint_url: string | null;
}

export interface TransportDeliveryResult {
  delivered: boolean;
  error?: string;
}

export interface Transport {
  deliverMessage(agent: TransportAgent, formattedText: string): Promise<TransportDeliveryResult>;
  isAlive(agent: TransportAgent): Promise<boolean>;
}
