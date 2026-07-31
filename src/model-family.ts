import type { HostAgentKind } from './registry.js';

export type ModelFamily = 'claude' | 'openai' | 'xai' | 'google' | 'unknown';

export const MODEL_FAMILY_MAP: Readonly<Record<HostAgentKind, ModelFamily>> = Object.freeze({
  'claude-code': 'claude',
  codex: 'openai',
  grok: 'xai',
  gemini: 'google',
});

export function deriveModelFamily(hostAgent: string | null | undefined): ModelFamily {
  if (!hostAgent) return 'unknown';
  return MODEL_FAMILY_MAP[hostAgent as HostAgentKind] ?? 'unknown';
}

export function isModelFamily(value: string): value is ModelFamily {
  return ['claude', 'openai', 'xai', 'google', 'unknown'].includes(value);
}
