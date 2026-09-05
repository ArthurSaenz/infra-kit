// Guards this skill's frontmatter against OMC's parser, which is a naive line-scanner rather than a
// YAML parser. Two failure modes are silent and cost the whole skill: a block-form list parses to
// empty, and a folded `description: >-` parses to the literal marker. Neither errors.
//
// The trigger phrases are asserted because `description` is the skill's only discovery surface: a
// user who types "review comments" or "перевірити коментарі" reaches nothing without them.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

const SKILL_MD = readFileSync(join(import.meta.dirname, '..', 'SKILL.md'), 'utf8')

const EXPECTED_KEYS = ['name', 'description', 'argument-hint', 'aliases']
const TRIGGER_PHRASES = ['review comments', 'comment policy', 'why not what', 'коментарі']

// Replica of OMC's parser, so these assertions test what OMC will actually see.
const parseFrontmatterLikeOmc = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const metadata = {}
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0 || /^[\s-]/.test(line)) continue
    metadata[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return metadata
}

test('frontmatter parses to exactly the approved key set', () => {
  assert.deepEqual(Object.keys(parseFrontmatterLikeOmc(SKILL_MD)).sort(), [...EXPECTED_KEYS].sort())
})

test('name equals the directory name, so both loaders resolve it alike', () => {
  assert.equal(parseFrontmatterLikeOmc(SKILL_MD).name, 'comment-verifier')
})

test('description is one physical line, not a folded scalar', () => {
  const { description } = parseFrontmatterLikeOmc(SKILL_MD)
  assert.ok(!['>-', '>', '|', '|-'].includes(description), 'a folded description parses to the marker itself')
  assert.ok(description.length > 80, "description collapsed — it is the skill's only discovery surface")
})

test('list fields are inline, since block form parses to empty', () => {
  const { aliases } = parseFrontmatterLikeOmc(SKILL_MD)
  assert.match(aliases, /^\[.+\]$/, 'aliases must be inline [a, b] form')
})

test('description carries every trigger phrase a user would type', () => {
  const description = parseFrontmatterLikeOmc(SKILL_MD).description.toLowerCase()
  for (const phrase of TRIGGER_PHRASES) {
    assert.ok(description.includes(phrase), `description is missing the trigger phrase "${phrase}"`)
  }
})

test('description avoids "clean", which belongs to ai-slop-cleaner and /code-review', () => {
  const { description } = parseFrontmatterLikeOmc(SKILL_MD)
  assert.doesNotMatch(description, /clean/i, 'this skill must not compete with the deslop trigger')
})

test('body is under the 5,000-word progressive-disclosure ceiling', () => {
  const body = SKILL_MD.replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
  const words = body.split(/\s+/).filter(Boolean).length
  assert.ok(words < 5000, `SKILL.md body is ${words} words; push detail into references/`)
})
