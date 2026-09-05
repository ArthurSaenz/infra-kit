// A verdict that cannot be verified must never be executed, so the schema is a gate the fix pass
// passes through rather than a convention it observes.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { validateVerdict } from '../scripts/lint-comments.mjs'

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, '..', '__fixtures__', name), 'utf8'))

test('the recorded valid verdict passes and covers all five actions', () => {
  const verdict = fixture('verdict.valid.json')
  const result = validateVerdict(verdict)
  assert.deepEqual(result.errors, [])
  assert.ok(result.ok)

  const actions = new Set(verdict.map((entry) => entry.action))
  assert.deepEqual(
    [...actions].sort(),
    ['delete', 'keep', 'rename-or-refactor-instead', 'rewrite-as-why', 'shorten'],
  )
})

test('the recorded invalid verdict is rejected on every count it encodes', () => {
  const result = validateVerdict(fixture('verdict.invalid.json'))
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
