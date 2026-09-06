// Static guards for the packaged plugin tree. Every assertion here is mechanical: the plugin ships
// as data, so the only thing that can catch a bad edit before a consumer installs it is a scan.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'

const TESTS_DIR = import.meta.dirname
const PLUGIN_ROOT = join(TESTS_DIR, '..')
const PLUGINS_DIR = join(PLUGIN_ROOT, '..')
const REPO_ROOT = join(PLUGINS_DIR, '..')
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills')
const FIXTURES_DIR = join(TESTS_DIR, '__fixtures__')

// This suite's own fixtures hold deliberate red cases (project-relative paths, self-rooted writes).
// Scanning them would make every corpus guard permanently red on its own evidence.
const EXEMPT_DIRS = new Set([FIXTURES_DIR])

const EXPECTED_SKILLS = [
  'comment-verifier',
  'e2e-architect',
  'fe-architect',
  'fe-patterns',
  'full-cycle',
  'update-toolchain',
]

// Claude Code reads none of these. They are OMC-era pipeline metadata that would ship as dead weight.
const BANNED_FRONTMATTER_KEYS = [
  'aliases',
  'pipeline',
  'next-skill',
  'next-skill-args',
  'tags',
  'author',
  'license',
  'version',
]

// The needles live in a fixture, not here. This file is scanned by U5 and T5 like every other file
// under plugins/ — `__tests__` is deliberately not exempt — so a literal pattern written inline
// would make the scanner its own only offender and hide every real one behind it.
// Each needle is stored as fragments, so an external `grep -ri` over plugins/ finds no self-hit
// either — the fixture is inert to the very search T5 describes.
const SCAN_PATTERNS = JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', 'scan-patterns.json'), 'utf8'))
const PROJECT_RELATIVE = SCAN_PATTERNS.projectRelative.map((parts) => parts.join(''))
const DENYLIST = SCAN_PATTERNS.denylist.map((parts) => parts.join(''))

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Every file under `dir`, skipping this suite's fixture tree and any installed dependency tree. */
export function walkFiles(dir) {
  if (EXEMPT_DIRS.has(dir) || dir.endsWith(`${sep}node_modules`)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function skillDirs() {
  if (!existsSync(SKILLS_DIR)) return []
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

function rel(file) {
  return relative(REPO_ROOT, file)
}

function readText(file) {
  return readFileSync(file, 'utf8')
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

const BLOCK_MARKERS = new Set(['>', '>-', '>+', '|', '|-', '|+'])

function unquote(value) {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value)
  return quoted ? quoted[2] : value
}

/** Reads one scalar starting at `index`, following a `>`/`|` block marker across indented lines. */
function readScalar(lines, index, raw) {
  const marker = raw.trim()
  if (!BLOCK_MARKERS.has(marker)) return { value: unquote(marker), next: index + 1 }
  const collected = []
  let cursor = index + 1
  while (cursor < lines.length && (lines[cursor].trim() === '' || /^\s/.test(lines[cursor]))) {
    collected.push(lines[cursor].trim())
    cursor += 1
  }
  return { value: collected.join(marker.startsWith('>') ? ' ' : '\n').trim(), next: cursor }
}

function parseFrontmatterLines(lines) {
  const out = {}
  let cursor = 0
  while (cursor < lines.length) {
    const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[cursor])
    if (!match) {
      cursor += 1
      continue
    }
    const scalar = readScalar(lines, cursor, match[2])
    out[match[1]] = scalar.value
    cursor = scalar.next
  }
  return out
}

/** `null` when the file carries no `---` fenced frontmatter at all. */
export function parseFrontmatter(text) {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return null
  const end = lines.indexOf('---', 1)
  if (end === -1) return null
  return { data: parseFrontmatterLines(lines.slice(1, end)), body: lines.slice(end + 1).join('\n') }
}

// ---------------------------------------------------------------------------
// U6 — allowed-tools versus the fenced command corpus
// ---------------------------------------------------------------------------

const COMMAND_HEADS = new Set(['node', 'python3', 'pnpm', 'git'])
const PLACEHOLDER = '\u0001'

function fencedLines(body) {
  const out = []
  let inFence = false
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence
    else if (inFence) out.push(line.trim())
  }
  return out
}

function firstToken(line) {
  return line.split(/\s+/)[0]
}

/** Clause 1: the corpus is fenced command lines only; prose mentions are documentation. */
export function commandCorpus(body) {
  return fencedLines(body).filter((line) => COMMAND_HEADS.has(firstToken(line)))
}

export function bashRules(allowedTools) {
  return [...String(allowedTools ?? '').matchAll(/Bash\(([^)]*)\)/g)].map((m) => m[1].trim())
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A rule `*` spans one or more characters; a body `<placeholder>` stands in for one whole token. */
function tokenPattern(token) {
  if (token.includes('*')) return escapeRe(token).split('\\*').join('[\\s\\S]+')
  return `(?:${escapeRe(token)}|${PLACEHOLDER})`
}

function canonicalLine(line) {
  return line
    .split(/\s+/)
    .map((token) => (/^<.*>$/.test(token) ? PLACEHOLDER : token))
    .join(' ')
}

export function ruleMatches(rule, line) {
  const pattern = rule.trim().split(/\s+/).map(tokenPattern).join('\\s+')
  return new RegExp(`^${pattern}$`).test(canonicalLine(line))
}

function clause2Errors(corpus, rules) {
  const errors = []
  for (const line of corpus.filter((l) => firstToken(l) !== 'git')) {
    const hits = rules.filter((rule) => ruleMatches(rule, line))
    if (hits.length !== 1) {
      errors.push({ clause: 2, message: `${hits.length} allowed-tools rules match \`${line}\`` })
    }
  }
  return errors
}

function clause3Errors(corpus, rules) {
  const errors = []
  for (const rule of rules.filter((r) => firstToken(r) !== 'git')) {
    if (!corpus.some((line) => ruleMatches(rule, line))) {
      errors.push({ clause: 3, message: `dead rule Bash(${rule}) matches no fenced command line` })
    }
  }
  return errors
}

/** U6 / plan §8.1a. Pure: takes parsed frontmatter and the markdown body, returns every violation. */
export function checkSkillTools(frontmatter, body) {
  const corpus = commandCorpus(body)
  const rules = bashRules(frontmatter['allowed-tools'])
  const errors = [...clause2Errors(corpus, rules), ...clause3Errors(corpus, rules)]
  return { ok: errors.length === 0, errors, corpus, rules }
}

// ---------------------------------------------------------------------------
// U12 / PM-2 — self-location predicate
// ---------------------------------------------------------------------------

const SELF_TOKENS = ['import.meta.url', 'import.meta.dirname', '__dirname', 'process.cwd()']
const WRITE_CALL_RE = /\b(?:writeFile|writeFileSync|mkdir|mkdirSync|rm|rmSync|rename|renameSync)\s*\(/

// Keyed by exact line text, not line number: an edit elsewhere in the file must not break this.
const SELF_LOCATION_ALLOWLIST = new Map([
  [
    'comment-verifier/scripts/lint-comments.mjs',
    [
      // Locates the skill's own references/ tree for the policy read.
      'const HERE = path.dirname(fileURLToPath(import.meta.url))',
      // Entry-point check: only run the CLI when invoked directly.
      'if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {',
    ],
  ],
  [
    'fe-architect/scripts/scaffold_feature.mjs',
    [
      // Locates the skill root so the template tree can be read.
      'const __dirname = dirname(fileURLToPath(import.meta.url))',
      "const SKILL_DIR = join(__dirname, '..')",
      // Spawns a sibling script by absolute path.
      "const child = spawn(process.execPath, [join(__dirname, script), ...args], { stdio: 'inherit' })",
    ],
  ],
  [
    'fe-architect/scripts/validate_feature.mjs',
    [
      // Same as scaffold: locates the skill root to read its own reference data.
      'const __filename = fileURLToPath(import.meta.url)',
      'const __dirname = dirname(__filename)',
    ],
  ],
])

function mentionsSelf(text, vars) {
  if (SELF_TOKENS.some((token) => text.includes(token))) return true
  return [...vars].some((name) => new RegExp(`\\b${escapeRe(name)}\\b`).test(text))
}

/** Every name this file binds as a function or arrow parameter. */
function parameterNames(text) {
  const names = new Set()
  const patterns = [/\(([^()]*)\)\s*=>/g, /function\s*[\w$]*\s*\(([^()]*)\)/g]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      for (const part of match[1].split(',')) {
        const name = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(part)
        if (name) names.add(name[1])
      }
    }
  }
  return names
}

