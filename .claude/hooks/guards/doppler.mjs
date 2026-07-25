// `doppler secrets` prints secret VALUES to stdout, and an agent's stdout is transcribed
// permanently. That is the whole of the rule: not that the command is dangerous, but that its
// output lands somewhere durable. infra-kit itself runs `doppler secrets download --no-file` from
// inside `ik env-load` (a zx child process the Bash hook never observes) and that stays working —
// the difference is where the bytes go, not which binary produced them.
//
// Gated on the SUBCOMMAND rather than on flags, which is the non-obvious half. `--plain` only
// removes formatting: `doppler secrets get API_KEY` already prints the value in a table, as does
// bare `doppler secrets`. A flag-based rule would block the verbose spelling and wave the shortest
// one through. Every read path under `secrets` prints values by default, so the subcommand is the
// honest unit. `--only-names` is the one safe read, and it is blocked too — `ik env-status` covers
// that need and carving out an exception would cost the single `permissions.deny` prefix in
// settings.json, which cannot express "unless".
//
// BLOCKS rather than advises, unlike `style`: advisory context arrives AFTER the command runs, and
// a printed secret cannot be un-printed. There is no useful middle setting here.
//
// `doppler run` is deliberately NOT covered, in either spelling. Blocking `run --command '<cmd>'`
// while allowing `run -- <cmd>` looks like a distinction and is not one: `doppler run -- env`,
// `-- printenv`, and `-- node -e 'console.log(process.env)'` all dump the same set. A half-rule
// there would buy nothing except a demonstration of which spelling is watched, and blocking both
// would take out `doppler run -- pnpm build`, the common legitimate use.
//
// Case-insensitive on purpose — see the note on case in guards/destructive.mjs.
//
// NOT covered, deliberately: `cat .env`, `env`, `printenv`, and `cat "$(ik env-load -c dev)"` all
// reach the same values (`ik env-load` writes a 0600 plaintext file and prints its path), and
// `Bash(cat:*)` is allow-listed in settings.local.json. So are `aws secretsmanager get-secret-value`
// and `gh secret list`. The MCP tool `mcp__infra-kit__env-load` bypasses this entirely — hooks here
// match on `Bash`, not on MCP calls. Nor are payloads inside `bash -c "doppler secrets get X"` (the
// quoted string is not a segment), aliases, path-qualified spellings (`/opt/homebrew/bin/doppler`,
// `./doppler`), `$(which doppler) secrets`, or `doppler secrets get --copy`, which writes to the
// clipboard and never touches stdout at all. Because `splitIntoSegments` splits on newlines, a
// heredoc line beginning with `doppler secrets` blocks — text mistaken for a command, accepted
// because it fails in the safe direction.
//
// This is a transcript-hygiene guard, not a security boundary; the human can always run the
// command themselves. It stops the `doppler secrets download --no-file` typed while debugging an
// env issue, not an agent that means to read a secret.

import { HEAD_PREFIX } from '../hooklib.mjs';

export const name = 'doppler';

export const scope = 'segment';

const RE_DOPPLER_SECRETS = new RegExp(`${HEAD_PREFIX}doppler\\s+secrets(?=\\s|$)`, 'i');

const MESSAGE = [
  '`doppler secrets` prints secret values to stdout, and stdout is kept in this transcript',
  'permanently. Load env the repo\'s way instead:',
  '    doppler secrets download --no-file   ->  ik env-load -c <config>',
  '    doppler secrets get X --plain        ->  ik env-load -c <config>, then read it in-process',
  '',
  '`ik env-load` runs the same download and prints a 0600 file path to source, not the values.',
  'To inspect without values: `ik env-status`.',
  '',
  'If a human genuinely needs one value, they run `doppler secrets get X --plain` in their own',
  'terminal or read it from the Doppler dashboard. This rule binds agents only.',
].join('\n');

export function check(command) {
  if (RE_DOPPLER_SECRETS.test(command)) {
    return { action: 'block', message: MESSAGE };
  }
  return null;
}
