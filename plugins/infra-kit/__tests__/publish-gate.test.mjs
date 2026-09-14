// Guards for `scripts/check-workflow-resource-published.mjs` — the gate that stops a plugin command
// merging before the published CLI serves the resource its body points at.
//
// These exercise `collectViolations`, the pure seam. The script's other half reaches the npm
// registry and spawns `pnpm dlx infra-kit@<version> mcp`, which cannot run in a unit suite; the seam
// exists so the DECISIONS are testable even though the I/O is not. What is asserted here is exactly
// what the seam decides: which commands are violations, and that every one of them is reported.
//
// The gate is red on `main` today by design — `release-create`'s body names a 0.5.0 floor and the
// published `infra-kit@latest` is 0.4.0 — so the fail-fast behaviour it used to have was not a style
// point. An early exit on that known redness would have meant a newly added second command was never
// examined. G-A2 is the row that pins it.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { collectViolations } from '../../../scripts/check-workflow-resource-published.mjs'

const command = (name, overrides = {}) => {
  return {
    name,
    rel: `plugins/infra-kit/commands/${name}.md`,
    floor: '0.5.0',
    uri: `infra-kit://workflow/${name}`,
    ...overrides,
  }
}

test('G-A1: a command whose floor is met and whose URI is served is not a violation', () => {
  const violations = collectViolations({
    commands: [command('release-create')],
    published: '0.5.0',
    servedUris: ['infra-kit://workflow/release-create'],
  })

  assert.deepEqual(violations, [])
})

// The row that would have caught the original shape. With `release-create` red (floor 0.5.0 vs
// published 0.4.0) and a second command added, fail-fast reported ONE violation and stopped — so the
// second command shipped unexamined, which is the precise failure the gate exists to prevent.
test('G-A2: a second command is still examined when the first is already failing', () => {
  const violations = collectViolations({
    commands: [command('release-create'), command('release-deploy')],
    published: '0.4.0',
    servedUris: [],
  })

  assert.equal(violations.length, 2, `expected both commands reported, got: ${violations.join(' | ')}`)
  assert.ok(
    violations.some((v) => v.includes('release-deploy')),
    'the second command must be reported even though the first already failed',
  )
})

test('G-A3: a floor that is met but a URI that is not served is a violation', () => {
  const violations = collectViolations({
    commands: [command('release-deploy')],
    published: '0.9.0',
    servedUris: ['infra-kit://workflow/release-create'],
  })

  assert.equal(violations.length, 1)
  assert.match(violations[0], /does not serve infra-kit:\/\/workflow\/release-deploy/)
})

// Deleting the sentence that carries the floor must fail loudly rather than silently disabling the
// gate for that command — the failure mode a "read it out of the body" design invites.
test('G-A4: a command with no parseable floor is a violation, not a skip', () => {
  const violations = collectViolations({
    commands: [command('release-deploy', { floor: null })],
    published: '9.9.9',
    servedUris: [],
  })

  assert.equal(violations.length, 1)
  assert.match(violations[0], /no version floor/)
})

test('G-A5: a command naming no workflow URI is a violation', () => {
  const violations = collectViolations({
    commands: [command('release-deploy', { uri: null })],
    published: '9.9.9',
    servedUris: [],
  })

  assert.equal(violations.length, 1)
  assert.match(violations[0], /names no infra-kit:\/\/workflow/)
})

// G-A1–G-A5 all use the fictional `release-deploy`. G-A6 is the first row covering a second REAL
// command: `session` shipped as a resource in 0.5.2 with a plugin command that landed later, so a
// floor below that release plus a served list holding only release-create is the exact state the
// gate exists to refuse — and it must name `session`, not the command that is fine.
test('G-A6: session is refused while the published CLI predates its resource', () => {
  const violations = collectViolations({
    commands: [command('release-create'), command('session', { floor: '0.5.2' })],
    published: '0.5.1',
    servedUris: ['infra-kit://workflow/release-create'],
  })

  assert.equal(violations.length, 1)
  assert.match(violations[0], /session/)
  assert.match(violations[0], /infra-kit:\/\/workflow\/session/)
  assert.doesNotMatch(violations[0], /release-create/)
})
