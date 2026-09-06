// plan-review-gate is invoked as `node plan-review-gate.mjs --plan=<path>`, exactly how the skill
// runs it — so we spawn it as a real subprocess and assert on real exit codes / stdout, same
// philosophy as the repo's hook test helpers.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'plan-review-gate.mjs')

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const scratchDir = () => mkdtempSync(join(tmpdir(), 'full-cycle-'))

const run = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() }
}

/** A plan file in its own scratch dir, with the review path and digest every case below needs. */
const seedPlan = () => {
  const planPath = join(scratchDir(), 'foo.plan.md')
  writeFileSync(planPath, '# plan v1\n')
  return { planPath, reviewPath: `${planPath}.review.json`, digest: sha256(readFileSync(planPath)) }
}

/** A review carrying the plan's CURRENT digest. Returns its bytes, so `deepEqual` has a baseline. */
const seedReview = ({ planPath, reviewPath, digest }, status, reason, comments = []) => {
  writeFileSync(
    reviewPath,
    JSON.stringify({ stage: 'plan-review', status, reason, plan: planPath, plan_digest: digest, comments }),
  )
  return readFileSync(reviewPath)
}

test('fresh plan, no review -> exit 0, writes a skipped review with the plan digest', () => {
  const plan = seedPlan()

  const { status, stdout } = run(`--plan=${plan.planPath}`)

  assert.equal(status, 0)
  const review = JSON.parse(stdout)
  assert.equal(review.status, 'skipped')
  assert.equal(review.plan_digest, plan.digest)

  assert.deepEqual(JSON.parse(readFileSync(plan.reviewPath, 'utf8')), review)
})

test('unchanged plan with an approved review -> byte-identical file, exit 0', () => {
  const plan = seedPlan()
  const before = seedReview(plan, 'approved', 'looks good')

  const { status, stdout } = run(`--plan=${plan.planPath}`)

  assert.equal(status, 0)
  assert.equal(JSON.parse(stdout).status, 'approved')
  assert.deepEqual(readFileSync(plan.reviewPath), before)
})

test('revising the plan invalidates an approved review, replacing it with a fresh skipped review carrying the new digest — the anti-infinite-loop property', () => {
  const plan = seedPlan()
  seedReview(plan, 'approved', 'looks good')

  // Revise the plan so its digest changes.
  writeFileSync(plan.planPath, '# plan v2 — revised\n')
  const newDigest = sha256(readFileSync(plan.planPath))
  assert.notEqual(newDigest, plan.digest)

  const { status, stdout } = run(`--plan=${plan.planPath}`)

  assert.equal(status, 0)
  const review = JSON.parse(stdout)
  assert.equal(review.status, 'skipped')
  assert.equal(review.plan_digest, newDigest)

  const onDisk = JSON.parse(readFileSync(plan.reviewPath, 'utf8'))
  assert.equal(onDisk.status, 'skipped')
  assert.equal(onDisk.plan_digest, newDigest)
})

test('current review with changes-requested -> exit 3, file byte-identical', () => {
  const plan = seedPlan()
  const before = seedReview(plan, 'changes-requested', 'needs work', ['fix section 2'])

  const { status, stdout } = run(`--plan=${plan.planPath}`)

  assert.equal(status, 3)
  assert.equal(JSON.parse(stdout).status, 'changes-requested')
  assert.deepEqual(readFileSync(plan.reviewPath), before)
})

test('current review with pending -> exit 4, file byte-identical', () => {
  const plan = seedPlan()
  const before = seedReview(plan, 'pending', 'awaiting human review')

  const { status, stdout } = run(`--plan=${plan.planPath}`)

  assert.equal(status, 4)
  assert.equal(JSON.parse(stdout).status, 'pending')
  assert.deepEqual(readFileSync(plan.reviewPath), before)
})

test('current review with an out-of-enum status -> exit 1', () => {
  const plan = seedPlan()
  seedReview(plan, 'bogus', 'nonsense')

  const { status, stderr } = run(`--plan=${plan.planPath}`)

  assert.equal(status, 1)
  assert.match(stderr, /bogus/)
})

test('malformed JSON review file -> exit 1, file is not overwritten', () => {
  const plan = seedPlan()
  writeFileSync(plan.reviewPath, '{ not valid json')
  const before = readFileSync(plan.reviewPath)

  const { status, stderr } = run(`--plan=${plan.planPath}`)

  assert.equal(status, 1)
  assert.match(stderr, /malformed/i)
  assert.deepEqual(readFileSync(plan.reviewPath), before)
})

test('missing --plan -> exit 2', () => {
  const r = run()
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--plan/)
})
