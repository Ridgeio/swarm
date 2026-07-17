import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Machine-local reserved agent names (never shipped in the repo).
 *
 * Loaded from (first that exists wins for file paths; env is always merged):
 *   - $SWARM_RESERVED_NAMES  — comma/space-separated list
 *   - ~/.swarm/reserved-names — one name per line; # comments and blanks ignored
 *
 * Use this for local OpenClaw / remote A2A identities that must not be claimed
 * by Cmux/headless agents on this machine (e.g. Forge, Cooper, Hermes).
 */
export function loadReservedNames(): Set<string> {
  const names = new Set<string>();

  const env = process.env.SWARM_RESERVED_NAMES;
  if (env) {
    for (const part of env.split(/[,\s]+/)) {
      const n = part.trim();
      if (n) names.add(n.toLowerCase());
    }
  }

  const filePath = process.env.SWARM_RESERVED_NAMES_FILE
    || path.join(os.homedir(), '.swarm', 'reserved-names');

  try {
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, 'utf-8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        names.add(trimmed.toLowerCase());
      }
    }
  } catch {
    // Missing or unreadable file is fine — treat as empty.
  }

  return names;
}

/**
 * Model/product names agents must never use as identities. An agent named
 * after a model reads as "the model", not "an agent" — and collides the
 * moment a second instance of that model joins. Matching normalizes
 * separators and trailing version digits, so "Fable", "fable-5", and
 * "GPT_5.6" are all rejected.
 */
const MODEL_NAME_BLOCKLIST = new Set([
  'claude', 'fable', 'mythos', 'opus', 'sonnet', 'haiku',
  'codex', 'gpt', 'chatgpt', 'openai',
  'grok', 'gemini', 'copilot', 'cursor',
  'llama', 'mistral', 'deepseek', 'qwen', 'kimi',
]);

export function modelNameViolation(name: string): string | null {
  const normalized = name.toLowerCase().replace(/[\s._-]+/g, '');
  const versionStripped = normalized.replace(/[0-9.]+$/, '');
  for (const candidate of [normalized, versionStripped]) {
    if (MODEL_NAME_BLOCKLIST.has(candidate)) return candidate;
  }
  return null;
}

export function assertNotModelName(name: string): void {
  const model = modelNameViolation(name);
  if (model) {
    throw new Error(
      `Agent name "${name}" matches a model/product name ("${model}"). Agents must not name themselves after models — pick a distinct handle (e.g. Scribe, Rivet, Pixel).`
    );
  }
}

/**
 * A name that starts with "-" is almost always a flag that fell through to
 * the positional slot (`swarm join --help` once registered an agent literally
 * named "--help", clobbering a real registration on the same surface).
 */
export function assertValidAgentName(name: string): void {
  if (!name || name.startsWith('-')) {
    throw new Error(
      `"${name}" is not a valid agent name (looks like a flag). For usage, run: swarm help`
    );
  }
}

export function assertNameNotReserved(name: string): void {
  assertValidAgentName(name);
  assertNotModelName(name);
  const reserved = loadReservedNames();
  if (reserved.has(name.toLowerCase())) {
    throw new Error(
      `Agent name "${name}" is reserved on this machine (see ~/.swarm/reserved-names or SWARM_RESERVED_NAMES). Choose a different name.`
    );
  }
}
