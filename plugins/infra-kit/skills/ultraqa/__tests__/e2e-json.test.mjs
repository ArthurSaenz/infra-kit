import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// The skill reads `infra-kit e2e --json` through the agent, not a parser, so its contract is the field
// names SKILL.md tells the agent to read. The fixture is one collected run; the CLI's
// `entry/json-contract` test parses this same file with the `e2e` schema, so a field renamed in the CLI
// reddens one side or the other.
const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(HERE, '__fixtures__', 'e2e-run.json'), 'utf8'))
const skill = readFileSync(join(HERE, '..', 'SKILL.md'), 'utf8')

const READ_FIELDS = [
  'app',
  'testsDir',
  'target',
  'mode',
  'baseUrl',
  'servedEnv',
  'served',
  'devCommand',
  'routes',
  'exitCode',
  'report',
  'outputDir',
  'summary',
  'failures',
]

test('every e2e field the skill names is in the --json document', () => {
  for (const field of READ_FIELDS) {
    assert.ok(skill.includes(`\`${field}\``), `SKILL.md no longer names \`${field}\` — drop it from READ_FIELDS`)
    assert.ok(field in fixture, `e2e --json has no \`${field}\``)
  }
})

test('the document carries the versioned envelope', () => {
  assert.equal(fixture.schemaVersion, 1)
  assert.equal(fixture.command, 'e2e')
})

test('repeatFlaky, which the skill folds repeats into, sits in summary', () => {
  assert.ok(skill.includes('`repeatFlaky`'))
  assert.equal(typeof fixture.summary.repeatFlaky, 'number')
})
