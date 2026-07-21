// Commands whose trailing positionals are free text (a message or title). The value is
// the positional index (the command word is positional 0) at which the free-text tail
// begins; once reached, no further tokens are scanned for the global --swarm/-s flag, so
// a message like `broadcast deploy with -s now` is never truncated and never silently
// rerouted to another swarm. Use --swarm BEFORE the message (e.g. `send --swarm x bob "hi"`).
export const FREE_TEXT_TAIL_AT: Record<string, number> = {
  send: 2,
  broadcast: 1,
  rename: 2,
  'rename-workspace': 2,
};

/**
 * Split the global `--swarm`/`-s` selector out of the argument list. The selector is only
 * honored in the "flag region" — once a command's free-text tail begins (see
 * FREE_TEXT_TAIL_AT) every remaining token is treated as literal message/title text.
 */
export function parseGlobalFlags(input: string[]): { args: string[]; swarmName: string | undefined } {
  const stripped: string[] = [];
  let swarmName: string | undefined;
  let positionals = 0;
  let freeTextStart = Infinity;

  for (let i = 0; i < input.length; i += 1) {
    const arg = input[i];

    // Conventional argv boundary: everything after a literal -- belongs to the
    // subcommand (notably `swarm run`) and must never be reinterpreted globally.
    if (arg === '--') {
      stripped.push(...input.slice(i));
      break;
    }

    // Inside a command's free-text tail every token is literal (part of the message/title).
    if (positionals >= freeTextStart) {
      stripped.push(arg);
      continue;
    }

    if (arg === '--swarm' || arg === '-s') {
      swarmName = input[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--swarm=')) {
      swarmName = arg.slice('--swarm='.length);
      continue;
    }

    stripped.push(arg);
    if (!arg.startsWith('-')) {
      if (positionals === 0 && Object.prototype.hasOwnProperty.call(FREE_TEXT_TAIL_AT, arg)) {
        freeTextStart = FREE_TEXT_TAIL_AT[arg];
      }
      positionals += 1;
    }
  }

  return { args: stripped, swarmName };
}