/**
 * Names bound, directly or transitively, to a self-resolved path within one file. Tracking is
 * name-based, so it is restricted to module-scope bindings whose name is never a parameter: a
 * `dir` seeded once at module scope would otherwise mark every function's own `dir` self-rooted.
 */
function selfRootedVars(lines, params) {
  const vars = new Set()
  for (const line of lines) {
    const match = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([\s\S]*)$/.exec(line)
    if (match && !params.has(match[1]) && mentionsSelf(match[2], vars)) vars.add(match[1])
  }
  return vars
}

/** U12. `allowed` is the exact-text allow-list of legitimate read sites for this file. */
export function checkSelfLocation(text, allowed = []) {
  const allowSet = new Set(allowed)
  const lines = text.split('\n')
  const vars = selfRootedVars(lines, parameterNames(text))
  const errors = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (SELF_TOKENS.some((t) => trimmed.includes(t)) && !allowSet.has(trimmed)) {
      errors.push({ kind: 'unlisted', line: trimmed })
    }
    if (WRITE_CALL_RE.test(trimmed) && mentionsSelf(trimmed, vars)) {
      errors.push({ kind: 'self-rooted-write', line: trimmed })
    }
  }
  return errors
}

// ---------------------------------------------------------------------------
// U2 / U3 — skill inventory and frontmatter identity
// ---------------------------------------------------------------------------

