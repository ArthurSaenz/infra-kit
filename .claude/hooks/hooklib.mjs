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
