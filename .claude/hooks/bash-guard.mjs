#!/usr/bin/env node
// Every advisory Bash rule, in one file. First block wins; a guard that throws fails open.
// Deploy guard is a separate process on purpose — see README.md.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readInput, block, addContext, allow, splitIntoSegments, HEAD_PREFIX, argvAfterPrefix } from './hooklib.mjs';

// ------------------------------------------------------------------ doppler

// Gated on the SUBCOMMAND: `secrets get X` prints values without `--plain` too.
const RE_DOPPLER_SECRETS = new RegExp(`${HEAD_PREFIX}doppler\\s+secrets(?=\\s|$)`, 'i');

const DOPPLER_MESSAGE = [
  '`doppler secrets` prints secret values to stdout, and stdout is kept in this transcript',
  "permanently. Load env the repo's way instead:",
  '    doppler secrets download --no-file   ->  ik env-load -c <config>',
  '    doppler secrets get X --plain        ->  ik env-load -c <config>, then read it in-process',
  '',
  '`ik env-load` runs the same download and prints a 0600 file path to source, not the values.',
  'To inspect without values: `ik env-status`.',
  '',
  'If a human genuinely needs one value, they run `doppler secrets get X --plain` in their own',
  'terminal or read it from the Doppler dashboard. This rule binds agents only.',
].join('\n');

export const doppler = {
  name: 'doppler',
  scope: 'segment',
  check(command) {
    if (RE_DOPPLER_SECRETS.test(command)) return { action: 'block', message: DOPPLER_MESSAGE };
    return null;
  },
};

// ------------------------------------------------------------------ destructive

// Every flag token, not just the one after `rm` — catches `rm -f -r ./dist`. `-r` alone is routine.
const isForceRecursiveRemove = (argv) => {
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
};

const RE_GIT_PUSH = new RegExp(`${HEAD_PREFIX}git\\s+push\\b`, 'i');
// Bare force only; `--force-with-lease` continues past the lookahead.
const RE_FORCE_FLAG = /(^|\s)(-f|--force)(?=\s|$)/;
// Near-dead after anchoring; mostly heredocs fed to a SQL client.
const RE_SQL = new RegExp(`${HEAD_PREFIX}(drop\\s+(table|database)\\b|truncate\\s)`, 'i');

export const destructive = {
  name: 'destructive',
  scope: 'segment',
  check(command) {
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
  },
};

// ------------------------------------------------------------------ package-manager

// `(?=\s|$)` not `\b`, which sits happily before the hyphen in `npm-run-all`.
const RE_FOREIGN_PM = new RegExp(`${HEAD_PREFIX}(npm|yarn|npx)(?=\\s|$)`, 'i');

const PM_MESSAGE = [
  'This is a pnpm workspace — npm and yarn write a competing lockfile and a node_modules layout',
  'pnpm did not plan. Use pnpm instead:',
  '    npm install / npm i / npm ci   ->  pnpm install',
  '    npm add x / yarn add x         ->  pnpm add x',
  '    npm run x / yarn x             ->  pnpm run x',
  '    npm exec x / npx x             ->  pnpm exec x   (or pnpm dlx x)',
].join('\n');

export const packageManager = {
  name: 'package-manager',
  scope: 'segment',
  check(command) {
    if (RE_FOREIGN_PM.test(command)) return { action: 'block', message: PM_MESSAGE };
    return null;
  },
};

// ------------------------------------------------------------------ style

// Whole-line by design: `(?!.*\|)` allows `grep foo | wc -l`, segmenting would strip the pipe.
const STYLE_SUGGESTIONS = [
  [/^grep\b(?!.*\|)/, "Prefer 'rg' (ripgrep) over 'grep' — faster, and it respects .gitignore."],
  [/^find\s+\S+\s+-name\b/, "Prefer 'rg --files | rg pattern' over 'find -name'."],
];

export const style = {
  name: 'style',
  check(command) {
    const tips = STYLE_SUGGESTIONS.filter(([re]) => re.test(command)).map(([, tip]) => `* ${tip}`);
    if (tips.length > 0) return { action: 'advise', context: tips.join('\n') };
    return null;
  },
};

// ------------------------------------------------------------------ cmux

