import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type GitRunner = (args: string[]) => string;

const defaultGit: GitRunner = args =>
  execFileSync('git', ['-C', REPO_DIR, ...args], { encoding: 'utf-8', timeout: 15_000 }).trim();

export function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * "Is this device on the latest swarm?" in one command. Without --check: local
 * version + SHA only (offline-safe). With --check: fetch origin and compare —
 * the answer an operator can ask ANY local agent for.
 */
export function formatVersion(check: boolean, git: GitRunner = defaultGit): string {
  const version = readPackageVersion();
  let sha = 'no-git';
  try {
    sha = git(['rev-parse', '--short', 'HEAD']);
  } catch {
    return `swarm ${version} (${sha}) — repo state unavailable`;
  }
  const base = `swarm ${version} (${sha})`;
  if (!check) return base;

  try {
    git(['fetch', '-q', 'origin']);
    const behind = Number(git(['rev-list', '--count', 'HEAD..origin/master']));
    const ahead = Number(git(['rev-list', '--count', 'origin/master..HEAD']));
    if (behind === 0 && ahead === 0) return `${base} — up to date with origin/master`;
    const parts: string[] = [];
    if (behind > 0) parts.push(`behind by ${behind}`);
    if (ahead > 0) parts.push(`ahead by ${ahead} (local-only commits)`);
    return `${base} — ${parts.join(', ')}; update: cd ${REPO_DIR} && git pull && npm install && npm run build`;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return `${base} — check unavailable (offline or no origin: ${reason})`;
  }
}
