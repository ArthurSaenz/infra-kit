// A verdict that cannot be verified must never be executed, so the schema is a gate the fix pass
// passes through rather than a convention it observes.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import test from 'node:test'

import { validateVerdict } from '../scripts/lint-comments.mjs'
import { FIXTURES_DIR, REPO_ROOT, fixture as fixturePath } from './paths.mjs'

const readFixture = (name) => JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'))

test('the recorded valid verdict passes and covers all five actions', () => {
  const verdict = readFixture('verdict.valid.json')
  const result = validateVerdict(verdict)
  assert.deepEqual(result.errors, [])
  assert.ok(result.ok)

  const actions = new Set(verdict.map((entry) => entry.action))
  assert.deepEqual([...actions].sort(), ['delete', 'keep', 'rename-or-refactor-instead', 'rewrite-as-why', 'shorten'])
})

test('the recorded invalid verdict is rejected on every count it encodes', () => {
  const result = validateVerdict(readFixture('verdict.invalid.json'))
  assert.equal(result.ok, false)

  const joined = result.errors.join('\n')
  assert.match(joined, /entry 0: shorten requires a non-empty replacement/)
  assert.match(joined, /entry 1: delete must not carry a replacement/)
  assert.match(joined, /entry 2: unknown action "tidy"/)
  assert.match(joined, /entry 3: textHash must be 12 lowercase hex characters/)
})

test('rewrite-as-why also requires a replacement, since it too adds bytes', () => {
  const result = validateVerdict([
    { file: 'a.ts', line: 1, textHash: '0123456789ab', action: 'rewrite-as-why', reason: 'why' },
  ])
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /rewrite-as-why requires a non-empty replacement/)
})

test('keep and rename-or-refactor-instead must not carry a replacement', () => {
  for (const action of ['keep', 'rename-or-refactor-instead']) {
    const result = validateVerdict([
      { file: 'a.ts', line: 1, textHash: '0123456789ab', action, reason: 'why', replacement: '// x' },
    ])
    assert.equal(result.ok, false, `${action} accepted a replacement`)
    assert.match(result.errors.join('\n'), new RegExp(`${action} must not carry a replacement`))
  }
})

test('a non-array verdict is rejected outright', () => {
  assert.equal(validateVerdict({ file: 'a.ts' }).ok, false)
})

test('every path the recorded verdicts name resolves at this skill\'s location', () => {
  // These two fixtures are the only place a repo-relative path is written by hand rather than
  // derived, and JSON cannot import the module that derives it. Left unchecked, a move leaves them
  // naming a file that no longer exists: `validateVerdict` is a pure schema check that never opens
  // the path, so both suites above stay green while the recorded verdict describes nothing.
  const named = [...readFixture('verdict.valid.json'), ...readFixture('verdict.invalid.json')].map(
    (entry) => entry.file,
  )
  assert.ok(named.length > 0)

  for (const file of new Set(named)) {
    assert.equal(file, fixturePath(basename(file)), 'a recorded verdict names a stale location')
    assert.ok(existsSync(join(REPO_ROOT, file)), `${file} is not on disk`)
  }
})
