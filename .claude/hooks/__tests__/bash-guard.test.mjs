import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHook, bash } from './helpers.mjs';

import * as destructive from '../guards/destructive.mjs';
import * as suggest from '../guards/suggest.mjs';
import * as cmux from '../guards/cmux.mjs';
import * as worktree from '../guards/worktree.mjs';

const action = (decision) => decision?.action ?? null;

// -------------------------------------------------------------- unit: guard functions

test('destructive: blocks rm -rf / force push / SQL drops, ignores safe commands', () => {
  assert.equal(action(destructive.check('rm -rf /tmp/x')), 'block');
  assert.equal(action(destructive.check('git push origin main --force')), 'block');
  assert.equal(action(destructive.check('drop table users')), 'block');
  assert.equal(action(destructive.check('truncate foo')), 'block');
  assert.equal(action(destructive.check('echo "rm -rf /"')), 'block'); // known substring false-positive, preserved
  assert.equal(action(destructive.check('git status')), null);
});

test('suggest: blocks npm/yarn/grep/find, respects the exact subcommand allowlist', () => {
  assert.equal(action(suggest.check('npm install')), 'block');
  assert.equal(action(suggest.check('npm run build')), 'block');
  assert.equal(action(suggest.check('yarn add foo')), 'block');
  assert.equal(action(suggest.check('grep foo file')), 'block');
  assert.equal(action(suggest.check('find . -name "*.ts"')), 'block');
  assert.equal(action(suggest.check('npm ci')), null); // not install|run|test
  assert.equal(action(suggest.check('yarn install')), null); // not add|run|test
  assert.equal(action(suggest.check('grep foo file | wc -l')), null); // piped -> no nudge
  assert.equal(action(suggest.check('pnpm build')), null);
});

test('cmux: blocks bare dev server, allows cmux-wrapped', () => {
  assert.equal(action(cmux.check('pnpm dev')), 'block');
  assert.equal(action(cmux.check('pnpm run dev')), 'block');
  assert.equal(action(cmux.check('cmux new-session -d -s dev "pnpm dev"')), null);
  assert.equal(action(cmux.check('pnpm build')), null);
});

test('worktree: blocks managed add/remove (incl. -C / env prefixes), advises list, ignores ad-hoc', () => {
  assert.equal(action(worktree.check('git worktree add ../repo-worktrees/feat')), 'block');
  assert.equal(action(worktree.check('git worktree remove ../repo-worktrees/feat')), 'block');
  assert.equal(action(worktree.check('git -C /repo worktree add ../repo-worktrees/x')), 'block');
  assert.equal(action(worktree.check('FOO=1 git worktree add ../repo-worktrees/x')), 'block');
  assert.equal(action(worktree.check('git worktree list')), 'advise');
  assert.equal(action(worktree.check('git worktree add /tmp/adhoc')), null);
  assert.equal(action(worktree.check('git commit -m "worktree add note"')), null);
});

// -------------------------------------------------------------- integration: dispatcher

test('bash-guard blocks when any guard blocks (exit 2)', () => {
  for (const command of [
    'rm -rf /tmp/x',
    'git push origin main --force',
    'npm install',
    'pnpm dev',
    'git worktree add ../repo-worktrees/feat',
    'rm -rf /tmp/x && npm install', // multiple guards -> first block wins
  ]) {
    assert.equal(runHook('bash-guard.mjs', bash(command)).status, 2, command);
  }
});

test('bash-guard allows clean commands (exit 0)', () => {
  for (const command of ['git status', 'ls -la', 'pnpm build', 'grep foo file | wc -l']) {
    assert.equal(runHook('bash-guard.mjs', bash(command)).status, 0, command);
  }
});

test('bash-guard advises on git worktree list (exit 0 + additionalContext)', () => {
  const res = runHook('bash-guard.mjs', bash('git worktree list'));
  assert.equal(res.status, 0);
  assert.match(res.stdout, /additionalContext/);
});

test('bash-guard ignores non-Bash tools and fails open on malformed input', () => {
  assert.equal(runHook('bash-guard.mjs', { tool_name: 'Read', tool_input: {} }).status, 0);
  assert.equal(runHook('bash-guard.mjs', '{bad json').status, 0);
});