// Head-anchored or it blocks `rg "pnpm dev" docs/`. Segments internally rather than declaring
// scope: the splitter would drop the `cmux` authorising `cmux new-session … "cd x && pnpm dev"`.
const RE_DEV_SERVER = new RegExp(String.raw`${HEAD_PREFIX}pnpm\s+(run\s+)?dev`, 'i');

export const cmux = {
  name: 'cmux',
  check(command) {
    if (command.includes('cmux')) return null;

    const startsDevServer = splitIntoSegments(command).some((segment) => RE_DEV_SERVER.test(segment));
    if (startsDevServer) {
      return {
        action: 'block',
        message: 'Dev servers must run in cmux. Use: cmux new-session -d -s dev "pnpm dev"',
      };
    }

    return null;
  },
};

// ------------------------------------------------------------------ worktree

// Path-independent: `add ../my-branch` skips infra-kit's setup precisely BY landing outside the
// managed dir. Own prefix, since HEAD_PREFIX does not swallow `-C <path>`.
const GIT_PREFIX = String.raw`^([A-Za-z_][A-Za-z0-9_]*=[^ ]+ +)*git +(-C +[^ ]+ +|--git-dir=[^ ]+ +)*worktree +`;

const RE_MANAGED = new RegExp(`${GIT_PREFIX}(add|remove)\\b`);
const RE_LIST = new RegExp(`${GIT_PREFIX}list\\b`);

const WORKTREE_BLOCK_MSG =
  "Use infra-kit's MCP worktree tools instead of raw 'git worktree add/remove': 'worktrees-add' / 'worktrees-remove'. Raw git skips infra-kit's setup (pnpm install, IDE open, release description), which is why the branch works but the worktree is half-configured. If you are inside a linked worktree, cd to the main checkout first — both raw git and the MCP tool refuse worktree management from within a linked worktree. If you truly want an unmanaged throwaway worktree, ask the user to run the git command themselves.";

const WORKTREE_ADVISE_MSG =
  "There is also an infra-kit 'worktrees-list' MCP tool that returns a structured release-worktree summary (version, release type, Jira description). Prefer it for release-worktree info; keep using 'git worktree list' when you need the full inventory (feature/ad-hoc worktrees, the main checkout, paths or HEADs), which the MCP tool does not cover.";

export const worktree = {
  name: 'worktree',
  scope: 'segment',
  check(command) {
    if (RE_MANAGED.test(command)) return { action: 'block', message: WORKTREE_BLOCK_MSG };
    if (RE_LIST.test(command)) return { action: 'advise', context: WORKTREE_ADVISE_MSG };
    return null;
  },
};

// ------------------------------------------------------------------ dispatcher

// `doppler` first: when a command trips two guards, the one about secrets is worth showing.
export const GUARDS = [doppler, destructive, packageManager, style, cmux, worktree];

const decide = (guard, command, segments) => {
  const inputs = guard.scope === 'segment' ? segments : [command];

  for (const text of inputs) {
    const decision = guard.check(text);
    if (decision) return decision;
  }

  return null;
};

const main = () => {
  let input;
  try {
    input = readInput();
  } catch {
    allow(); // malformed event: advisory guards fail open
  }

  if (input.toolName !== 'Bash' || !input.command) allow();

  const segments = splitIntoSegments(input.command);
  let advice = null;

  for (const guard of GUARDS) {
    let decision;
    try {
      decision = decide(guard, input.command, segments);
    } catch (err) {
      process.stderr.write(`bash-guard: guard "${guard.name}" failed open: ${err.message}\n`);
      continue;
    }

    if (!decision) continue;
    if (decision.action === 'block') block(decision.message);
    if (decision.action === 'advise' && advice === null) advice = decision.context;
  }

  if (advice !== null) addContext(advice);
  allow();
};

// So the tests can import the guards without this reading fd 0. NOT `import.meta.main`: Node 24.2+
// only, `undefined` below it, so every guard would no-op with the suite green. Pinned by hook-map.
const invokedDirectly = () => {
  const entry = process.argv[1];
  if (!entry) return false;

  try {
    // realpath: Node resolves symlinks when it loads the module, so argv[1] must be resolved too.
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
};

if (invokedDirectly()) main();
