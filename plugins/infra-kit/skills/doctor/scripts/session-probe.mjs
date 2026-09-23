#!/usr/bin/env node
// The five checks `infra-kit doctor` structurally cannot make.
//
// The CLI runs as an ordinary process: it can read what Claude Code RECORDED about the plugin, but
// not which tree this session actually LOADED. Every row below is a comparison where one side is the
// live session — which is why they live here and not in `src/commands/doctor`.
//
// Read-only by contract: this opens files and never writes one. It also never resolves its own module
// location (U12 in the plugin manifest suite) — the plugin root arrives as an argument or an
// environment variable, because a script that located itself would report on its own copy rather than
// on the copy the session loaded, which is the one question worth asking.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Claude Code's key for this plugin, mirroring `PLUGIN_KEY` in the CLI's plugin-pointer lib. */
const PLUGIN_KEY = 'infra-kit@infra-kit'

/** Marketplace directory name under the plugin cache, mirroring `MARKETPLACE_NAME`. */
const MARKETPLACE_NAME = 'infra-kit'

/** Severity vocabulary. Deliberately three-valued: the CLI's `CheckResult` is `pass | fail` with no
 * middle, which is exactly why advisory findings cannot be expressed there and are expressed here. */
const OK = 'ok'
const WARN = 'warn'
const FAIL = 'fail'

const row = (name, status, message) => {
  return { name, status, message }
}

/** Parse a JSON file. Distinguishes "not there" from "there but unreadable" — a distinction the
 * drift rows depend on, since only the second is a problem worth reporting as one. */
