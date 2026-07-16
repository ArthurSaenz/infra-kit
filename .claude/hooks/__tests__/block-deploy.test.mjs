import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHook, bash } from './helpers.mjs';

const HOOK = 'block-deploy.mjs';

// Blocks via a PreToolUse permissionDecision:"deny" on stdout (exit 0 — JSON is only read on
// exit 0), so we assert on the JSON, not the exit code.
function decision(command, opts) {
  const res = runHook(HOOK, command === null ? '{bad json' : bash(command), opts);
  return { denied: /"permissionDecision"\s*:\s*"deny"/.test(res.stdout), status: res.status };
}

const BLOCKED = [
  ['gh workflow run', 'gh workflow run deploy.yml'],
  ['gh api dispatches (space boundary)', 'gh api repos/o/r/actions/workflows/w.yml/dispatches -f ref=main'],
  ['gh api dispatches (query boundary)', 'gh api repos/o/r/actions/workflows/w.yml/dispatches?ref=main'],
  ['gh run rerun', 'gh run rerun 123'],
  ['env-prefixed gh api', 'GH_TOKEN=x gh api repos/o/r/actions/workflows/w.yml/dispatches -f x=1'],
  ['sudo-prefixed', 'sudo gh workflow run x'],
  ['compound &&', 'echo hi && gh workflow run x'],
  ['compound ;', 'true; gh run rerun 5'],
  ['curl to dispatches', 'curl -X POST https://api.github.com/repos/o/r/actions/workflows/w.yml/dispatches'],
  ['wget to dispatches', 'wget https://api.github.com/repos/o/r/actions/workflows/w.yml/dispatches'],
  ['ik release deliver', 'pnpm exec ik release deliver'],
  ['pnpm dx-release-deliver', 'pnpm dx-release-deliver'],
  ['ik release-deliver token', 'ik release-deliver'],
  ['node ... deliver', 'node ./bin release deliver'],
  ['mixed case', 'GH WORKFLOW RUN x'],
  ['tab-separated', 'gh\tworkflow\trun x'],
];

const ALLOWED = [
  ['gh run list', 'gh run list'],
  ['gh run view', 'gh run view 1'],
  ['gh workflow view', 'gh workflow view w'],
  ['substring in grep arg', 'grep "gh workflow run" file.txt'],
  ['quoted-URL edge (documented tripwire limit)', 'gh api "https://api.github.com/repos/o/r/actions/workflows/w.yml/dispatches" -f x=1'],
  ['deploy-all is allowed', 'pnpm exec ik release deploy-all'],
  ['plain build', 'pnpm run build'],
  ['dispatches in a non-gh command', 'ls dispatches/'],
];

test('block-deploy DENIES every bypass via permissionDecision (exit 0 + deny JSON)', () => {
  for (const [label, command] of BLOCKED) {
    const d = decision(command);
    assert.ok(d.denied, `should deny: ${label}`);
    assert.equal(d.status, 0, `deny must exit 0 (JSON channel): ${label}`);
  }
});

test('block-deploy allows read paths and non-deploy commands (no deny)', () => {
  for (const [label, command] of ALLOWED) {
    const d = decision(command);
    assert.equal(d.denied, false, `should allow: ${label}`);
    assert.equal(d.status, 0, label);
  }
});

test('block-deploy fails closed on malformed / empty / missing tool_name (deny JSON)', () => {
  assert.ok(decision(null).denied, 'malformed → deny');
  assert.ok(runHook(HOOK, '').stdout.includes('deny'), 'empty stdin → deny');
  assert.ok(runHook(HOOK, { tool_name: '' }).stdout.includes('deny'), 'missing tool_name → deny');
});

test('block-deploy ignores non-Bash tools and empty commands (no deny, exit 0)', () => {
  const read = runHook(HOOK, { tool_name: 'Read', tool_input: {} });
  assert.equal(/permissionDecision/.test(read.stdout), false);
  assert.equal(read.status, 0);
  const empty = runHook(HOOK, { tool_name: 'Bash', tool_input: {} });
  assert.equal(/permissionDecision/.test(empty.stdout), false);
  assert.equal(empty.status, 0);
});

test('block-deploy is mode-independent (denies even with the exec bit stripped)', () => {
  assert.ok(decision('gh workflow run deploy.yml', { chmodStrip: true }).denied);
});