test('U3: skill directories equal the expected literal list', () => {
  assert.deepEqual(skillDirs(), [...EXPECTED_SKILLS].sort())
})

test('U2: every skill has a SKILL.md whose frontmatter name matches its directory', () => {
  for (const name of skillDirs()) {
    const file = join(SKILLS_DIR, name, 'SKILL.md')
    assert.ok(existsSync(file), `${rel(file)} is missing`)
    const parsed = parseFrontmatter(readText(file))
    assert.ok(parsed, `${rel(file)} has no parseable frontmatter`)
    assert.ok(parsed.data.description, `${rel(file)} frontmatter has no description`)
    assert.equal(parsed.data.name, name, `${rel(file)} frontmatter name must equal its directory`)
  }
})

// ---------------------------------------------------------------------------
// U4 — no unsupported frontmatter keys
// ---------------------------------------------------------------------------

test('U4: no frontmatter under plugins/ carries an unsupported key', () => {
  const offences = []
  for (const file of walkFiles(PLUGINS_DIR).filter((f) => f.endsWith('.md'))) {
    const parsed = parseFrontmatter(readText(file))
    if (!parsed) continue
    for (const key of BANNED_FRONTMATTER_KEYS) {
      if (key in parsed.data) offences.push(`${rel(file)}: ${key}`)
    }
  }
  assert.deepEqual(offences, [])
})

// ---------------------------------------------------------------------------
// U5 — no project-relative path survives
// ---------------------------------------------------------------------------

function literalPathHits(file, text) {
  return text
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => PROJECT_RELATIVE.some((needle) => line.includes(needle)))
    .map(({ index }) => `${rel(file)}:${index + 1}`)
}

/** A `scripts/` invocation inside a fence must be rooted at the plugin root, not at the repo. */
export function unrootedScriptLines(text) {
  return fencedLines(text)
    .filter((line) => COMMAND_HEADS.has(firstToken(line)) && line.includes('scripts/'))
    .filter((line) => !line.slice(0, line.indexOf('scripts/')).includes('CLAUDE_PLUGIN_ROOT'))
}

function unrootedScriptHits(file, text) {
  if (!file.endsWith('.md')) return []
  return unrootedScriptLines(text).map((line) => `${rel(file)}: ${line}`)
}

test('U5: no project-relative skill or hook path anywhere under plugins/', () => {
  const hits = []
  for (const file of walkFiles(PLUGINS_DIR)) {
    const text = readText(file)
    hits.push(...literalPathHits(file, text), ...unrootedScriptHits(file, text))
  }
  assert.deepEqual(hits, [])
})

// Without this the `scripts/` half of U5 is a fail-open: the literal half is what goes red today,
// so a broken rooting check would sit unnoticed behind it until the literal hits are cleaned up.
test('U5 red: an unrooted scripts/ invocation in a fence is caught', () => {
  const text = readText(join(FIXTURES_DIR, 'u5-unrooted-script.md'))
  const hits = unrootedScriptLines(text)
  assert.equal(hits.length, 1)
  assert.match(hits[0], /scaffold_feature\.mjs/)
})

// ---------------------------------------------------------------------------
// U6 — allowed-tools ↔ fenced corpus, live tree plus three red fixtures
// ---------------------------------------------------------------------------

test('U6: every SKILL.md allowed-tools set matches its fenced command corpus', () => {
  const failures = []
  for (const name of skillDirs()) {
    const file = join(SKILLS_DIR, name, 'SKILL.md')
    const parsed = parseFrontmatter(readText(file))
    if (!parsed) continue
    const result = checkSkillTools(parsed.data, parsed.body)
    failures.push(...result.errors.map((e) => `${rel(file)} [clause ${e.clause}] ${e.message}`))
  }
  assert.deepEqual(failures, [])
})

function loadFixture(name) {
  const parsed = parseFrontmatter(readText(join(FIXTURES_DIR, name)))
  assert.ok(parsed, `${name} fixture has no frontmatter`)
  return parsed
}

test('U6 green: the reference fixture satisfies every clause', () => {
  const { data, body } = loadFixture('u6-green.md')
  assert.deepEqual(checkSkillTools(data, body).errors, [])
})

