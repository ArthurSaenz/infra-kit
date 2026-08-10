#!/usr/bin/env node
// The plan-review gate: a seam reserved for a future commented-plan-review implementation. Today
// it is a documented no-op that still runs on every invocation — this file is that no-op's contract.
//
// The review FILE is authoritative — its `status` is the verdict, the exit code only mirrors it
// for synchronous runs. `pending` sits in the enum because commented human review is intrinsically
// long-lived: a future implementation may return immediately and have a human complete it later.
// Idempotence is scoped per (plan path, plan_digest), not per plan path — so revising a plan
// invalidates its review, which is what lets a revise -> review cycle terminate instead of looping
// on a stale approval forever.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const STATUSES_CURRENT = { approved: 0, skipped: 0, 'changes-requested': 3, pending: 4 };

function fail(code, reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Same-dir temp file + rename, so a reader never observes a half-written review.
function writeAtomic(path, text) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const planArg = process.argv.find((a) => a.startsWith('--plan='));
const planPath = planArg?.slice('--plan='.length);
if (!planPath) fail(2, 'plan-review-gate: missing --plan=<path>');

let planBytes;
try {
  planBytes = readFileSync(planPath);
} catch (err) {
  fail(2, `plan-review-gate: cannot read plan at ${planPath} — ${err?.message ?? err}`);
}

const planDigest = sha256(planBytes);
const reviewPath = `${planPath}.review.json`;

function noOpReview() {
  return {
    stage: 'plan-review',
    status: 'skipped',
    reason: 'not-implemented',
    plan: planPath,
    plan_digest: planDigest,
    comments: [],
  };
}

function emitFresh() {
  const review = noOpReview();
  const text = JSON.stringify(review);
  writeAtomic(reviewPath, text);
  process.stderr.write('review: skipped (commented plan review not implemented)\n');
  process.stdout.write(`${text}\n`);
  process.exit(0);
}

if (!existsSync(reviewPath)) emitFresh();

let raw;
try {
  raw = readFileSync(reviewPath, 'utf8');
} catch (err) {
  fail(2, `plan-review-gate: cannot read review at ${reviewPath} — ${err?.message ?? err}`);
}

let review;
try {
  review = JSON.parse(raw);
} catch {
  // Malformed — never overwritten, since that would silently discard whatever produced it.
  fail(1, `plan-review-gate: malformed review JSON at ${reviewPath}`);
}

// STALE: digest mismatch means the plan moved on since this review was written. Treated the same
// as no review at all — a fresh no-op replaces it, which is the load-bearing anti-infinite-loop case.
if (review.plan_digest !== planDigest) emitFresh();

// CURRENT: honour the existing verdict verbatim, byte-identical.
const exitCode = STATUSES_CURRENT[review.status];
if (exitCode === undefined) {
  fail(1, `plan-review-gate: unrecognised review status "${review.status}" at ${reviewPath}`);
}

process.stdout.write(`${raw.endsWith('\n') ? raw : `${raw}\n`}`);
process.exit(exitCode);
