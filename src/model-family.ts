/**
 * Model family — the axis cross-family review inverts on.
 *
 * Lives in its own module because both the registry (which records a family at join)
 * and review routing (which enforces inversion) need it, and two copies of the map
 * would drift. `unknown` is a real value, not a placeholder: it means "we did not find
 * out", and code that treats it as "some other family" turns a failed measurement into
 * a satisfied control.
 */
export type ModelFamily = 'claude' | 'openai' | 'xai' | 'google' | 'unknown';

/** Harness -> family. A harness only ever runs its own vendor's models. */
export const MODEL_FAMILY_MAP: Readonly<Record<string, ModelFamily>> = Object.freeze({
  'claude-code': 'claude',
  codex: 'openai',
  grok: 'xai',
  gemini: 'google',
});

/** Declarable families, i.e. everything except `unknown`. */
export const MODEL_FAMILIES: readonly ModelFamily[] = Object.freeze([
  'claude',
  'openai',
  'xai',
  'google',
] as const);

export function deriveModelFamily(hostAgent: string | null | undefined): ModelFamily {
  return hostAgent ? MODEL_FAMILY_MAP[hostAgent] ?? 'unknown' : 'unknown';
}

/** Parse a user-supplied family, returning null for anything not declarable. */
export function parseModelFamily(value: string | null | undefined): ModelFamily | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  return (MODEL_FAMILIES as readonly string[]).includes(normalized)
    ? normalized as ModelFamily
    : null;
}

/**
 * What an agent IS.
 *
 * A KNOWN harness wins, because it is a live observation and a harness only ever runs
 * its own vendor's models. The stored column is refreshed at join but `host_agent` is
 * re-detected on every command, so preferring the column would let a stale value from
 * an earlier join outrank what the agent demonstrably is now — and route a same-family
 * seat as the cross-family reviewer, which is the exact failure this axis exists to
 * prevent. The declaration is the fallback, for A2A agents that have no harness to read.
 */
export function agentModelFamily(
  agent: { host_agent?: string | null; model_family?: string | null }
): ModelFamily {
  const fromHarness = deriveModelFamily(agent.host_agent);
  if (fromHarness !== 'unknown') return fromHarness;
  return parseModelFamily(agent.model_family) ?? 'unknown';
}
