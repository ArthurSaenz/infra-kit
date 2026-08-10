#!/usr/bin/env node
// Fail-closed wrapper: a syntax error in block-deploy.mjs exits 1, and exit 1 does not block — so a
// typo would disarm the guard silently. Any exit outside {0, 2} becomes a deny.
// NEVER add a relative import here; hook-map.test.mjs enforces that.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'block-deploy.mjs');

// The child cannot inherit an already-consumed fd 0.
let event = '';
try {
  event = readFileSync(0, 'utf8');
} catch {
  event = '';
}

const result = spawnSync(process.execPath, [GUARD], { input: event, encoding: 'utf8' });

// Anything outside {0, 2} means the guard never ran.
if (result.status !== 0 && result.status !== 2) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `bash-launcher: the deploy guard failed to run (exit ${result.status}) — failing closed. ` +
          'block-deploy.mjs is likely unparseable or missing; fix it before running Bash commands.',
      },
    }),
  );
  process.exit(0);
}

process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status);
