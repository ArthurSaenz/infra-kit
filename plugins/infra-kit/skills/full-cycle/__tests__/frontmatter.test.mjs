// Guards this skill's own frontmatter against OMC's parser, which is a naive line-scanner rather
// than a YAML parser. Two failure modes are silent and cost you the whole skill: a block-form list
// parses to empty, and a folded `description: >-` parses to the literal marker. Neither errors —
// the key is just quietly wrong.
//
// Deliberately needs no OMC install, so it runs everywhere including CI.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const SKILL_MD = readFileSync(join(import.meta.dirname, '..', 'SKILL.md'), 'utf8')

// The plugin copy carries only Claude Code fields (plan U4). OMC's pipeline/handoff keys were
// dropped because OMC reads this body, not the plugin manifest, and Claude Code ignores them.
const EXPECTED_KEYS = ['name', 'description', 'argument-hint', 'allowed-tools']

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
  assert.equal(parseFrontmatterLikeOmc(SKILL_MD).name, 'full-cycle')
})

test('description is one physical line, not a folded scalar', () => {
  const { description } = parseFrontmatterLikeOmc(SKILL_MD)
  assert.ok(!['>-', '>', '|', '|-'].includes(description), 'a folded description parses to the marker itself')
  assert.ok(description.length > 80, "description collapsed — it is the skill's only discovery surface")
})

test('no field is block form, which parses to an empty value', () => {
  // A test that names a specific key passes on `undefined` once that key is dropped and checks
  // nothing; asserting over every present key cannot go stale that way.
  const fm = parseFrontmatterLikeOmc(SKILL_MD)
  for (const [key, value] of Object.entries(fm)) {
    assert.ok(value.length > 0, `${key} parsed to an empty value — block-form list or empty scalar`)
  }
})

test('no inert keys: trigger, triggers and level are read by nothing on this path', () => {
  assert.doesNotMatch(SKILL_MD, /^(trigger|triggers|level):/m)
})

test('the body carries every stage — it is primary on every invocation route', () => {
  for (const stage of ['scope', 'interview', 'plan', 'plan-review', 'approval', 'implement', 'verify']) {
    assert.ok(SKILL_MD.includes(stage), `stage ${stage} missing from the body`)
  }
})
