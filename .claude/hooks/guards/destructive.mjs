// Blocks recursive force-remove, force push, and SQL drops/truncates.
//
// Checked per shell segment and anchored at the segment head, which is what retired the old
// substring match. `echo "rm -rf /"` and `git commit -m "remove truncate stuff"` used to block:
// the pattern saw its own text inside a quoted argument and could not tell a command from a string.
// An anchor asks the only question that matters — is this the command being RUN? — so the quoted
// forms are allowed and the executable forms still are not.
//
// `--force-with-lease` is explicitly allowed. It is the SAFE force push: it refuses when the remote
// moved under you, which is the accident a force-push guard exists to prevent. Blocking it pushed
// people toward bare `--force`, so the rule was inverting its own purpose. The allowance is free
// rather than special-cased — `(?=\s|$)` after `--force` stops matching at the `-with-lease`
// hyphen, and the same lookahead is what keeps `--force-if-includes` allowed too.
//
// The old rule also missed `git push -f` entirely, having spelled out only `--force`.
//
// On CASE: every pattern here is case-insensitive, and on this repo's platform that is the safe
// choice rather than a sloppy one. macOS ships a case-insensitive filesystem, so `RM -RF /` and
// `NPM install` really do resolve and run. A case-sensitive guard would be reading POSIX rules the
// filesystem is not enforcing.
//
// NOT covered, deliberately: payloads inside `bash -c "rm -rf /"` (the quoted string is not a
// segment), aliases, path-qualified spellings like `/bin/rm -rf x`, and SQL sent through a client
// argument such as `psql -c "drop table users"`. One more worth naming because the head-anchor
// rationale does NOT reach it: `splitIntoSegments` splits on newlines, so a heredoc body or a
// multi-line commit message whose LINE begins with `rm -rf` is seen as its own segment and blocks.
// That is text, not a command, and it is a false positive — an accepted one, since it fails in the
// safe direction and the pre-anchor rule blocked those same inputs (and more) anyway.
// This is a seatbelt against a slip, not a boundary against intent.

import { HEAD_PREFIX, argvAfterPrefix } from '../hooklib.mjs';

export const name = 'destructive';

export const scope = 'segment';

// Recursive AND force, in any order or spelling: -rf, -fr, -Rf, -r -f, -f -r, --recursive --force.
// Requiring BOTH is deliberate. Plain `rm -r some/dir` is routine in a monorepo and is not what the
// message describes, so widening to bare `-r` would have blocked ordinary work under a label
// ("force-remove") the user could see was wrong. Scanning every flag token rather than just the
// first is the other half: `-\S*[rR]` only ever inspected the token right after `rm`, so the
// perfectly ordinary `rm -f -r ./dist` walked straight past a guard built to catch exactly it.
function isForceRecursiveRemove(argv) {
  if (argv[0]?.toLowerCase() !== 'rm') return false;

  let recursive = false;
  let force = false;

  for (const token of argv.slice(1)) {
    if (!token.startsWith('-')) continue;

    if (token.startsWith('--')) {
      if (token.toLowerCase() === '--recursive') recursive = true;
      if (token.toLowerCase() === '--force') force = true;
      continue;
    }

    const flags = token.slice(1);
    if (/[rR]/.test(flags)) recursive = true;
    if (/f/.test(flags)) force = true;
  }

  return recursive && force;
}

const RE_GIT_PUSH = new RegExp(`${HEAD_PREFIX}git\\s+push\\b`, 'i');
// Bare force only. `--force-with-lease` and `--force-if-includes` continue past the lookahead.
const RE_FORCE_FLAG = /(^|\s)(-f|--force)(?=\s|$)/;

// Near-dead after anchoring, and kept knowingly: the realistic agent spelling is
// `psql -c "drop table users"`, which the head-anchor rule allows by design. What remains is a
// heredoc fed to a SQL client, and coreutils `truncate -s 0 file` — a different program, but one
// that does empty a file, so catching it is not a mistake.
const RE_SQL = new RegExp(`${HEAD_PREFIX}(drop\\s+(table|database)\\b|truncate\\s)`, 'i');

export function check(command) {
  if (isForceRecursiveRemove(argvAfterPrefix(command))) {
    return { action: 'block', message: 'Blocked: recursive force-remove.' };
  }

  if (RE_GIT_PUSH.test(command) && RE_FORCE_FLAG.test(command)) {
    return {
      action: 'block',
      message:
        'Blocked: force push. Use --force-with-lease, which refuses when the remote has moved.',
    };
  }

  if (RE_SQL.test(command)) {
    return { action: 'block', message: 'Blocked: destructive SQL (drop/truncate).' };
  }

  return null;
}
