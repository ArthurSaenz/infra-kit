import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHook, bash } from './helpers.mjs';

import * as doppler from '../guards/doppler.mjs';
import * as destructive from '../guards/destructive.mjs';
import * as packageManager from '../guards/package-manager.mjs';
import * as style from '../guards/style.mjs';
import * as cmux from '../guards/cmux.mjs';
import * as worktree from '../guards/worktree.mjs';

const action = (decision) => decision?.action ?? null;

// -------------------------------------------------------------- unit: guard functions

test('destructive: blocks rm -rf / bare force push / SQL drops, ignores safe commands', () => {
  assert.equal(action(destructive.check('rm -rf /tmp/x')), 'block');
  assert.equal(action(destructive.check('rm -fr /tmp/x')), 'block');
  assert.equal(action(destructive.check('sudo rm -rf /tmp/x')), 'block');
  assert.equal(action(destructive.check('git push origin main --force')), 'block');
  assert.equal(action(destructive.check('git push -f origin main')), 'block'); // was missed entirely
  assert.equal(action(destructive.check('drop table users')), 'block');
  assert.equal(action(destructive.check('truncate foo')), 'block');
  assert.equal(action(destructive.check('git status')), null);
});

// Flags are scanned as a set, not just the token right after `rm` — `-\S*[rR]` only ever saw the
// first one, so the ordinary `rm -f -r ./dist` walked past a guard built to catch exactly it.
test('destructive: rm force+recursive in any order or spelling', () => {
  for (const command of [
    'rm -rf x',
    'rm -fr x',
    'rm -Rf x',
    'rm -r -f x',
    'rm -f -r x',
    'rm --recursive --force x',
    'env FOO=1 rm -rf x',
  ]) {
    assert.equal(action(destructive.check(command)), 'block', command);
  }
});

// BOTH flags are required. Plain recursive delete is routine in a monorepo, and blocking it under
// a "force-remove" label would describe a flag the user did not pass.
test('destructive: recursive without force is allowed', () => {
  assert.equal(action(destructive.check('rm -r dir')), null);
  assert.equal(action(destructive.check('rm -i -r dir')), null);
  assert.equal(action(destructive.check('rm --recursive dir')), null);
  assert.equal(action(destructive.check('rm file.txt')), null);
});

// The guard is now head-anchored, so a pattern quoted INSIDE an argument is no longer mistaken for
// the command being run. Both of these blocked before and were false positives.
test('destructive: no longer fires on its own patterns quoted inside an argument', () => {
  assert.equal(action(destructive.check('echo "rm -rf /"')), null);
  assert.equal(action(destructive.check('git commit -m "remove truncate stuff"')), null);
});

// --force-with-lease is the SAFE force push; blocking it drove people to bare --force.
test('destructive: allows --force-with-lease', () => {
  assert.equal(action(destructive.check('git push --force-with-lease origin main')), null);
  assert.equal(action(destructive.check('git push --force-with-lease')), null);
  assert.equal(action(destructive.check('git push --force-with-lease=origin/main')), null);
  assert.equal(action(destructive.check('git push --force-if-includes')), null);
  assert.equal(action(destructive.check('git push origin my-f-branch')), null); // -f inside a name
});

test('package-manager: blocks every npm/yarn/npx entrypoint, not a hand-picked few', () => {
  for (const command of [
    'npm install',
    'npm i',
    'npm ci', // all three were allowed before
    'npm add lodash',
    'npm exec tsc',
    'npm run build',
    'npm test',
    'npm update',
    'npm uninstall foo',
    'yarn install', // allowed before
    'yarn build', // allowed before
    'yarn add foo',
    'npx tsc', // allowed before
  ]) {
    assert.equal(action(packageManager.check(command)), 'block', command);
  }
});

// Wrapper words shared via hooklib's HEAD_PREFIX. `env FOO=1 npm i` was the sharp one: the bare
// `FOO=1 npm i` spelling was already covered, so missing the `env` form was an inconsistency.
test('package-manager: sees through wrapper-word prefixes', () => {
  for (const command of [
    'env FOO=1 npm i',
    'command npm install',
    'time npm install',
    'nice npm i',
    'exec npm ci',
    'xargs npm install',
    'CI=1 npm ci',
    'sudo npm i -g x',
  ]) {
    assert.equal(action(packageManager.check(command)), 'block', command);
  }
});

// The subcommand IS the unit: `--plain` only drops formatting, so the bare `secrets get X` prints
// the value too. A flag-based rule would block the long spelling and pass the short one.
test('doppler: blocks every secrets read path, flags or not', () => {
  for (const command of [
    'doppler secrets',
    'doppler secrets --only-names',
    'doppler secrets get API_KEY',
    'doppler secrets get API_KEY --plain',
    'doppler secrets get API_KEY --json',
    'doppler secrets download',
    'doppler secrets download --no-file --format env',
    'doppler secrets set FOO=bar',
    'doppler secrets upload .env',
    'env FOO=1 doppler secrets get X', // wrapper words via HEAD_PREFIX
    'sudo doppler secrets download',
  ]) {
    assert.equal(action(doppler.check(command)), 'block', command);
  }
});