test('U6 red: a path changed in the body only fails clause 2', () => {
  const { data, body } = loadFixture('u6-body-path-changed.md')
  const clauses = checkSkillTools(data, body).errors.map((e) => e.clause)
  assert.ok(clauses.includes(2), 'expected an unmatched fenced command line')
})

test('U6 red: a rule matching nothing fails clause 3', () => {
  const { data, body } = loadFixture('u6-dead-rule.md')
  const errors = checkSkillTools(data, body).errors
  assert.deepEqual(
    errors.map((e) => e.clause),
    [3],
  )
  assert.match(errors[0].message, /python3/)
})

test('U6 red: an invocation moved from a fence into prose leaves the corpus', () => {
  const { data, body } = loadFixture('u6-prose-invocation.md')
  const result = checkSkillTools(data, body)
  assert.ok(
    !result.corpus.some((line) => line.includes('lint-comments.mjs')),
    'a prose mention must never enter the corpus',
  )
  assert.ok(!result.ok, 'the orphaned rule must fail the check')
})

// ---------------------------------------------------------------------------
// U7 / U8 — plugin.json and the marketplace entry
// ---------------------------------------------------------------------------

const PLUGIN_JSON = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')

function readPluginJson() {
  assert.ok(existsSync(PLUGIN_JSON), `${rel(PLUGIN_JSON)} is missing`)
  return JSON.parse(readText(PLUGIN_JSON))
}

test('U7: plugin.json declares no mcpServers, hooks, or commands', () => {
  const manifest = readPluginJson()
  for (const key of ['mcpServers', 'hooks', 'commands']) {
    assert.ok(!(key in manifest), `plugin.json must not declare ${key}`)
  }
})

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/

test('U8: plugin.json version is semver and the marketplace entry carries none', () => {
  assert.match(readPluginJson().version, SEMVER_RE)
  const marketplace = join(REPO_ROOT, '.claude-plugin', 'marketplace.json')
  if (!existsSync(marketplace)) {
    // PR C adds this file; until then there is no entry to contradict plugin.json.
    return
  }
  const entry = JSON.parse(readText(marketplace)).plugins?.find((p) => p.name === 'infra-kit')
  assert.ok(entry, 'marketplace.json has no infra-kit entry')
  assert.ok(!('version' in entry), 'the marketplace entry must not pin a version')
})

// ---------------------------------------------------------------------------
// U12 — PM-2 self-location predicate over the bundled scripts
// ---------------------------------------------------------------------------

function scriptFiles() {
  return skillDirs()
    .map((name) => join(SKILLS_DIR, name, 'scripts'))
    .filter((dir) => existsSync(dir) && statSync(dir).isDirectory())
    .flatMap((dir) => walkFiles(dir))
    .filter((file) => /\.(mjs|js|cjs|py)$/.test(file))
}

test('U12: every self-location read site is allow-listed and none feeds a write', () => {
  const offences = []
  for (const file of scriptFiles()) {
    const key = relative(SKILLS_DIR, file).split(sep).join('/')
    const errors = checkSelfLocation(readText(file), SELF_LOCATION_ALLOWLIST.get(key) ?? [])
    offences.push(...errors.map((e) => `${key} [${e.kind}] ${e.line}`))
  }
  assert.deepEqual(offences, [])
})

test('U12 red: a write rooted at a self-resolved path is rejected', () => {
  const fixture = readText(join(FIXTURES_DIR, 'u12-self-rooted-write.mjs'))
  const allowed = ['const HERE = path.dirname(fileURLToPath(import.meta.url))']
  const kinds = checkSelfLocation(fixture, allowed).map((e) => e.kind)
  assert.ok(kinds.includes('self-rooted-write'), 'a cache write beside the script must fail')
})

test('U12 red: an unlisted self-location read site is rejected', () => {
  const kinds = checkSelfLocation('const base = process.cwd()', []).map((e) => e.kind)
  assert.deepEqual(kinds, ['unlisted'])
})

// ---------------------------------------------------------------------------
// T1 / T5 — content boundaries
// ---------------------------------------------------------------------------

test('T1: no skill under plugins/ names an infra-kit MCP tool', () => {
  const hits = walkFiles(SKILLS_DIR)
    .filter((file) => readText(file).includes('mcp__infra-kit__'))
    .map(rel)
  assert.deepEqual(hits, [])
})

test('T5: no consumer-repo name appears anywhere under plugins/', () => {
  const hits = []
  for (const file of walkFiles(PLUGINS_DIR)) {
    const lower = readText(file).toLowerCase()
    const found = DENYLIST.filter((word) => lower.includes(word))
    hits.push(...found.map((word) => `${rel(file)}: ${word}`))
  }
  assert.deepEqual(hits, [])
})
