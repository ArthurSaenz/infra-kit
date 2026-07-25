// Shared helpers for Claude Code hooks: parse the stdin event, then allow / block / add context.
// Node stdlib only, so a hook can never be broken by a dependency.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Throws on malformed/empty stdin; callers choose fail-closed (block) or fail-open (allow).
export function readInput() {
  const data = JSON.parse(readFileSync(0, 'utf8'));
  const toolInput = data.tool_input ?? {};

  return {
    toolName: data.tool_name ?? '',
    toolInput,
    command: toolInput.command ?? '',
    filePath: toolInput.file_path ?? '',
    message: data.message ?? '',
    taskSubject: data.task_subject ?? '',
    raw: data,
  };
}

// Split a command line on shell operators, so a guard anchored at ^ still sees `git worktree add`
// in `cd /repo && git worktree add ...`. Two-char operators before their single-char prefixes.
// Naive: quoted operators split too, which over-splits rather than under-splits — a guard sees more
// candidate segments, never fewer.
export function splitIntoSegments(command) {
  return command
    .replaceAll('&&', '\n')
    .replaceAll('||', '\n')
    .replaceAll(';', '\n')
    .replaceAll('|', '\n')
    .replaceAll('&', '\n')
    .split('\n')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

// Leading tokens that sit in front of the real command without being it: `VAR=val` assignments and
// the arity-less wrapper words. Shared by the segment-scoped guards so a prefix added to this list
// is covered everywhere at once — it lived in three copies before, and `env FOO=1 npm i` slipped
// past guards that handled the bare `FOO=1 npm i` spelling, purely because one copy was stale.
//
// `worktree` deliberately keeps its own variant: it also has to swallow git's `-C <path>` and
// `--git-dir=<path>`, which are git-specific and have no business here.
export const HEAD_PREFIX = String.raw`^([A-Za-z_][A-Za-z0-9_]*=\S+\s+|(sudo|doas|env|command|builtin|exec|eval|time|nice|nohup|stdbuf|xargs)\s+)*`;

// Tokens of `segment` with any HEAD_PREFIX stripped, so argv[0] is the command that will actually
// run. Case-insensitive on the prefix words for the same reason the guards are: see the note on
// case in guards/destructive.mjs.
export function argvAfterPrefix(segment) {
  return segment
    .trim()
    .replace(new RegExp(HEAD_PREFIX, 'i'), '')
    .split(/\s+/)
    .filter(Boolean);
}

export function block(message) {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  process.exit(2);
}

export function allow() {
  process.exit(0);
}

export function addContext(text, event = 'PreToolUse') {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: text },
    }),
  );
  process.exit(0);
}

// Nearest directory at or above `filePath` that holds a package.json, so per-package tooling
// (tsc, eslint, vitest) runs where its config lives instead of at the config-less monorepo root.
// Bounded by CLAUDE_PROJECT_DIR when set; returns null if none is found.
export function findPackageDir(filePath) {
  const boundary = process.env.CLAUDE_PROJECT_DIR
    ? resolve(process.env.CLAUDE_PROJECT_DIR)
    : null;
  let dir = dirname(resolve(filePath));

  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dir === boundary) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
