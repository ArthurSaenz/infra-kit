// plan-review-gate is invoked as `node plan-review-gate.mjs --plan=<path>`, exactly how the skill
// runs it — so we spawn it as a real subprocess and assert on real exit codes / stdout, same
// philosophy as .claude/hooks/__tests__/helpers.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'plan-review-gate.mjs');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scratchDir = () => mkdtempSync(join(tmpdir(), 'full-cycle-'));

const run = (planPath, args = [`--plan=${planPath}`]) => {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
};

test('fresh plan, no review -> exit 0, writes a skipped review with the plan digest', () => {
  const dir = scratchDir();
  const planPath = join(dir, 'foo.plan.md');
  writeFileSync(planPath, '# plan v1\n');
  const expectedDigest = sha256(readFileSync(planPath));

  const { status, stdout } = run(planPath);

  assert.equal(status, 0);
  const review = JSON.parse(stdout);
  assert.equal(review.status, 'skipped');
  assert.equal(review.plan_digest, expectedDigest);

  const onDisk = JSON.parse(readFileSync(`${planPath}.review.json`, 'utf8'));
  assert.deepEqual(onDisk, review);
});

test('unchanged plan with an approved review -> byte-identical file, exit 0', () => {
  const dir = scratchDir();
  const planPath = join(dir, 'foo.plan.md');
  writeFileSync(planPath, '# plan v1\n');
  const digest = sha256(readFileSync(planPath));

  const reviewPath = `${planPath}.review.json`;
  const approved = JSON.stringify({
    stage: 'plan-review',
    status: 'approved',
    reason: 'looks good',
    plan: planPath,
    plan_digest: digest,
    comments: [],
  });
  writeFileSync(reviewPath, approved);
  const before = readFileSync(reviewPath);

  const { status, stdout } = run(planPath);

  assert.equal(status, 0);
  assert.equal(JSON.parse(stdout).status, 'approved');
  const after = readFileSync(reviewPath);
  assert.deepEqual(before, after);
});

test('revising the plan invalidates an approved review, replacing it with a fresh skipped review carrying the new digest — the anti-infinite-loop property', () => {
  const dir = scratchDir();
  const planPath = join(dir, 'foo.plan.md');
  writeFileSync(planPath, '# plan v1\n');
  const oldDigest = sha256(readFileSync(planPath));

  const reviewPath = `${planPath}.review.json`;
  writeFileSync(
    reviewPath,
    JSON.stringify({
      stage: 'plan-review',
      status: 'approved',
      reason: 'looks good',
      plan: planPath,
      plan_digest: oldDigest,
      comments: [],
    }),
  );

  // Revise the plan so its digest changes.
  writeFileSync(planPath, '# plan v2 — revised\n');
  const newDigest = sha256(readFileSync(planPath));
  assert.notEqual(newDigest, oldDigest);

  const { status, stdout } = run(planPath);

  assert.equal(status, 0);
  const review = JSON.parse(stdout);
  assert.equal(review.status, 'skipped');
  assert.equal(review.plan_digest, newDigest);

  const onDisk = JSON.parse(readFileSync(reviewPath, 'utf8'));
  assert.equal(onDisk.status, 'skipped');
  assert.equal(onDisk.plan_digest, newDigest);
});

test('current review with changes-requested -> exit 3, file byte-identical', () => {
  const dir = scratchDir();
  const planPath = join(dir, 'foo.plan.md');
  writeFileSync(planPath, '# plan v1\n');
  const digest = sha256(readFileSync(planPath));

  const reviewPath = `${planPath}.review.json`;
  writeFileSync(
    reviewPath,
    JSON.stringify({
      stage: 'plan-review',
      status: 'changes-requested',
      reason: 'needs work',
      plan: planPath,
      plan_digest: digest,
      comments: ['fix section 2'],
    }),
  );
  const before = readFileSync(reviewPath);

  const { status, stdout } = run(planPath);

  assert.equal(status, 3);
  assert.equal(JSON.parse(stdout).status, 'changes-requested');
  assert.deepEqual(readFileSync(reviewPath), before);
});

test('current review with pending -> exit 4, file byte-identical', () => {
  const dir = scratchDir();
  const planPath = join(dir, 'foo.plan.md');
  writeFileSync(planPath, '# plan v1\n');
  const digest = sha256(readFileSync(planPath));

  const reviewPath = `${planPath}.review.json`;
  writeFileSync(
    reviewPath,
    JSON.stringify({
      stage: 'plan-review',
      status: 'pending',
      reason: 'awaiting human review',
      plan: planPath,
      plan_digest: digest,
      comments: [],
    }),
  );
  const before = readFileSync(reviewPath);

  const { status, stdout } = run(planPath);

  assert.equal(status, 4);
  assert.equal(JSON.parse(stdout).status, 'pending');
  assert.deepEqual(readFileSync(reviewPath), before);
});

test('current review with an out-of-enum status -> exit 1', () => {
  const dir = scratchDir();
  const planPath = join(dir, 'foo.plan.md');
  writeFileSync(planPath, '# plan v1\n');
  const digest = sha256(readFileSync(planPath));

  const reviewPath = `${planPath}.review.json`;
  writeFileSync(
    reviewPath,
    JSON.stringify({
      stage: 'plan-review',
      status: 'bogus',
      reason: 'nonsense',
      plan: planPath,
      plan_digest: digest,
      comments: [],
    }),
  );

  const { status, stderr } = run(planPath);

  assert.equal(status, 1);
  assert.match(stderr, /bogus/);
});

test('malformed JSON review file -> exit 1, file is not overwritten', () => {
  const dir = scratchDir();
  const planPath = join(dir, 'foo.plan.md');
  writeFileSync(planPath, '# plan v1\n');

  const reviewPath = `${planPath}.review.json`;
  writeFileSync(reviewPath, '{ not valid json');
  const before = readFileSync(reviewPath);

  const { status, stderr } = run(planPath);

  assert.equal(status, 1);
  assert.match(stderr, /malformed/i);
  assert.deepEqual(readFileSync(reviewPath), before);
});

test('missing --plan -> exit 2', () => {
  const r = run(null, []);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--plan/);
});
