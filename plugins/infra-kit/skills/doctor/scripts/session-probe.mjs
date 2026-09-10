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
      `Nothing records ${PLUGIN_KEY} as installed, so this session loads no infra-kit skills. ` + 'Run: infra-kit setup --skip-tools',
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

const MARKERS = { [OK]: 'ok  ', [WARN]: 'warn', [FAIL]: 'FAIL' }

const formatRows = (rows) => {
  return rows.map((r) => `  [${MARKERS[r.status]}] ${r.name}: ${r.message}`)
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

  process.stdout.write(`${['Session checks (plugin-side):', ...formatRows(rows)].join('\n')}\n`)
}

// Exit status is always 0: findings belong in the report the skill renders, not in a code that would
// make the harness present a working probe as a failed command.
if (process.argv[1] && process.argv[1].endsWith('session-probe.mjs')) main()
