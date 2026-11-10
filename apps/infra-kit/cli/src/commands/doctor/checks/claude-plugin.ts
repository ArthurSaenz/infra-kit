import fs from 'node:fs'
import path from 'node:path'

import { checkClaudeInChrome } from 'src/lib/claude-chrome'
import type { ChromeCheckDeps } from 'src/lib/claude-chrome'
import { isWithin, safeRealpath } from 'src/lib/install-manager'
import { tildify } from 'src/lib/path-display'
import {
  MARKETPLACE_NAME,
  MARKETPLACE_REPO,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_KEY,
  PLUGIN_UPDATE_COMMAND,
  isMarketplaceRegistered,
  readInstalledPluginVersion,
  resolvePluginInstall,
} from 'src/lib/plugin-pointer'
import type { PluginInstallState } from 'src/lib/plugin-pointer'
import { readMarketplacePluginVersion } from 'src/lib/plugin-pointer/install-state'
import { MCP_FILE_NAME, SERVERS_KEY } from 'src/lib/plugin-pointer/mcp-registration'
import { isNewerVersion } from 'src/lib/update-check/semver'

import packageJson from '../../../../package.json' with { type: 'json' }
import type { CheckResult } from '../check-result'
import { checkCommand } from './command'

/**
 * The one freshness line this row may carry: the marketplace clone is AHEAD of the copy sessions
 * actually load (the record's cache `installPath`, measured in plan §6.1 S0-7(b)). Empty when the
 * clone is absent, unreadable, equal or behind — a "served ahead" clone is a stale fetch, not a lag.
 *
 * Deliberately no comparison against the CLI's own version: the plugin bump is a separate commit
 * after every lockstep release, so served-vs-CLI legitimately drifts for hours at every release and
 * a line printed that often is one nobody reads (plan §8.0 0c, P6).
 */
const fetchedNotAppliedAdvisory = (served: string): string => {
  const fetched = readMarketplacePluginVersion()

  if (fetched === null || !isNewerVersion(fetched, served)) return ''

  return ` — plugin ${fetched} is fetched but not applied. Run: ${PLUGIN_UPDATE_COMMAND}`
}

/** The version row, reported only for an install that covers THIS project. */
const claudePluginVersionCheck = (state: PluginInstallState): CheckResult => {
  const version = state.kind === 'installed' ? readInstalledPluginVersion(state.installation) : null

  return {
    name: 'plugin version',
    status: version === null ? 'fail' : 'pass',
    message:
      version === null
        ? 'No infra-kit plugin installed for this project to read a version from'
        : `Plugin ${PLUGIN_KEY} version ${version}${fetchedNotAppliedAdvisory(version)}`,
  }
}

/** How many other projects the `elsewhere` message names before it summarises the rest as a count. */
const MAX_LISTED_PROJECTS = 3

/**
 * Where this `doctor` was invoked from — the inputs of the subdirectory advisory on `plugin installed`.
 *
 * A project-scope plugin and the repo's `.claude/settings.json` hooks load from the directory Claude
 * Code was LAUNCHED in, and only from there (measured, plan §3.2 F5 / §12 S1-6); a session started in
 * `apps/` has neither. `doctor` cannot see the launch directory, so it reads two proxies for it:
 * `projectDir` (`CLAUDE_PROJECT_DIR`, which Claude Code sets to the launch directory for hooks and
 * set for the retired served tool, never for a Bash call — when present, `≠ gitRoot` is the PRECISE
 * test) and `cwd` (all the typed CLI has — a hint,
 * since a root-launched session whose model `cd`s into `apps/` and types `doctor` is not a
 * subdirectory session, hence the hedged wording).
 */
export interface DoctorOrigin {
  /** `CLAUDE_PROJECT_DIR`, or `null` when unset — the typed CLI. */
  projectDir: string | null
  cwd: string
  /** The git toplevel, or `null` outside a repo (no advisory can be made). */
  gitRoot: string | null
}

/** Realpath'd on both sides: git answers `/private/var/…` where the shell says `/var/…` on macOS. */
const samePath = (a: string, b: string): boolean => {
  return safeRealpath(a) === safeRealpath(b)
}

/**
 * The sentence appended to `plugin installed` when this session may have been launched below the
 * root, or `''`. Message-only — status is a fact about the install record, not about where the
 * caller stands (plan §3.3 A-2 mitigation).
 */
