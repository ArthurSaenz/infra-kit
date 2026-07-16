// Shared test helpers. All hooks are Node scripts invoked as `node <path>` with a JSON event on
// stdin — exactly how Claude Code runs them — so we assert on real exit codes and output.

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export const HOOKS_DIR = join(import.meta.dirname, '..');

// chmodStrip proves a hook blocks even without its exec bit. It runs a mode-stripped COPY in a
// temp dir — never the tracked source — so the test suite leaves the working tree clean. Only
// safe for self-contained hooks (block-deploy) with no relative imports to resolve.
export function runHook(file, event, { chmodStrip = false, env = {} } = {}) {
  let path = join(HOOKS_DIR, file);
  const stdin = typeof event === 'string' ? event : JSON.stringify(event);

  if (chmodStrip) {
    path = join(mkdtempSync(join(tmpdir(), 'hook-')), basename(file));
    copyFileSync(join(HOOKS_DIR, file), path);
    chmodSync(path, 0o644);
  }

  const r = spawnSync('node', [path], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
export const edit = (file_path) => ({ tool_name: 'Write', tool_input: { file_path } });
