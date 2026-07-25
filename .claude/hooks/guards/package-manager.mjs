// This repo is a pnpm workspace: an `npm install` writes package-lock.json and a flat node_modules
// that pnpm did not plan, and `yarn` does the same with its own lockfile. That is a correctness
// rule, not a style preference, so this guard BLOCKS rather than advises — unlike its former
// housemate in `suggest`, which bundled the two kinds of rule together and made neither convincing.
//
// Checked per shell segment, which is the half of the old rule that was quietly broken: `suggest`
// read the whole line while anchoring at ^, so `cd apps/client && npm install` sailed through. The
// segment split puts `npm install` at the head of its own segment, where the anchor can see it.
//
// Anchored at the head of the segment rather than matched loose, so the guard fires on the command
// being RUN and not on the word appearing anywhere: `pnpm exec npm-run-all`, `cat /etc/npmrc` and
// `rg npm docs/` all stay allowed. The `(?=\s|$)` lookahead is what keeps `npm` from matching the
// `npm-run-all` prefix — a token boundary, not a `\b`, because `\b` sits happily before a hyphen.
//
// Case-insensitive on purpose — see the note on case in guards/destructive.mjs: macOS resolves
// `NPM install` to the real binary, so a case-sensitive guard would be enforcing a rule the
// filesystem is not.
//
// NOT covered, deliberately: a payload inside `bash -c "npm install"` is never parsed (the quoted
// string is not a segment), aliases, `$(echo npm) install`, and path-qualified spellings like
// `/usr/local/bin/npm install` or `./npm install`. Also, because `splitIntoSegments` splits on
// newlines, a heredoc body whose line begins with `npm install` blocks — text mistaken for a
// command, accepted because it fails in the safe direction. This is a workspace-hygiene guard, not
// a security boundary; the human can always run the command themselves.

import { HEAD_PREFIX } from '../hooklib.mjs';

export const name = 'package-manager';

export const scope = 'segment';

// `pnpm`/`pnpx` are safe by construction: the anchor means a leading `p` fails the match before the
// alternation is ever consulted.
const RE_FOREIGN_PM = new RegExp(`${HEAD_PREFIX}(npm|yarn|npx)(?=\\s|$)`, 'i');

const MESSAGE = [
  'This is a pnpm workspace — npm and yarn write a competing lockfile and a node_modules layout',
  'pnpm did not plan. Use pnpm instead:',
  '    npm install / npm i / npm ci   ->  pnpm install',
  '    npm add x / yarn add x         ->  pnpm add x',
  '    npm run x / yarn x             ->  pnpm run x',
  '    npm exec x / npx x             ->  pnpm exec x   (or pnpm dlx x)',
].join('\n');

export function check(command) {
  if (RE_FOREIGN_PM.test(command)) {
    return { action: 'block', message: MESSAGE };
  }
  return null;
}
