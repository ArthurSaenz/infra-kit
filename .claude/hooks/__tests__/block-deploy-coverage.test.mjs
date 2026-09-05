// Every guarded literal in block-deploy.mjs must be named by at least one test command.
//
// WHAT THIS PINS, AND WHAT IT DOES NOT. It pins PRESENCE, not path-exercise: it proves a literal is
// mentioned, not that the mentioning row would fail if the literal were deleted. Those differ — the
// pre-existing `stdbuf + wrapper` row named `stdbuf` while testing nothing about it, because the
// wrapper scan denied the command with `stdbuf` removed from the set.
//
// It exists for the drift mode that actually happens: someone adds `oksh` to SHELL_WRAPPERS and
// forgets the row. Proving path-exercise needs mutation testing — delete each literal, run the
// suite, require failure — which costs ~49 x 4s and is why it is not a suite member. The enumeration
// it produced is recorded in the BLOCKED rows this test guards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOKS_DIR } from './helpers.mjs';

const GUARD = readFileSync(join(HOOKS_DIR, 'block-deploy.mjs'), 'utf8');
const SUITE = readFileSync(join(HOOKS_DIR, '__tests__', 'block-deploy.test.mjs'), 'utf8');

// The suite's own text minus its comments: a literal named only in a comment is not tested.
// Trailing `//` is stripped too, not just whole-line — otherwise a member could be "covered" by the
// prose of the very row that explains why it is hard to cover.
const SUITE_CODE = SUITE.split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .map((line) => line.replace(/\s\/\/.*$/, ''))
  .join('\n');

const setMembers = (name) => {
  const match = GUARD.match(new RegExp(`${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  assert.ok(match, `could not parse ${name} — this test is out of date with the guard, not vice versa`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

const switchCases = () => {
  const match = GUARD.match(/switch \(head\)[\s\S]*?\n {4}\}/);
  assert.ok(match, 'could not parse the dispatch switch');
  return [...match[0].matchAll(/case '([^']+)'/g)].map((m) => m[1]);
};

// `\b` would accept `builtin` inside `builtins`; the boundary class is the shell-token boundary.
const SHELL_BOUNDARY_BEFORE = String.raw`(^|[\s"'\`/|])`;
const SHELL_BOUNDARY_AFTER = String.raw`(\s|["'\`]|$)`;

const named = (token) => {
  const literal = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${SHELL_BOUNDARY_BEFORE}${literal}${SHELL_BOUNDARY_AFTER}`, 'm').test(SUITE_CODE);
};

for (const set of ['SHELL_WRAPPERS', 'PREFIX_COMMANDS', 'BARE_PREFIX_FAILS_CLOSED', 'GUARDED_TOOLS']) {
  test(`every ${set} member is named by a test command`, () => {
    const missing = setMembers(set).filter((member) => !named(member));
    assert.deepEqual(
      missing,
      [],
      `${set} members with no test command naming them: ${missing.join(', ')}. ` +
        `Deleting one of these from the guard may leave this suite green — add a BLOCKED row that ` +
        `exercises it WITHOUT a shell wrapper present, or the wrapper scan will deny it either way.`,
    );
  });
}

test('every dispatch-switch case is named by a test command', () => {
  const missing = switchCases().filter((head) => !named(head));
  assert.deepEqual(missing, [], `dispatch heads with no test command: ${missing.join(', ')}`);
});

// Guards the parser above: if the guard is refactored so these come back empty, every assertion
// above passes vacuously and the whole file becomes decorative.
test('the guard parses into non-trivial sets — the assertions above are not vacuous', () => {
  assert.ok(setMembers('SHELL_WRAPPERS').length >= 8, 'expected the wrapper set to be populated');
  assert.ok(setMembers('PREFIX_COMMANDS').length >= 15, 'expected the prefix set to be populated');
  assert.ok(setMembers('BARE_PREFIX_FAILS_CLOSED').length >= 10, 'expected the bare-prefix set to be populated');
  assert.ok(setMembers('GUARDED_TOOLS').length >= 3, 'expected the guarded-tool set to be populated');
  assert.ok(switchCases().length >= 8, 'expected the dispatch switch to be populated');
});
