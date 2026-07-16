#!/usr/bin/env node
//
// Runs the advisory Bash guards in one process. Each guard is a pure `check(command)`; first to
// block wins, otherwise any advisory context is surfaced. A guard that throws fails open (warned
// on stderr) so one bug can't swallow the rest. The deploy guard is separate — it fails closed.

import { readInput, block, addContext, allow } from './hooklib.mjs';
import * as destructive from './guards/destructive.mjs';
import * as suggest from './guards/suggest.mjs';
import * as cmux from './guards/cmux.mjs';
import * as worktree from './guards/worktree.mjs';

const GUARDS = [destructive, suggest, cmux, worktree];

let input;
try {
  input = readInput();
} catch {
  allow(); // malformed event: advisory guards fail open
}

if (input.toolName !== 'Bash' || !input.command) allow();

let advice = null;

for (const guard of GUARDS) {
  let decision;
  try {
    decision = guard.check(input.command);
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
