#!/usr/bin/env node
// After a source/test edit, runs the related vitest in the file's package and reports FAILURES to
// Claude via hookSpecificOutput.additionalContext (the async->Claude channel). Silent on pass.
// Wired async in settings so it never blocks. Skips files outside a package.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readInput, addContext, allow, findPackageDir } from './hooklib.mjs';

let input;
try {
  input = readInput();
} catch {
  allow();
}

const filePath = input.filePath;
if (!/\.(ts|tsx|js|jsx)$/.test(filePath)) allow();

const pkgDir = findPackageDir(filePath);
if (!pkgDir) allow();

const abs = resolve(filePath);
const isTestFile = /\.test\.(ts|tsx)$/.test(filePath);
const args = isTestFile
  ? ['exec', 'vitest', 'run', abs, '--reporter=minimal']
  : ['exec', 'vitest', 'related', abs, '--run', '--reporter=minimal'];

const result = spawnSync('pnpm', args, { cwd: pkgDir, encoding: 'utf8' });

if (result.status !== 0) {
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  // Async hooks reach Claude ONLY via hookSpecificOutput.additionalContext (systemMessage is
  // user-only). Report failures; stay silent on pass — a passing suite needs no Claude action.
  addContext(`Tests failed after editing ${abs}:\n${output}`, 'PostToolUse');
}

allow();
