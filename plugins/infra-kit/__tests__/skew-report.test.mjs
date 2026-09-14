// Guards for `scripts/report-published-cli-skew.mjs` — the non-gating report of what the plugin's
// skills name versus what the PUBLISHED infra-kit CLI serves.
//
// These exercise `collectSkew`, the pure seam. The script's other half reaches the npm registry and
// spawns `pnpm dlx infra-kit@<version> mcp`, which cannot run in a unit suite; the seam exists so the
// DECISIONS are testable even though the I/O is not. A report with no test can print nothing and look
// healthy — a fail-open report is worse than none.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { collectSkew, renderReport } from '../../../scripts/report-published-cli-skew.mjs'

const PREFIX = 'mcp__plugin_infra-kit_infra-kit__'

const tool = (name, required = []) => {
  return { name, inputSchema: { type: 'object', required } }
}

test('K1: a skill whose every named tool is served, against an env-load that accepts a missing config, is no skew', () => {
  const skew = collectSkew([tool('env-list'), tool('env-load'), tool('env-clear')], {
    session: `Call \`${PREFIX}env-list\`, then \`${PREFIX}env-load\`; \`--clear\` → \`${PREFIX}env-clear\`.`,
  })

  assert.deepEqual(skew, { missingBySkill: {}, envLoadRequiresConfig: false })
})

test('K2: every tool the published build lacks is reported under the skill that names it, de-duplicated', () => {
  const skew = collectSkew([tool('env-list'), tool('env-load', ['config'])], {
    session: `\`${PREFIX}env-load\` and \`${PREFIX}env-clear\` and again \`${PREFIX}env-clear\`.`,
    'release-create': `The tool is \`${PREFIX}release-create\`.`,
    doctor: `Read \`${PREFIX}version\`.`,
  })

  assert.deepEqual(skew.missingBySkill, {
    session: ['env-clear'],
    'release-create': ['release-create'],
    doctor: ['version'],
  })
})

// The session skill's form path assumes the published `env-load` accepts a missing `config`; the
// build before that change lists it as required. Both readings, and the "not served at all" reading,
// are distinct outcomes the report has to name.
test("K3: env-load's `required` is read from the published schema, and absence reads as null", () => {
  assert.equal(collectSkew([tool('env-load', ['config'])], {}).envLoadRequiresConfig, true)
  assert.equal(collectSkew([tool('env-load', [])], {}).envLoadRequiresConfig, false)
  assert.equal(collectSkew([tool('env-load')], {}).envLoadRequiresConfig, false)
  assert.equal(collectSkew([tool('env-list')], {}).envLoadRequiresConfig, null)
})

// The scan is the SHARED definition, read from the manifest suite's fixture: a text that names a tool
// through the legacy prefix, or through prose, names nothing to this report — and the same fixture is
// what U14'/U18 and the CLI's catalog cross-check read, so the three cannot disagree on a mention.
test('K4: only the plugin-prefixed spelling counts as naming a tool, through the shared scan pattern', () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', 'scan-patterns.json'), 'utf8'))
  const legacy = fixture.legacyToolPrefix[0].join('')

  const skew = collectSkew([], {
    prose: `Call env-load, then \`${legacy}env-clear\`, then \`${PREFIX}env-status\`.`,
  })

  assert.deepEqual(skew.missingBySkill, { prose: ['env-status'] })
})

test('K5: the report names each missing tool per skill and states the env-load reading', () => {
  const report = renderReport({
    published: '0.7.7',
    skew: { missingBySkill: { session: ['env-clear'] }, envLoadRequiresConfig: true },
  })

  assert.match(report, /infra-kit@0\.7\.7/)
  assert.match(report, /`session`: `env-clear`/)
  assert.match(report, /still REQUIRES `config`/)
})

test('K6: a failure to read the published build is reported, not raised', () => {
  const report = renderReport({ published: undefined, failure: 'ETIMEDOUT' })

  assert.match(report, /Could not read the published build: ETIMEDOUT/)
})
