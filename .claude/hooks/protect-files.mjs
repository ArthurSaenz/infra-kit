#!/usr/bin/env node
// Blocks edits to files that must not be hand-edited (lockfile, anything under .git/).

import { readInput, block, allow } from './hooklib.mjs';

const PROTECTED_PATTERNS = ['pnpm-lock.yaml', '.git/'];

let input;
try {
  input = readInput();
} catch {
  allow();
}

for (const pattern of PROTECTED_PATTERNS) {
  if (input.filePath.includes(pattern)) {
    block(`Blocked: ${input.filePath} is a protected file`);
  }
}

allow();
