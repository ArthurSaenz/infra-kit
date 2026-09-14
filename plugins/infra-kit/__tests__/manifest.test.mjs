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
  'doctor',
  'e2e-architect',
  'fe-architect',
  'fe-patterns',
  'full-cycle',
  'release-create',
  'session',
  'setup',
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
// The pre-0.8.0 tool prefix (`.mcp.json`-spawned server). U19 counts it, so its needle is fragmented
// like the others; T1 keeps its inline literal and U19's expected count is that one occurrence.
const [LEGACY_TOOL_PREFIX] = SCAN_PATTERNS.legacyToolPrefix.map((parts) => parts.join(''))
// The one definition of "names a plugin-served tool" (see the fixture's `_pluginToolNameWhy`).
const PLUGIN_TOOL_NAME_RE = new RegExp(SCAN_PATTERNS.pluginToolName, 'g')

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Every file under `dir`, skipping this suite's fixture tree and any installed dependency tree. */
function walkFiles(dir) {
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
function parseFrontmatter(text) {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return null
  const end = lines.indexOf('---', 1)
  if (end === -1) return null
  return { data: parseFrontmatterLines(lines.slice(1, end)), body: lines.slice(end + 1).join('\n') }
}

// ---------------------------------------------------------------------------
// U6 — allowed-tools versus the fenced command corpus
// ---------------------------------------------------------------------------

// `infra-kit` is here for a reason worth stating: without it, a fenced `infra-kit …` line entered no
// corpus, so clause 2 never checked it AND clause 3 flagged the matching allowed-tools rule as dead —
// i.e. declaring the rule the README promises made U6 red, and omitting it made the command prompt on
// every run. Widening closes both halves. Note this set feeds TWO predicates: U6's corpus below and
// U5's `scripts/` rooting check.
const COMMAND_HEADS = new Set(['node', 'python3', 'pnpm', 'git', 'infra-kit'])
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
function commandCorpus(body) {
  return fencedLines(body).filter((line) => COMMAND_HEADS.has(firstToken(line)))
}

function bashRules(allowedTools) {
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

function ruleMatches(rule, line) {
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
function checkSkillTools(frontmatter, body) {
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
      // The repo-root walk starts at the cwd on purpose: run as a plugin, the script's own
      // directory is never the consumer repo (comment-verifier/__tests__/repo-root.test.mjs).
      'const start = process.cwd()',
    ],
  ],
  [
    'doctor/scripts/session-probe.mjs',
    [
      // The repo being diagnosed, read once at the entry point. Note what is NOT here: the plugin
      // root. That arrives as an argument, because a probe that located its own copy would report on
      // that copy rather than on the tree the session actually loaded.
      'const projectPath = process.cwd()',
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
function checkSelfLocation(text, allowed = []) {
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
function unrootedScriptLines(text) {
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

// Without this the `infra-kit` head added to COMMAND_HEADS would be a fail-open: it makes such lines
// ELIGIBLE for checking, and only a red case proves they are actually checked.
test('U6 red: a fenced infra-kit command with no matching rule fails clause 2', () => {
  const { data, body } = loadFixture('u6-infra-kit-unruled.md')
  const errors = checkSkillTools(data, body).errors

  assert.deepEqual(
    errors.map((e) => e.clause),
    [2],
  )
  assert.match(errors[0].message, /infra-kit doctor/)
})

// ---------------------------------------------------------------------------
// U15 / U16 — the doctor skill's two authoring contracts
//
// Both are DENY lists, not sources of truth. Neither enumerates what the doctor report contains; they
// enumerate what this skill must not say. Drift therefore makes them weaker, never wrong, which is why
// they do not constitute the "second inventory" the plugin's design forbids.
// ---------------------------------------------------------------------------

const DOCTOR_SKILL = join(SKILLS_DIR, 'doctor', 'SKILL.md')

// Verbs that change the machine. The doctor skill may name these in prose, never in a fence: a fenced
// line obliges an allowed-tools rule (clause 2), and a rule is a standing grant that runs without a
// prompt. Keeping them unfenced is what keeps the grant out of the plugin.
// `setup-dependency` is a PREFIX of `setup-dependency-status`, which is read-only and which a future
// skill may legitimately fence. Matching is by substring, so a status line is caught too — deliberately
// the fail-closed direction, the same tradeoff `block-deploy.mjs` documents for its own lookbehind. If a
// status-fencing skill ever ships, this needle needs a word boundary rather than a widened allowlist.
//
// `infra-kit setup` replaces the `infra-kit init` needle this list carried while that command existed.
// Substring matching makes it cover `infra-kit setup --skip-tools` as well, which is the intended
// reading and not an accident of the prefix: `--skip-tools` still writes `~/.zshrc`, the plugin pointer
// and every guidance block, so it is exactly as unfit for a standing grant as the flagless form.
const MUTATING_INVOCATIONS = ['--fix', 'audit --fix', 'infra-kit setup', 'setup-dependency', 'setup-dependency-update']

test('U15: the doctor skill fences no state-changing command', () => {
  const parsed = parseFrontmatter(readText(DOCTOR_SKILL))
  assert.ok(parsed, 'doctor SKILL.md has no parseable frontmatter')

  const offences = fencedLines(parsed.body).flatMap((line) =>
    MUTATING_INVOCATIONS.filter((needle) => line.includes(needle)).map((needle) => `${needle} in \`${line}\``),
  )

  assert.deepEqual(offences, [], 'a mutating command inside a fence would be granted without a prompt')
})

// Row names and section labels owned by the CLI's report. The skill prints that report verbatim, so
// repeating any of these would be a copy that goes stale the moment a check is renamed.
const REPORT_OWNED_STRINGS = [
  'claude CLI',
  'marketplace registered',
  'plugin installed',
  'plugin version',
  'CLI version',
  'MCP server key',
  'plugin MCP server',
  'CLAUDE.md block',
  'portless routes',
  'tokens.json perms',
  'infra-kit config valid',
  'Tools & CLIs',
]

test('U16: the doctor skill restates no report row name or section label', () => {
  const text = readText(DOCTOR_SKILL)
  const hits = REPORT_OWNED_STRINGS.filter((needle) => text.includes(needle))

  assert.deepEqual(hits, [], 'the skill must render the report, not describe its contents')
})

// ---------------------------------------------------------------------------
// U7 / U8 — plugin.json and the marketplace entry
// ---------------------------------------------------------------------------

const PLUGIN_JSON = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')

function readPluginJson() {
  assert.ok(existsSync(PLUGIN_JSON), `${rel(PLUGIN_JSON)} is missing`)
  return JSON.parse(readText(PLUGIN_JSON))
}

// The server lives in `.mcp.json`, never inline in plugin.json: one place to read, one place to
// diff. The whole object is asserted, not picked fields — a dropped `cwd` or an added `env` is a
// contract change the CLI's `git rev-parse`-from-cwd resolution depends on, and a field-by-field
// check is blind to additions (memory: a hand-picked-field diff misses added/removed fields).
const PLUGIN_MCP_JSON = join(PLUGIN_ROOT, '.mcp.json')
const EXPECTED_MCP_JSON = {
  mcpServers: {
    'infra-kit': {
      type: 'stdio',
      command: 'infra-kit',
      args: ['mcp'],
      cwd: '${CLAUDE_PROJECT_DIR}',
    },
  },
}

test('U7: plugin.json declares no inline mcpServers, hooks, or commands; .mcp.json carries exactly the one server', () => {
  const manifest = readPluginJson()
  for (const key of ['mcpServers', 'hooks', 'commands']) {
    assert.ok(!(key in manifest), `plugin.json must not declare ${key} inline`)
  }
  assert.ok(existsSync(PLUGIN_MCP_JSON), `${rel(PLUGIN_MCP_JSON)} is missing`)
  assert.deepEqual(JSON.parse(readText(PLUGIN_MCP_JSON)), EXPECTED_MCP_JSON)
})

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/

test('U8: plugin.json version is semver and the marketplace entry carries none', () => {
  assert.match(readPluginJson().version, SEMVER_RE)
  const marketplace = join(REPO_ROOT, '.claude-plugin', 'marketplace.json')
  assert.ok(existsSync(marketplace), `${rel(marketplace)} is missing`)
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

// ---------------------------------------------------------------------------
// U13' / U14' / U17' / U18 / U19 — the procedure skills
//
// The procedures that were served as MCP resources and reached through `commands/` are skills now
// (docs/session-env-picker-plan.md §3). A SKILL.md body is the ONLY text the agent reads, so what
// `src/mcp/__tests__/server.test.ts` used to pin on the served bytes is pinned here, on the body.
// ---------------------------------------------------------------------------

const COMMANDS_DIR = join(PLUGIN_ROOT, 'commands')

test("U13': the commands/ tree is gone — every procedure is a skill", () => {
  assert.equal(existsSync(COMMANDS_DIR), false, `${rel(COMMANDS_DIR)} must not exist`)
})

/** Every plugin-served tool `text` names, bare (`env-load`), de-duplicated, in order of first mention. */
function namedPluginTools(text) {
  return [...new Set([...text.matchAll(PLUGIN_TOOL_NAME_RE)].map((match) => match[1]))]
}

// The confirm-gated tools — `EXPECTED_GATED_TOOLS` in the CLI's command-catalog.test.ts. Copied, not
// imported: this suite is plain node with no path into the CLI package; the CLI side cross-checks that
// every tool NAME a skill mentions is an exposed catalog tool. A gated tool in `allowed-tools` would let
// the gate's round 2 — an agent-authored, same-turn re-call — run with no host prompt at all (§3.1),
// which is why `env-clear` is absent from the session skill's grant on purpose.
const GATED_TOOLS = [
  'release-create',
  'env-clear',
  'setup',
  'gh-release-deploy-all',
  'gh-release-deploy-selected',
  'local-deploy-all',
  'local-deploy-selected',
  'worktrees-remove',
  'release-remove',
  'gh-merge-dev',
]

// Key sets are exact, and the `disable-model-invocation` split is the design: `session` and
// `release-create` are human-only (one loads secrets into the human's terminal, the other is gated),
// so only `/name` may invoke them. `setup` stays model-invocable ON PURPOSE — its reader is the agent
// about to call the tool, so auto-loading is what replaces the deleted resource; its human gate is the
// tool's own confirm protocol, which no `allowed-tools` grant can skip.
const PROCEDURE_SKILLS = {
  'release-create': {
    keys: ['argument-hint', 'description', 'disable-model-invocation', 'name'],
    humanOnly: true,
  },
  session: {
    keys: ['allowed-tools', 'argument-hint', 'description', 'disable-model-invocation', 'name'],
    humanOnly: true,
  },
  setup: {
    keys: ['description', 'name'],
    humanOnly: false,
  },
}

function procedureSkill(name) {
  const file = join(SKILLS_DIR, name, 'SKILL.md')
  const parsed = parseFrontmatter(readText(file))
  assert.ok(parsed, `${rel(file)} has no parseable frontmatter`)
  return { file, ...parsed }
}

test("U14': each procedure skill pins its frontmatter keys, its invocation policy, and grants no gated tool", () => {
  for (const [name, expected] of Object.entries(PROCEDURE_SKILLS)) {
    const { file, data } = procedureSkill(name)

    assert.deepEqual(
      Object.keys(data).sort(),
      expected.keys,
      `${rel(file)} frontmatter must carry exactly ${expected.keys.join(', ')}`,
    )

    if (expected.humanOnly) {
      assert.equal(data['disable-model-invocation'], 'true', `${rel(file)} must be human-only`)
    } else {
      assert.equal(
        'disable-model-invocation' in data,
        false,
        `${rel(file)} must stay model-invocable — its reader is the agent about to call the tool`,
      )
    }

    const allowed = String(data['allowed-tools'] ?? '')
    const gatedGranted = namedPluginTools(allowed).filter((tool) => GATED_TOOLS.includes(tool))
    assert.deepEqual(gatedGranted, [], `${rel(file)} allowed-tools must name no gated tool`)
    assert.deepEqual(bashRules(allowed), [], `${rel(file)} must carry zero Bash( rules`)
  }
})

// U17' — the `argument-hint` is a promise to the human, and the body is the only text the AGENT reads.
// `release-create` once advertised `[--hotfix] [--desc <text>]` for a release cycle while nothing
// defined them, so the hint named a syntax no reader could act on. Binding the hint to a DEFINITION in
// the same file (the flag in backticks on a line carrying `→`) rather than to a literal is what lets
// the guard survive a deliberate rename of both sides while reddening on a rename of one. Scoped to
// the procedure skills: their flags are conventions the body must translate into tool fields, which
// is what the `→` form spells; a pipeline skill's flags are its own.
test("U17': every procedure-skill argument-hint flag is defined with → in the same SKILL.md", () => {
  for (const name of Object.keys(PROCEDURE_SKILLS)) {
    const { file, data, body } = procedureSkill(name)

    const hint = String(data['argument-hint'] ?? '')
    const flags = [...hint.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0])

    for (const flag of flags) {
      // A DEFINITION, not a mention: requiring only that the flag appear somewhere would pass on a
      // body that merely warns the flag is unsupported.
      const defined = body.split('\n').some((line) => line.includes(`\`${flag}`) && line.includes('→'))
      assert.ok(
        defined,
        `${rel(file)}'s argument-hint promises ${flag}, but its body never defines what it maps to — ` +
          'add a line of the form "- `' +
          flag +
          '` → <the tool field it sets>"',
      )
    }
  }
})

// U18 — the session body. Every literal below is a fragment of one instruction, asserted against the
// body with soft line breaks joined (prettier does not reflow these files, an author's rewrap does),
// so a fragment survives an honest rewrap and reddens only when the instruction goes.
const ABSENT_TOOLS_CLAUSE = 'tools are absent this is a subdirectory or legacy session — say so and stop'

/** The body with each paragraph's line breaks joined, so fragments do not depend on where a line wraps. */
function joinedParagraphs(body) {
  return body
    .split('\n\n')
    .map((paragraph) => paragraph.replace(/\n/g, ' '))
    .join('\n\n')
}

const INJECTION_LINES = [
  'Terminal status at invocation: !`zsh -c \'infra-kit env-status --json\' 2>/dev/null || echo \'{"error":"status unavailable"}\'`',
  'Environments this project knows: !`zsh -c \'infra-kit env-list --json\' 2>/dev/null || echo \'{"error":"list unavailable"}\'`',
]

const SESSION_CLAUSES = [
  // The three tools composed, and the resolution of a bare token.
  'mcp__plugin_infra-kit_infra-kit__env-list',
  'mcp__plugin_infra-kit_infra-kit__env-load',
  '`--clear` → `mcp__plugin_infra-kit_infra-kit__env-clear`',
  // The form path: no token → `env-load` without `config`; the human's pick is the load; a decline
  // is terminal for this turn.
  'without `config`',
  'form_declined',
  "`env-load` is not gated, but it can PROMPT — an argument form, not a confirm gate; the human's pick is the load.",
  // The two-shape fallback (a JSON-RPC error from an old CLI, a refusal from a new one) and the CLI
  // floor that decides which one arrives.
  'a tool error or a refused result naming `config`',
  // PM-5: a host that substitutes a placeholder for the injection leaves a non-JSON block.
  'not JSON, treat it as unknown and call `env-list` yourself',
  'infra-kit env-token-set <env>',
  'a name absent from the form must still be typed and passed as `config`',
  // The shell round trip's three properties, and the one check a human can perform.
  'at its next prompt — after Claude Code exits or is backgrounded',
  'the terminal that launched Claude Code and no other',
  'writes into a directory nothing is watching and still returns success',
  'report the session id from the returned filePath',
  'compare it with INFRA_KIT_SESSION at their own prompt',
  'does not persist shell state between calls',
  'INFRA_KIT_SESSION is not set',
  'infra-kit setup --skip-tools',
  // What `env-list` is and is not.
  'not a live Doppler enumeration',
  'an empty list is a legitimate result',
  // The gate, the tie hazard, and the tether to the provider contract.
  'confirmation_required',
  'confirmToken',
  '"confirm": true',
  'in the same wall-clock second',
  'infra-kit: auto-loaded vars for',
  'docs/session-context-orchestrator.md',
  // What not to do — the two clauses that keep the form the human's, not the agent's.
  'Do not supply a `config` the human did not name in order to skip the form.',
  'Never send `inputResponses` yourself',
  ABSENT_TOOLS_CLAUSE,
]

test('U18: the session body carries the two injections, every load-bearing clause, and none of the retired ones', () => {
  const { file, body } = procedureSkill('session')
  const lines = body.split('\n')
  const joined = joinedParagraphs(body)

  // The injections: each is one whole line (Claude Code runs `!` at the start of a line or after
  // whitespace), spelled through `zsh -c` so the reading does not depend on which shell the host's
  // Bash tool is, and never fenced — a fence would put it in U6's corpus and out of the host's.
  for (const line of INJECTION_LINES) {
    assert.ok(lines.includes(line), `${rel(file)} must carry the injection line verbatim: ${line}`)
  }
  assert.equal(body.split('!`').length - 1, INJECTION_LINES.length, `${rel(file)} must inject exactly twice`)
  assert.deepEqual(
    fencedLines(body).filter((line) => line.includes('!`')),
    [],
    `${rel(file)} must not fence an injection`,
  )

  for (const clause of SESSION_CLAUSES) {
    assert.ok(joined.includes(clause), `${rel(file)} lost the clause: ${clause}`)
  }

  // The CLI floor for the form path, and the fallback that survives a server below it.
  assert.match(joined, /form path needs infra-kit \d+\.\d+\.\d+ or newer/, `${rel(file)} must state the CLI floor`)

  // The retired procedure: a hand-picked subset in an `AskUserQuestion` picker. The picker is named
  // only as a prohibition — a line that ASKS through it is the defect this rewrite removed.
  assert.equal(joined.includes('four most likely'), false, `${rel(file)} must not offer a subset`)
  const askLines = lines.filter((line) => line.includes('AskUserQuestion'))
  assert.ok(askLines.length > 0, `${rel(file)} must forbid AskUserQuestion by name`)
  for (const line of askLines) {
    assert.match(line, /Never `AskUserQuestion`/, `${rel(file)} may name AskUserQuestion only to forbid it: ${line}`)
  }
})

// The other two procedure bodies keep the clauses `server.test.ts` pinned when the CLI served them.
const PROCEDURE_CLAUSES = {
  'release-create': [
    'mcp__plugin_infra-kit_infra-kit__release-create',
    'confirmation_required',
    'confirmToken',
    '"confirm": true',
    'does not mean the call failed',
    '`--hotfix` → `type: "hotfix"`',
    '`--desc <text>` → `description`',
    'mutually exclusive',
    '"next"',
    'all entries must share the same `type`',
    'linked worktree',
    'clean working tree',
    ABSENT_TOOLS_CLAUSE,
  ],
  setup: [
    'mcp__plugin_infra-kit_infra-kit__setup',
    '`doctor`',
    'the init half',
    'the dependency converge',
    '**brew, aws, gh, doppler, portless**',
    '`--tools <ids...>` → `tools: ["gh", "doppler"]`',
    '`--update [ids...]` → `mode: "update"`',
    '`--skip-tools` → `skipTools: true`',
    'needs-sudo',
    'fetches-network-script',
    'A refusal is not a failure',
    'confirmation_required',
    'confirmToken',
    '"confirm": true',
    'There is no `init` command',
    '`infra-kit setup --skip-tools`',
    ABSENT_TOOLS_CLAUSE,
  ],
}

test('U18: the release-create and setup bodies carry every load-bearing clause', () => {
  for (const [name, clauses] of Object.entries(PROCEDURE_CLAUSES)) {
    const { file, body } = procedureSkill(name)
    const joined = joinedParagraphs(body)
    for (const clause of clauses) {
      assert.ok(joined.includes(clause), `${rel(file)} lost the clause: ${clause}`)
    }
  }
})

function countOccurrences(text, needle) {
  return text.split(needle).length - 1
}

// U19 — where the pre-0.8.0 prefix may still appear: nowhere the plugin ships. The commands that
// named it as a fallback are gone, and a skill body naming it would send a plugin-launched session to
// a tool it does not have. The one occurrence is T1's own literal, which IS the negative for skills.
test('U19: the legacy tool prefix appears under plugins/ only in T1 (count 1)', () => {
  const found = {}
  for (const file of walkFiles(PLUGINS_DIR)) {
    const count = countOccurrences(readText(file), LEGACY_TOOL_PREFIX)
    if (count > 0) found[rel(file)] = count
  }
  assert.deepEqual(found, { 'plugins/infra-kit/__tests__/manifest.test.mjs': 1 })
})
