#!/usr/bin/env node
// Formats the just-edited file: prettier (root config) + eslint --fix run in the file's package
// so its flat config resolves. Silent, best-effort, never blocks.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readInput, allow, findPackageDir } from './hooklib.mjs';

let input;

try {
  input = readInput();
} catch {
  allow();
}

const filePath = input.filePath;
if (!filePath) allow();

const abs = resolve(filePath);

if (/\.(ts|tsx|js|jsx|json|css|scss|mjs|cjs)$/.test(filePath)) {
  spawnSync('pnpm', ['exec', 'prettier', '--log-level', 'silent', '--write', abs], {
    stdio: 'ignore',
  });
}

if (/\.(ts|tsx|js|jsx)$/.test(filePath)) {
  const pkgDir = findPackageDir(filePath);
  if (pkgDir) {
    spawnSync('pnpm', ['exec', 'eslint', '--quiet', '--fix', abs], { cwd: pkgDir, stdio: 'ignore' });
  }
}

allow();