const readJson = (file) => {
  if (!fs.existsSync(file)) return { kind: 'absent' }

  try {
    return { kind: 'ok', value: JSON.parse(fs.readFileSync(file, 'utf-8')) }
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The version a plugin tree declares. Read from the MANIFEST, never from an install record's
 * `version` field: for a marketplace served from a git repo that field carries a commit sha, so
 * comparing it against a semver reports drift on every healthy machine. */
const manifestVersion = (root) => {
  const parsed = readJson(path.join(root, '.claude-plugin', 'plugin.json'))

  return parsed.kind === 'ok' && typeof parsed.value?.version === 'string' ? parsed.value.version : null
}

/**
 * Claude Code's config directory.
 *
 * `CLAUDE_CONFIG_DIR` is honoured here and NOT by the infra-kit CLI, which hardcodes `~/.claude`.
 * That asymmetry is the whole point of the `config dir` row: when the variable is set, the CLI's
 * plugin rows are reading a directory the user is not using.
 */
const defaultConfigDir = () => {
  return path.join(os.homedir(), '.claude')
}

const configDir = (env) => {
  return env.CLAUDE_CONFIG_DIR ?? defaultConfigDir()
}

const checkConfigDir = (env) => {
  const configured = env.CLAUDE_CONFIG_DIR
  const fallback = defaultConfigDir()

  if (configured === undefined || configured === '') {
    return row('config dir', OK, `Using the default ${fallback}`)
  }

  if (path.resolve(configured) === path.resolve(fallback)) {
    return row('config dir', OK, `CLAUDE_CONFIG_DIR is set but equals the default ${fallback}`)
  }

  return row(
    'config dir',
    FAIL,
    `CLAUDE_CONFIG_DIR is ${configured}, but infra-kit doctor reads ${fallback}. Its plugin rows ` +
      'describe a directory you are not using — read them as unreliable',
  )
}

const checkPluginRoot = (root) => {
  if (root === null) {
    return row(
      'plugin root',
      FAIL,
      "unresolved — pass it as the first argument, or substitute the skill's stated base " +
        'directory for ${CLAUDE_PLUGIN_ROOT}, which the shell does not set',
    )
  }

  const version = manifestVersion(root)

  if (version === null) {
    return row('plugin root', FAIL, `${root} has no readable .claude-plugin/plugin.json`)
  }

  return row('plugin root', OK, `Session loaded ${root} (version ${version})`)
}

/** Every install record for this plugin, or the reason there are none to read. */
const readInstallations = (env) => {
  const parsed = readJson(path.join(configDir(env), 'plugins', 'installed_plugins.json'))

  if (parsed.kind !== 'ok') return parsed

  const entries = parsed.value?.plugins?.[PLUGIN_KEY]

  return { kind: 'ok', value: Array.isArray(entries) ? entries : [] }
}

/**
 * The record covering `projectPath`, or null.
 *
 * Deliberately no "else take the first record" fallback: a project-scope install belonging to a
 * different repository is not this session's install, and treating it as one would compare the loaded
 * tree against a path that was never meant to cover this project — reporting drift that is really
 * just someone else's install. A record with no `projectPath` is user-scope and does cover everything.
 */
const coveringInstallation = (installations, projectPath) => {
  const covers = (entry) => {
    // Absent projectPath means user scope, which covers every repository.
    if (entry?.projectPath === null || entry?.projectPath === undefined) return true
    if (typeof entry.projectPath !== 'string') return false
    // An empty string is malformed, not user scope. `path.resolve('')` returns the CWD, so without
    // this it would silently "cover" whichever directory the probe happened to run in.
    if (entry.projectPath.trim() === '') return false

    return path.resolve(entry.projectPath) === path.resolve(projectPath)
  }

  return installations.find(covers) ?? null
}

const checkSessionVsRecords = (root, env, projectPath) => {
  const name = 'session vs records'
  const installations = readInstallations(env)

  if (installations.kind === 'absent') {
    return row(name, WARN, 'No installed_plugins.json — nothing recorded this plugin as installed')
  }

  if (installations.kind === 'unreadable') {
    return row(name, WARN, `installed_plugins.json could not be parsed (${installations.reason})`)
  }

  if (installations.value.length === 0) {
    return row(
      name,
      FAIL,
      `Nothing records ${PLUGIN_KEY} as installed, so this session loads no infra-kit skills. ` +
        'Run: infra-kit setup --skip-tools',
    )
  }

  const covering = coveringInstallation(installations.value, projectPath)

  if (covering === null) {
    return row(
      name,
      FAIL,
      `${installations.value.length} install record(s) for ${PLUGIN_KEY}, but none covers this ` +
        'project, so this session loads no infra-kit skills here. Run: infra-kit setup --skip-tools',
    )
  }

  const installPath = typeof covering.installPath === 'string' ? covering.installPath : null

  if (root === null || installPath === null) {
    return row(name, WARN, 'Not comparable: no plugin root or no installPath on the record')
  }

  if (path.resolve(installPath) === path.resolve(root)) {
    return row(name, OK, `Session and records agree on ${installPath}`)
  }

  return row(
    name,
    FAIL,
    `Session loaded ${root} (${manifestVersion(root) ?? 'unknown'}) but records name ` +
      `${installPath} (${manifestVersion(installPath) ?? 'unknown'}). Restart Claude Code`,
  )
}

/** Version directories under the plugin's cache, newest last by numeric-aware comparison. */
const cachedVersions = (env) => {
  const cache = path.join(configDir(env), 'plugins', 'cache', MARKETPLACE_NAME, MARKETPLACE_NAME)

  if (!fs.existsSync(cache)) return []

  return fs
    .readdirSync(cache, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/**
 * Numeric-aware ordering, so 0.10.0 sorts above 0.2.0 rather than below it.
 *
 * Not semver: `localeCompare` has no prerelease semantics, so `1.0.0-rc.1` would sort ABOVE `1.0.0`
 * and read as "ahead". Unreachable today — this plugin ships plain semver and `cachedVersions`
 * filters to directories starting with a digit — but a prerelease would misreport, and the fix then
 * is a real semver compare, not a tweak to this one.
 */
const compareVersions = (a, b) => {
  return a.localeCompare(b, undefined, { numeric: true })
}

/**
 * Is a NEWER version sitting in the cache than the one this session loaded?
 *
 * Asymmetric on purpose. Only `cached > loaded` is a problem; `loaded > cached` is the normal state
 * when the plugin is run straight from a working tree (`claude --plugin-dir ./plugins/infra-kit`),
 * which is what anyone developing this plugin does and what the README's own token measurement uses.
 * An equality test would tell those users to reinstall on top of a tree that is ahead of the cache.
 */
const checkOutdated = (root, env) => {
  const name = 'outdated plugin'
  const versions = cachedVersions(env)
  const loaded = root === null ? null : manifestVersion(root)

  if (versions.length === 0) return row(name, WARN, 'No cached versions to compare against')
  if (loaded === null) return row(name, WARN, 'Not comparable: the loaded plugin declares no version')

  const newest = versions[versions.length - 1]

  if (compareVersions(newest, loaded) <= 0) {
    const ahead = compareVersions(loaded, newest) > 0 ? ` (ahead of the newest cached ${newest})` : ''

    return row(name, OK, `Running ${loaded}${ahead}`)
  }

  return row(
    name,
    FAIL,
    `Session is running ${loaded} but ${newest} is cached (${versions.length} cached: ` +
      `${versions.join(', ')}). Reinstall the plugin, then restart Claude Code`,
  )
}

/**
 * Is the loaded skills tree intact?
 *
 * Deliberately NOT a comparison against a hardcoded list of skill names: that list is owned by the
 * plugin's own manifest suite, and a copy here would be a second inventory that drifts. A truncated
 * cache is instead detected structurally — a skill directory with no SKILL.md is not a skill.
 */
const checkSkillsPresent = (root) => {
  const name = 'skills present'

  if (root === null) return row(name, WARN, 'Not comparable: no plugin root')

  const skillsDir = path.join(root, 'skills')

  if (!fs.existsSync(skillsDir)) return row(name, FAIL, `No skills directory at ${skillsDir}`)

  const dirs = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  if (dirs.length === 0) return row(name, FAIL, `${skillsDir} is empty — the cache looks truncated`)

  const broken = dirs.filter((dir) => !fs.existsSync(path.join(skillsDir, dir, 'SKILL.md')))

  if (broken.length > 0) {
    return row(name, FAIL, `${broken.length} skill directory without a SKILL.md: ${broken.join(', ')}`)
  }

  return row(name, OK, `${dirs.length} skills loaded: ${dirs.join(', ')}`)
}

/**
 * Run every check. `config dir` leads deliberately: when it fails, the infra-kit doctor report the
 * skill prints alongside this one is describing the wrong directory, and the reader needs to know
 * that before reading it rather than after.
 */
export const probe = ({ root, env = process.env, projectPath }) => {
  return [
    checkConfigDir(env),
    checkPluginRoot(root),
    checkSessionVsRecords(root, env, projectPath),
    checkOutdated(root, env),
    checkSkillsPresent(root),
  ]
}

// ---------------------------------------------------------------------------------------------------
// Report chrome — a DUPLICATE of the CLI's `lib/render/run-report.ts`, not an import of it.
//
// Step 2 of the doctor skill runs this probe precisely when the CLI may be broken (a stale global, a
// half-installed bundle), so it cannot depend on the CLI's TypeScript or dist. Drift is caught instead
// by one golden file, `__tests__/__fixtures__/run-report-chrome.txt`, which both the plugin's
// `session-probe.test.mjs` and the CLI's `run-report.test.ts` render byte for byte. Change the chrome
// in one place and the other side's test reds.
// ---------------------------------------------------------------------------------------------------

/**
 * The probe only ever emits ok, warn and fail. `changed`, `skipped` and `manual` are defensive: they
 * exist so the shared fixture can cover all six statuses through this one formatter.
 */
const GLYPHS = {
  unicode: { ok: '✓', changed: '+', skipped: '-', manual: '>', warn: '!', fail: '✗', separator: '·', rule: '─' },
  ascii: { ok: 'ok', changed: '++', skipped: '--', manual: '>>', warn: '!?', fail: '!!', separator: '-', rule: '-' },
}

const MIN_MESSAGE_WIDTH = 24
const INDENT = '  '
const ROW_INDENT = '    '

/** Stdout is a pipe into the skill's transcript, so there is no terminal width to read. */
const REPORT_WIDTH = 80

/** Words longer than `width` stay whole on their own line: a command split mid-token is not runnable. */
const wrapText = (text, width) => {
  const words = text.split(/\s+/).filter((word) => word.length > 0)
  const lines = []
  let current = ''

  for (const word of words) {
    if (current.length === 0) current = word
    else if (`${current} ${word}`.length <= width) current = `${current} ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  if (current.length > 0) lines.push(current)

  return lines.length > 0 ? lines : ['']
}

const tally = (rows) => {
  const counts = { ok: 0, changed: 0, skipped: 0, manual: 0, warn: 0, fail: 0 }

  for (const r of rows) counts[r.status] += 1

  return counts
}

/** The fixed order shared by the rollup and the totals line; only the warn wording differs. */
const countParts = (counts, warnWord) => {
  return [
    { status: 'changed', plain: `${counts.changed} changed` },
    { status: 'skipped', plain: `${counts.skipped} skipped` },
    { status: 'manual', plain: `${counts.manual} to run yourself` },
    { status: 'fail', plain: `${counts.fail} failed` },
    { status: 'warn', plain: `${counts.warn} ${warnWord(counts.warn)}` },
  ].filter((part) => counts[part.status] > 0)
}

const formatRollup = (counts, total, glyphs) => {
  if (counts.ok === total) return `${total}/${total} ok`

  const parts = countParts(counts, (count) => `warning${count === 1 ? '' : 's'}`)

  return [`${counts.ok + counts.changed}/${total}`, ...parts.map((part) => part.plain)].join(` ${glyphs.separator} `)
}

const formatSectionHeader = (section, glyphs, width) => {
  const rollup = formatRollup(tally(section.rows), section.rows.length, glyphs)
  const gap = Math.max(1, width - INDENT.length - section.label.length - rollup.length)

  return `${INDENT}${section.label}${' '.repeat(gap)}${rollup}`
}

const formatRow = (r, nameWidth, glyphs, width) => {
  const messageColumn = ROW_INDENT.length + glyphs.ok.length + 1 + nameWidth + 2
  const messageWidth = Math.max(MIN_MESSAGE_WIDTH, width - messageColumn)
  const [first, ...rest] = wrapText(r.message, messageWidth)
  const hanging = ' '.repeat(messageColumn)
  const head = `${ROW_INDENT}${glyphs[r.status]} ${r.name.padEnd(nameWidth)}  ${first ?? ''}`.trimEnd()

  return [
    head,
    ...rest.map((line) => `${hanging}${line}`),
    ...(r.notes ?? []).map((note) => `${hanging}${note}`.trimEnd()),
  ]
}

const formatSummary = (report, rows, glyphs, width) => {
  const counts = tally(rows)
  const rule = glyphs.rule.repeat(Math.max(12, Math.min(width - INDENT.length, 56)))
  const parts = countParts(counts, () => 'warned')
  const totals = [`${counts.ok} passed`, ...parts.map((part) => part.plain)].join(` ${glyphs.separator} `)
  const hints = (report.hints ?? []).map((hint) => `  ${hint}`)

  return [`${INDENT}${rule}`, `${INDENT}${totals}${hints.join('')}`]
}

/**
 * The CLI's `formatRunReport` with colour permanently off: the probe's stdout is a pipe, never a
 * terminal, so there is no case in which ANSI would render.
 */
export const formatRunReport = (report, { unicode = true, width = REPORT_WIDTH } = {}) => {
  const glyphs = unicode ? GLYPHS.unicode : GLYPHS.ascii
  const sections = report.sections.filter((section) => section.rows.length > 0)
  const rows = sections.flatMap((section) => section.rows)

  if (rows.length === 0) return [report.title, '', `${INDENT}${report.emptyMessage ?? 'Nothing ran.'}`]

  // One name column for the whole report, so the message column does not jump at each heading.
  const nameWidth = Math.max(...rows.map((r) => r.name.length))
  const body = sections.flatMap((section) => [
    formatSectionHeader(section, glyphs, width),
    ...section.rows.flatMap((r) => formatRow(r, nameWidth, glyphs, width)),
    '',
  ])

  return [report.title, '', ...body, ...formatSummary(report, rows, glyphs, width)]
}

/**
 * The CLI's `resolveUnicode`: UTF-8 unless a locale variable is SET and says otherwise. An unset locale
 * is the common case (launchd, CI, bare `sh`) and renders the glyphs fine.
 */
export const resolveUnicode = (env) => {
  const locale = ['LC_ALL', 'LC_CTYPE', 'LANG']
    .map((name) => env[name])
    .find((value) => value !== undefined && value !== '')

  return locale === undefined ? true : /UTF-?8/i.test(locale)
}

export const formatProbeReport = (rows, env) => {
  return formatRunReport(
    { title: 'infra-kit doctor (session)', sections: [{ label: 'Session (plugin-side)', rows }] },
    { unicode: resolveUnicode(env), width: REPORT_WIDTH },
  )
}

/**
 * The plugin root, from argv then the environment. An empty string counts as absent: an unsubstituted
 * `${CLAUDE_PLUGIN_ROOT}` expands to nothing in the shell, and treating that as a path produces a
 * MODULE_NOT_FOUND-shaped mystery instead of the named row this returns.
 */
export const resolveRoot = (argv, env) => {
  const candidate = argv[2] ?? env.CLAUDE_PLUGIN_ROOT ?? ''

  return candidate.trim() === '' ? null : candidate
}

const main = () => {
  const root = resolveRoot(process.argv, process.env)
  // The repo being diagnosed. Read here rather than defaulted inside `probe` so the pure function
  // stays free of ambient state and every test passes the path explicitly.
  const projectPath = process.cwd()
  const rows = probe({ root, projectPath })

  process.stdout.write(`${formatProbeReport(rows, process.env).join('\n')}\n`)
}

// Exit status is always 0: findings belong in the report the skill renders, not in a code that would
// make the harness present a working probe as a failed command.
if (process.argv[1] && process.argv[1].endsWith('session-probe.mjs')) main()