const subdirectoryAdvisory = (origin: DoctorOrigin | undefined): string => {
  if (origin === undefined || origin.gitRoot === null) return ''

  const root = tildify(origin.gitRoot)

  if (origin.projectDir !== null) {
    if (samePath(origin.projectDir, origin.gitRoot)) return ''

    // `realpath` on the child too (`isWithin` resolves the parent only): `/var` vs `/private/var`.
    const where = isWithin(origin.gitRoot, safeRealpath(origin.projectDir), safeRealpath)
      ? 'below the repo root'
      : 'not this checkout'

    return ` — this session was launched from ${tildify(origin.projectDir)}, ${where}: the plugin and this repo's .claude/settings.json hooks load only from ${root} (measured); restart Claude Code there`
  }

  if (samePath(origin.cwd, origin.gitRoot)) return ''

  return ` — if Claude Code was launched from ${tildify(origin.cwd)} rather than ${root}, it loaded neither the plugin nor this repo's hooks; launch it at ${root}`
}

/** The install row. `elsewhere` names the projects the existing records DO cover, which is the fix. */
const claudePluginInstalledCheck = (state: PluginInstallState, origin: DoctorOrigin | undefined): CheckResult => {
  const name = 'plugin installed'
  const advisory = subdirectoryAdvisory(origin)

  if (state.kind === 'installed') {
    const { scope, projectPath } = state.installation
    const where = projectPath === null ? '' : `, ${tildify(projectPath)}`

    return {
      name,
      status: 'pass',
      message: `Plugin ${PLUGIN_KEY} installed (${scope ?? 'unknown'} scope${where})${advisory}`,
    }
  }

  if (state.kind === 'absent') {
    return {
      name,
      status: 'fail',
      message: `Plugin ${PLUGIN_KEY} is not installed. Run: ${PLUGIN_INSTALL_COMMAND}${advisory}`,
    }
  }

  // Capped at three: a machine that has rolled this out to every repo carries a dozen records, and a
  // row naming all of them buries the one thing the reader needs — that none of them is this project.
  const paths = state.installations.map((entry) => {
    return entry.projectPath === null ? '(unnamed project)' : tildify(entry.projectPath)
  })

  const extra = paths.length - MAX_LISTED_PROJECTS
  const suffix = extra > 0 ? ` and ${extra} more` : ''
  const others = `${paths.slice(0, MAX_LISTED_PROJECTS).join(', ')}${suffix}`

  return {
    name,
    status: 'fail',
    message: `Plugin ${PLUGIN_KEY} is installed for ${others} only, not this project. Run: ${PLUGIN_INSTALL_COMMAND}${advisory}`,
  }
}

/**
 * Is the `claude` binary on PATH? The PREREQUISITE row for everything below it: `infra-kit setup`
 * installs the plugin by driving `claude plugin install`, so on a machine without that binary the
 * three rows that follow are failing for a reason none of their own messages names.
 *
 * Deliberately NOT wired into the exit code — only `plugin installed` is. A machine that has chosen
 * not to install Claude Code is reporting a fact, not a broken setup.
 *
 * @example
 * await checkClaudeCli() // => { name: 'claude CLI', status: 'pass', message: 'Installed: claude' }
 */
export const checkClaudeCli = (): Promise<CheckResult> => {
  return checkCommand(
    'claude CLI',
    ['claude', '--version'],
    'Installed: claude',
    'claude CLI not found on PATH — `infra-kit setup` cannot install the plugin; install Claude Code first',
  )
}

// Re-exported: the check moved to a lib so `setup` can read it without importing doctor.
export { checkClaudeInChrome }
export type { ChromeCheckDeps }

/**
 * What the SERVED plugin copy carries by way of an MCP server — which, since the plugin went
 * skills-only, is the STALE state: a copy that still ships `.mcp.json` predates the split and would
 * spawn a server the skills no longer talk to.
 *
 * The served copy is the install record's `installPath` (`~/.claude/plugins/cache/…/<v>/`), NOT the
 * marketplace clone: the clone is what `claude plugin update` fetches, the record is what a session
 * loads (measured, archived plan docs/archive/mcp/mcp-via-plugin-migration-plan.md §6.1 S0-7(b)) — so
 * a clone that is ahead of the record must not change this verdict. Capability-keyed on purpose: the
 * row reads the served `.mcp.json`, never a version floor, so an older copy hand-stripped of the file
 * passes and a newer one that regrew it is reported.
 */
export type ServedPluginServer =
  | { kind: 'not-installed' }
  /** No `.mcp.json` in the served copy — as shipped since the split, or a record with no path. */
  | { kind: 'skills-only'; version: string | null }
  /** A `.mcp.json` is there: a copy from before the split, whatever it keys the server under. */
  | { kind: 'stale-server'; version: string | null; keys: string[] }

