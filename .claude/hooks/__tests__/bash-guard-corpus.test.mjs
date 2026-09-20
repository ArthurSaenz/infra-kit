// Frozen verdicts for the advisory lane. The unit tests import each guard directly, so a guard that
// stops being dispatched still passes its own tests; this catches that.
// Regenerate: UPDATE_CORPUS=1 node --test .claude/hooks/__tests__/bash-guard-corpus.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHook, bash } from './helpers.mjs';

const CORPUS_PATH = join(import.meta.dirname, 'bash-guard-corpus.json');
const CORPUS = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));

// Which guard spoke, not its wording — rewording must not drift the corpus.
const IDENTITY = [
  ['doppler', /doppler secrets/],
  ['destructive', /recursive force-remove|force push|destructive SQL/],
  ['package-manager', /pnpm workspace/],
  ['cmux', /Dev servers must run in cmux/],
  ['worktree', /worktrees-add|worktrees-list/],
  ['style', /ripgrep|find -name/],
];

const identify = (text) => IDENTITY.find(([, re]) => re.test(text))?.[0] ?? 'unrecognised';

const verdict = (command) => {
  const res = runHook('bash-guard.mjs', bash(command));
  const advised = /additionalContext/.test(res.stdout);

  if (res.status === 2) return { blocked: true, advised: false, signal: `block:${identify(res.stderr)}` };
  if (advised) return { blocked: false, advised: true, signal: `advise:${identify(res.stdout)}` };
  return { blocked: false, advised: false, signal: '' };
};

if (process.env.UPDATE_CORPUS === '1') {
  const regenerated = CORPUS.map((entry) => ({ command: entry.command, ...verdict(entry.command) }));
  writeFileSync(CORPUS_PATH, `${JSON.stringify(regenerated, null, 2)}\n`);
  process.stdout.write(`corpus regenerated: ${regenerated.length} entries\n`);
}

test('advisory corpus: every recorded verdict still holds', () => {
  const drift = [];

  for (const entry of CORPUS) {
    const got = verdict(entry.command);

    if (got.blocked !== entry.blocked || got.advised !== entry.advised || got.signal !== entry.signal) {
      drift.push(
        `  ${JSON.stringify(entry.command)}\n` +
          `    expected: ${JSON.stringify({ blocked: entry.blocked, advised: entry.advised, signal: entry.signal })}\n` +
          `    actual:   ${JSON.stringify(got)}`,
      );
    }
  }

  assert.equal(
    drift.length,
    0,
    `${drift.length} entries drifted. If intentional, regenerate with UPDATE_CORPUS=1 and commit ` +
      `the diff:\n${drift.join('\n')}`,
  );
});

test('advisory corpus: every guard is represented, so dropping one cannot pass silently', () => {
  const seen = new Set(CORPUS.map((entry) => entry.signal.split(':')[1]).filter(Boolean));

  for (const [guard] of IDENTITY) {
    assert.ok(seen.has(guard), `no corpus entry exercises the ${guard} guard`);
  }

  assert.equal(seen.has('unrecognised'), false, 'a corpus entry fired a guard IDENTITY cannot name');
});
