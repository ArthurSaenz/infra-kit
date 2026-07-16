#!/usr/bin/env node
// TaskCompleted gate: runs `pnpm run qa` and blocks completion (exit 2) if it fails.

import { spawnSync } from 'node:child_process';
import { readInput, block, allow } from './hooklib.mjs';

let input;
try {
  input = readInput();
} catch {
  input = { taskSubject: '' };
}

const cwd = process.env.CLAUDE_PROJECT_DIR;
if (!cwd) block('quality-gate: CLAUDE_PROJECT_DIR not set — cannot run QA, failing closed.');

const result = spawnSync('pnpm', ['run', 'qa'], { cwd, stdio: 'inherit' });

if (result.status !== 0) {
  block(
    `QA checks not passing (prettier, eslint, typecheck, or tests). Fix before completing: ${input.taskSubject}`,
  );
}

allow();
