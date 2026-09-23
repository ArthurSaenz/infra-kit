// Branch coverage for the session probe. Every case builds its own throwaway config tree and passes
// it in as `env.CLAUDE_CONFIG_DIR`, so no test reads the developer's real ~/.claude — the same
// injection discipline the CLI's own plugin-pointer tests use.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { formatRunReport, probe, resolveRoot, resolveUnicode } from '../scripts/session-probe.mjs'

const PLUGIN_KEY = 'infra-kit@infra-kit'
const temps = []

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ik-probe-'))
  temps.push(dir)

  return dir
}

const writeJson = (file, value) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
}

/** A plugin tree at `<root>` declaring `version`, with `skills` each carrying a SKILL.md. */
const makePluginTree = (root, version, skills = ['comment-verifier', 'fe-architect']) => {
  writeJson(join(root, '.claude-plugin', 'plugin.json'), { name: 'infra-kit', version })

  for (const skill of skills) {
    mkdirSync(join(root, 'skills', skill), { recursive: true })
    writeFileSync(join(root, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: x\n---\n`)
  }

  return root
}

/** A config dir holding `installed_plugins.json` records and cached version trees. */
const makeConfigDir = ({ records, cached = [] } = {}) => {
  const dir = tempDir()

  if (records !== undefined) {
    writeJson(join(dir, 'plugins', 'installed_plugins.json'), { version: 1, plugins: { [PLUGIN_KEY]: records } })
  }

  for (const version of cached) {
    makePluginTree(join(dir, 'plugins', 'cache', 'infra-kit', 'infra-kit', version), version)
  }

  return dir
}

const find = (rows, name) => {
  const found = rows.find((r) => r.name === name)
  assert.ok(found, `no row named ${name}`)

  return found
}

const run = ({ root, configDir, projectPath = '/repo' }) => {
  return probe({ root, env: { CLAUDE_CONFIG_DIR: configDir }, projectPath })
}

// --- session vs records -----------------------------------------------------------------------

test('session and records agreeing on the install path passes', () => {
  const root = makePluginTree(tempDir(), '0.3.0')
  const configDir = makeConfigDir({ records: [{ scope: 'project', projectPath: '/repo', installPath: root }] })

  assert.equal(find(run({ root, configDir }), 'session vs records').status, 'ok')
})

test('a record pointing at a different tree is reported as drift', () => {
  const loaded = makePluginTree(tempDir(), '0.2.0')
  const recorded = makePluginTree(tempDir(), '0.3.0')
  const configDir = makeConfigDir({ records: [{ scope: 'project', projectPath: '/repo', installPath: recorded }] })
  const row = find(run({ root: loaded, configDir }), 'session vs records')

  assert.equal(row.status, 'fail')
  assert.match(row.message, /0\.2\.0/)
  assert.match(row.message, /0\.3\.0/)
})

// The bug this pins: `installed_plugins.json` stores a git commit sha in `version` for a marketplace
// served from a repo. Comparing THAT against the manifest's semver reports drift on every healthy
// machine, so the probe must read both versions from manifests and compare install PATHS.
test('a git-sha version field on the record does not by itself produce drift', () => {
  const root = makePluginTree(tempDir(), '0.3.0')
  const configDir = makeConfigDir({
    records: [
      { scope: 'project', projectPath: '/repo', installPath: root, version: '41a4c0f77144c5beb5f5f000a89cff379c6' },
    ],
  })

  assert.equal(find(run({ root, configDir }), 'session vs records').status, 'ok')
})

test('records present but empty for this plugin is a failure naming the fix', () => {
  const root = makePluginTree(tempDir(), '0.3.0')
  const row = find(run({ root, configDir: makeConfigDir({ records: [] }) }), 'session vs records')

  assert.equal(row.status, 'fail')
  assert.match(row.message, /infra-kit setup --skip-tools/)
})

// A project-scope record belonging to a DIFFERENT repo must not stand in for this one. Taking the
// first record regardless would compare the loaded tree against a path never meant to cover this
// project, and report someone else's install as drift.
test('records that cover only other projects fail without claiming drift', () => {
  const root = makePluginTree(tempDir(), '0.3.0')
  const elsewhere = makePluginTree(tempDir(), '0.1.0')
  const configDir = makeConfigDir({
    records: [{ scope: 'project', projectPath: '/some/other/repo', installPath: elsewhere }],
  })
  const row = find(run({ root, configDir }), 'session vs records')

  assert.equal(row.status, 'fail')
  assert.match(row.message, /none covers this project/)
  assert.doesNotMatch(row.message, /0\.1\.0/, "must not present another project's tree as drift")
})

test('a user-scope record with no projectPath covers this project', () => {
  const root = makePluginTree(tempDir(), '0.3.0')
  const configDir = makeConfigDir({ records: [{ scope: 'user', projectPath: null, installPath: root }] })

  assert.equal(find(run({ root, configDir }), 'session vs records').status, 'ok')
})

// `path.resolve('')` is the CWD, so an empty projectPath would otherwise "cover" whichever directory
// the probe ran in — a match by accident rather than by record.
test('a malformed empty projectPath covers nothing', () => {
  const root = makePluginTree(tempDir(), '0.3.0')
  const configDir = makeConfigDir({ records: [{ scope: 'project', projectPath: '', installPath: root }] })
  const row = find(run({ root, configDir, projectPath: process.cwd() }), 'session vs records')

  assert.equal(row.status, 'fail')
  assert.match(row.message, /none covers this project/)
})

test('an absent installed_plugins.json warns rather than reporting drift', () => {
  const root = makePluginTree(tempDir(), '0.3.0')
  const row = find(run({ root, configDir: makeConfigDir() }), 'session vs records')

  assert.equal(row.status, 'warn')
  assert.doesNotMatch(row.message, /drift/i)
})

test('an unreadable installed_plugins.json warns rather than reporting drift', () => {
  const root = makePluginTree(tempDir(), '0.3.0')
  const configDir = tempDir()
  mkdirSync(join(configDir, 'plugins'), { recursive: true })
  writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), '{ not json')
  const row = find(run({ root, configDir }), 'session vs records')

  assert.equal(row.status, 'warn')
  assert.doesNotMatch(row.message, /drift/i)
})

// --- outdated plugin --------------------------------------------------------------------------

test('a newer cached version than the one loaded fails', () => {
  const configDir = makeConfigDir({ cached: ['0.2.0', '0.10.0'] })
  const root = join(configDir, 'plugins', 'cache', 'infra-kit', 'infra-kit', '0.2.0')
  const row = find(run({ root, configDir }), 'outdated plugin')

  assert.equal(row.status, 'fail')
  // Numeric-aware ordering: a lexicographic sort would call 0.2.0 the newest of the two.
  assert.match(row.message, /0\.10\.0 is cached/)
})

test('a single cached version equal to the loaded one passes', () => {
  const configDir = makeConfigDir({ cached: ['0.3.0'] })
  const root = join(configDir, 'plugins', 'cache', 'infra-kit', 'infra-kit', '0.3.0')

  assert.equal(find(run({ root, configDir }), 'outdated plugin').status, 'ok')
})

// The regression this pins: an equality test (`newest === loaded`) failed in BOTH directions, so a
// tree running ahead of the cache was told to reinstall on top of itself. That is the normal state
// under `claude --plugin-dir ./plugins/infra-kit` — how this plugin is developed, and how the
// README's own token budget is measured — so the wrong verdict landed on exactly its authors.
test('a tree ahead of the newest cached version passes and says so', () => {
  const configDir = makeConfigDir({ cached: ['0.2.0'] })
  const root = makePluginTree(tempDir(), '0.3.0')
  const row = find(run({ root, configDir }), 'outdated plugin')

  assert.equal(row.status, 'ok')
  assert.match(row.message, /ahead of the newest cached 0\.2\.0/)
})

test('version ordering is numeric, not lexicographic, in both directions', () => {
  const configDir = makeConfigDir({ cached: ['0.9.0'] })

  // 0.10.0 > 0.9.0 numerically; a string compare would call it older and fail this row.
  const ahead = find(run({ root: makePluginTree(tempDir(), '0.10.0'), configDir }), 'outdated plugin')
  assert.equal(ahead.status, 'ok')

  const behind = find(run({ root: makePluginTree(tempDir(), '0.8.0'), configDir }), 'outdated plugin')
  assert.equal(behind.status, 'fail')
})

test('no cache directory warns instead of failing', () => {
  const root = makePluginTree(tempDir(), '0.3.0')

  assert.equal(find(run({ root, configDir: makeConfigDir() }), 'outdated plugin').status, 'warn')
})

// --- plugin root ------------------------------------------------------------------------------

test('an unresolved plugin root is a named row and the other rows still compute', () => {
  const rows = run({ root: null, configDir: makeConfigDir({ records: [] }) })

  assert.equal(find(rows, 'plugin root').status, 'fail')
  assert.equal(rows.length, 5, 'every row must still be emitted')
  assert.equal(find(rows, 'session vs records').status, 'fail')
})

test('resolveRoot treats an unsubstituted empty variable as absent', () => {
  assert.equal(resolveRoot(['node', 'p.mjs'], { CLAUDE_PLUGIN_ROOT: '' }), null)
  assert.equal(resolveRoot(['node', 'p.mjs', ''], {}), null)
  assert.equal(resolveRoot(['node', 'p.mjs', '/x'], {}), '/x')
  assert.equal(resolveRoot(['node', 'p.mjs'], { CLAUDE_PLUGIN_ROOT: '/y' }), '/y')
})

test('a root without a readable manifest fails', () => {
  assert.equal(find(run({ root: tempDir(), configDir: makeConfigDir() }), 'plugin root').status, 'fail')
})

// --- skills present ---------------------------------------------------------------------------

test('a complete skills tree passes and names what it found', () => {
  const root = makePluginTree(tempDir(), '0.3.0', ['a', 'b', 'c'])
  const row = find(run({ root, configDir: makeConfigDir() }), 'skills present')

  assert.equal(row.status, 'ok')
  assert.match(row.message, /3 skills loaded/)
})

test('a skill directory with no SKILL.md is reported as a truncated cache', () => {
  const root = makePluginTree(tempDir(), '0.3.0', ['a'])
  mkdirSync(join(root, 'skills', 'half-written'), { recursive: true })
  const row = find(run({ root, configDir: makeConfigDir() }), 'skills present')

  assert.equal(row.status, 'fail')
  assert.match(row.message, /half-written/)
})

test('an empty or missing skills directory fails', () => {
  const bare = tempDir()
  writeJson(join(bare, '.claude-plugin', 'plugin.json'), { version: '0.3.0' })
  assert.equal(find(run({ root: bare, configDir: makeConfigDir() }), 'skills present').status, 'fail')

  mkdirSync(join(bare, 'skills'), { recursive: true })
  assert.equal(find(run({ root: bare, configDir: makeConfigDir() }), 'skills present').status, 'fail')
})

// --- config dir -------------------------------------------------------------------------------

test('config dir passes when unset and fails when it diverges from the CLI default', () => {
  const root = makePluginTree(tempDir(), '0.3.0')

  const unset = probe({ root, env: {}, projectPath: '/repo' })
  assert.equal(find(unset, 'config dir').status, 'ok')

  const diverged = probe({ root, env: { CLAUDE_CONFIG_DIR: '/somewhere/else' }, projectPath: '/repo' })
  const row = find(diverged, 'config dir')
  assert.equal(row.status, 'fail')
  assert.match(row.message, /unreliable/)
})

test('config dir is ordered first, before any row the CLI report would be compared against', () => {
  const rows = probe({ root: null, env: {}, projectPath: '/repo' })

  assert.equal(rows[0].name, 'config dir')
})

// --- read-only contract -----------------------------------------------------------------------

test('the probe writes nothing', () => {
  const configDir = makeConfigDir({ records: [], cached: ['0.3.0'] })
  const root = join(configDir, 'plugins', 'cache', 'infra-kit', 'infra-kit', '0.3.0')

  const snapshot = (dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .map((e) => join(e.parentPath ?? e.path, e.name))
      .sort()

  const before = snapshot(configDir)
  probe({ root, env: { CLAUDE_CONFIG_DIR: configDir }, projectPath: '/repo' })

  assert.deepEqual(snapshot(configDir), before)
  assert.ok(existsSync(configDir))
})

// --- report chrome parity -----------------------------------------------------------------------

// The same report `lib/render/__tests__/run-report.test.ts` renders through the CLI's formatter. Both
// sides must reproduce the fixture, so a chrome change on either side reds one of the two tests.
const CHROME_REPORT = {
  title: 'infra-kit chrome fixture',
  sections: [
    {
      label: 'Chrome',
      rows: [
        { name: 'ok row', status: 'ok', message: 'passed' },
        { name: 'changed row', status: 'changed', message: 'wrote the file' },
        { name: 'skipped row', status: 'skipped', message: 'did not run' },
        { name: 'manual row', status: 'manual', message: 'run this yourself' },
        { name: 'warn row', status: 'warn', message: 'advisory finding' },
        {
          name: 'fail row',
          status: 'fail',
          message:
            'a long message that wraps across several lines of the report and carries one unbreakable token /Users/someone/.claude/plugins/cache/infra-kit/infra-kit/0.0.0/skills/doctor/scripts/session-probe.mjs whole',
        },
      ],
    },
  ],
}

test('the probe renders the shared run-report chrome byte for byte', () => {
  const fixture = readFileSync(new URL('./__fixtures__/run-report-chrome.txt', import.meta.url), 'utf8')

  assert.equal(`${formatRunReport(CHROME_REPORT, { width: 80, unicode: true }).join('\n')}\n`, fixture)
})

test('glyphs follow the CLI locale rule: unset means UTF-8, a set non-UTF-8 locale means ASCII', () => {
  assert.equal(resolveUnicode({}), true)
  assert.equal(resolveUnicode({ LC_ALL: '', LANG: 'en_US.UTF-8' }), true)
  assert.equal(resolveUnicode({ LC_ALL: 'C', LANG: 'en_US.UTF-8' }), false)
  assert.equal(resolveUnicode({ LANG: 'en_US.utf8' }), true)
})
