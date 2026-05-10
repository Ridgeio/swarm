import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Ensure Codex's config.toml has a `[projects."<absolutePath>"]` section
 * with `trust_level = "trusted"`.
 *
 * Without this entry, `codex` prompts "Do you trust this folder?" on
 * launch and blocks indefinitely waiting for the user to press Enter to
 * select "Yes" — fatal for unattended swarm-spawned workers.
 *
 * Append-only: if the section header is already present, leave the file
 * untouched. Honors CODEX_HOME (matches Codex's own convention) and
 * defaults to ~/.codex.
 */
export function ensureCodexTrust(absolutePath: string): void {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const codexConfigPath = path.join(codexHome, 'config.toml');
  const sectionHeader = `[projects."${absolutePath}"]`;
  try {
    let content = '';
    if (fs.existsSync(codexConfigPath)) {
      content = fs.readFileSync(codexConfigPath, 'utf-8');
      const headerRegex = new RegExp(
        `^\\[projects\\."${absolutePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\]\\s*$`,
        'm'
      );
      if (headerRegex.test(content)) return;
    } else {
      fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
    }
    const needsLeadingBlankLine = content.length > 0;
    const tail = needsLeadingBlankLine
      ? (content.endsWith('\n') ? '\n' : '\n\n')
      : '';
    fs.appendFileSync(codexConfigPath, `${tail}${sectionHeader}\ntrust_level = "trusted"\n`);
  } catch (err: any) {
    // Don't fail the spawn if config write fails — codex may still
    // prompt, but at least the spawn isn't blocked by our pre-flight.
    console.warn(`Warning: Could not pre-trust ${absolutePath} in Codex config: ${err.message}`);
  }
}