const readServedJson = (installPath: string, ...segments: string[]): unknown => {
  try {
    return JSON.parse(fs.readFileSync(path.join(installPath, ...segments), 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Read the served copy's `.mcp.json`. Any `mcpServers` object at all is `stale-server` — the plugin
 * as shipped has no such file, so what the entries say is a detail for the message, not a verdict.
 *
 * @example
 * inspectServedPluginServer(resolvePluginInstall({ projectPath: '/repo' })) // => { kind: 'skills-only', version: '<served>' }
 */
export const inspectServedPluginServer = (state: PluginInstallState): ServedPluginServer => {
  if (state.kind !== 'installed') return { kind: 'not-installed' }

  const version = readInstalledPluginVersion(state.installation)
  const { installPath } = state.installation

  if (installPath === null) return { kind: 'skills-only', version }

  const mcp = readServedJson(installPath, MCP_FILE_NAME)
  const servers = mcp !== null && typeof mcp === 'object' ? (mcp as Record<string, unknown>)[SERVERS_KEY] : undefined

  if (servers === undefined || servers === null || typeof servers !== 'object') return { kind: 'skills-only', version }

  return { kind: 'stale-server', version, keys: Object.keys(servers as Record<string, unknown>) }
}

/** `Plugin <key> <version>` with a readable stand-in when no version could be read. */
const describeServedPlugin = (version: string | null): string => {
  const suffix = version === null ? '(version unreadable)' : version

  return `Plugin ${PLUGIN_KEY} ${suffix}`
}

/**
 * The `plugin MCP server` row, kept under its old name so a pasted report still lines up: does the
 * served plugin STILL carry an MCP server? Skills-only is healthy; a copy with `.mcp.json` is stale
 * and passes with the update advisory — it works, on the old surface, until it is updated.
 *
 * Fixes are the plugin's own commands, never a `.mcp.json` write: `claude plugin update` (which
 * `infra-kit setup` drives) is what advances the record a session loads.
 */
const claudePluginServerCheck = (served: ServedPluginServer): CheckResult => {
  const name = 'plugin MCP server'

  if (served.kind === 'not-installed') {
    return {
      name,
      status: 'fail',
      message: `No infra-kit plugin installed for this project — no skills to drive the CLI. Run: ${PLUGIN_INSTALL_COMMAND}`,
    }
  }

  if (served.kind === 'stale-server') {
    const under = served.keys.length === 0 ? '' : ` (under "${served.keys.join('", "')}")`

    return {
      name,
      status: 'pass',
      message: `${describeServedPlugin(served.version)} still carries an MCP server in its ${MCP_FILE_NAME}${under} — a copy from before the plugin went skills-only. Update it: infra-kit setup (or ${PLUGIN_UPDATE_COMMAND}), then restart Claude Code`,
    }
  }

  return {
    name,
    status: 'pass',
    message: `${describeServedPlugin(served.version)} is skills-only — no ${MCP_FILE_NAME}, as shipped; the /infra-kit:* skills drive the infra-kit CLI`,
  }
}

/**
 * The five host-state rows about the `infra-kit` Claude Code plugin: is its marketplace registered
 * on this machine, is the plugin installed, which version, is the served copy skills-only, and which
 * CLI is reporting it.
 *
 * All five are emitted whatever `root` is, so the row set never changes shape between directories.
 * `root` narrows the VERDICT only: it is the project a project-scope install has to name to count.
 * `origin` feeds the subdirectory advisory on `plugin installed` and nothing else.
 *
 * @example
 * checkClaudePlugin('/repo')
 * // => [{ name: 'marketplace registered', … }, { name: 'plugin installed', … }, … ]
 */
export const checkClaudePlugin = (root: string | null, origin?: DoctorOrigin): CheckResult[] => {
  const state = resolvePluginInstall(root === null ? {} : { projectPath: root })
  const registered = isMarketplaceRegistered()

  return [
    {
      name: 'marketplace registered',
      status: registered ? 'pass' : 'fail',
      message: registered
        ? `Marketplace ${MARKETPLACE_NAME} is known to Claude Code`
        : `Marketplace ${MARKETPLACE_NAME} is not registered. Run: claude plugin marketplace add ${MARKETPLACE_REPO}`,
    },
    claudePluginInstalledCheck(state, origin),
    claudePluginVersionCheck(state),
    claudePluginServerCheck(inspectServedPluginServer(state)),
    { name: 'CLI version', status: 'pass', message: `infra-kit CLI ${packageJson.version}` },
  ]
}