// `run` is out of scope in BOTH spellings: `run -- env` leaks exactly as `run --command 'env'`
// does, so blocking one is theater — and blocking both takes out `run -- pnpm build`.
test('doppler: leaves run and the metadata subcommands alone', () => {
  for (const command of [
    'doppler run -- pnpm build',
    'doppler run --command "pnpm build"',
    'doppler setup',
    'doppler me',
    'doppler projects',
    'doppler configure',
    'doppler --version',
    'git commit -m "use doppler secrets get"', // head anchor: quoted, not run
    'rg doppler docs/',
    'cat .doppler.yaml',
  ]) {
    assert.equal(action(doppler.check(command)), null, command);
  }
});

// style must never export scope: its piped-grep allowance depends on reading the whole line.
test('guard scope contracts are what the dispatcher expects', () => {
  assert.equal(doppler.scope, 'segment');
  assert.equal(packageManager.scope, 'segment');
  assert.equal(destructive.scope, 'segment');
  assert.equal(style.scope, undefined);
  assert.equal(cmux.scope, undefined);
});

test('package-manager: does not fire on pnpm, or on the word npm inside another token', () => {
  for (const command of [
    'pnpm build',
    'pnpm install',
    'pnpx foo',
    'pnpm exec tsc',
    'pnpm dlx foo',
    'pnpm exec npm-run-all', // token boundary, not \b
    'cat /etc/npmrc',
    'rg npm docs/',
    './node_modules/.bin/tsc',
  ]) {
    assert.equal(action(packageManager.check(command)), null, command);
  }
});

test('style: advises (never blocks) on grep/find, stays quiet on piped grep', () => {
  assert.equal(action(style.check('grep foo file')), 'advise');
  assert.equal(action(style.check('find . -name "*.ts"')), 'advise');
  assert.equal(action(style.check('grep foo file | wc -l')), null); // piped -> no nudge
  assert.equal(action(style.check('rg foo')), null);
});

test('cmux: blocks bare dev server, allows cmux-wrapped', () => {
  assert.equal(action(cmux.check('pnpm dev')), 'block');
  assert.equal(action(cmux.check('pnpm run dev')), 'block');
  assert.equal(action(cmux.check('cmux new-session -d -s dev "pnpm dev"')), null);
  assert.equal(action(cmux.check('pnpm build')), null);
});

test('worktree: blocks add/remove at any path (incl. -C / env prefixes), advises list', () => {
  assert.equal(action(worktree.check('git worktree add ../repo-worktrees/feat')), 'block');
  assert.equal(action(worktree.check('git worktree remove ../repo-worktrees/feat')), 'block');
  assert.equal(action(worktree.check('git -C /repo worktree add ../repo-worktrees/x')), 'block');
  assert.equal(action(worktree.check('FOO=1 git worktree add ../repo-worktrees/x')), 'block');
  assert.equal(action(worktree.check('git worktree add ../fix-post-script-ci-cd')), 'block'); // ad-hoc path: no longer exempt
  assert.equal(action(worktree.check('git worktree add /tmp/adhoc')), 'block');
  assert.equal(action(worktree.check('git worktree list')), 'advise');
  assert.equal(action(worktree.check('git commit -m "worktree add note"')), null);
  assert.equal(action(worktree.check('git worktree prune')), null);
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
    'cd /repo && git worktree add ../repo-worktrees/x', // segment-scoped: ^ anchor survives the &&
    'echo hi; git worktree add ../adhoc',
    'cd apps/client && npm install', // segment-scoped: the hole that motivated the split
    'echo hi; yarn install',
    'doppler secrets get API_KEY',
    'cd apps/api && doppler secrets download --no-file', // segment-scoped: ^ anchor survives the &&
  ]) {
    assert.equal(runHook('bash-guard.mjs', bash(command)).status, 2, command);
  }
});

test('bash-guard allows clean commands (exit 0)', () => {
  for (const command of [
    'git status',
    'ls -la',
    'pnpm build',
    'grep foo file | wc -l',
    'git push --force-with-lease origin main',
    'pnpm exec npm-run-all',
    'doppler run -- pnpm build',
    'doppler setup',
  ]) {
    assert.equal(runHook('bash-guard.mjs', bash(command)).status, 0, command);
  }
});

// A style tip must cost nothing: the command still runs, the advice rides along as context.
test('bash-guard advises rather than blocks on grep (exit 0 + additionalContext)', () => {
  const res = runHook('bash-guard.mjs', bash('grep foo file'));
  assert.equal(res.status, 0);
  assert.match(res.stdout, /additionalContext/);
  assert.match(res.stdout, /ripgrep/);
});

// Segmentation is opt-in per guard: whole-line guards must keep reading the whole line, or their
// deliberate allowances (piped grep, cmux-wrapped dev) would flip to blocks.
test('bash-guard does not segment whole-line guards', () => {
  assert.equal(runHook('bash-guard.mjs', bash('rg foo | grep bar')).status, 0);
  assert.equal(runHook('bash-guard.mjs', bash('cmux new-session -d -s dev "pnpm dev"')).status, 0);
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
