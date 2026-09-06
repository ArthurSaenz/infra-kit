import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MARKETPLACE_NAME, PLUGIN_KEY } from './plugin-pointer'

/**
 * @fileoverview
 *
 * HOST-STATE readers: what Claude Code itself records on this machine about the `infra-kit`
 * marketplace and plugin, plus the consumer repo's own MCP server registration.
 *
 * All of it is read-only and total — every reader answers "not registered / not installed" for an
 * absent, unreadable or malformed file rather than throwing. `init` prints an install hint from
 * these answers and `doctor` reports them as rows, and neither may crash because a user hand-edited
 * a JSON file under `~/.claude/`.
 *
 * These files are Claude Code's, not ours. Nothing here writes to them: installing a plugin is the
 * `claude plugin install` command's job, and a CLI that edited another tool's state directory would
 * be repairing something it does not own.
 */

/** Where Claude Code keeps its plugin bookkeeping, relative to `$HOME`. */
const PLUGINS_DIR = ['.claude', 'plugins']

/** One entry of `installed_plugins.json`'s per-plugin array. Extra fields are ignored, not rejected. */
export interface PluginInstallation {
  scope: string | null
  projectPath: string | null
  installPath: string | null
  version: string | null
}

const readJsonFile = (filePath: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return undefined
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const readString = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key]

  return typeof value === 'string' ? value : null
}

/** `~/.claude/plugins/<file>`, with `$HOME` injectable so tests never read the developer's own state. */
const pluginsPath = (file: string, home: string = os.homedir()): string => {
  return path.join(home, ...PLUGINS_DIR, file)
}

/**
 * Is the `infra-kit` marketplace registered on this machine?
 *
 * Registration is a machine fact (`~/.claude/plugins/known_marketplaces.json`), distinct from the
 * per-project `extraKnownMarketplaces` pointer `init` writes: the pointer says where to look, this
 * says the lookup has actually happened.
 *
 * @example
 * isMarketplaceRegistered() // => true once `claude plugin marketplace add ArthurSaenz/infra-kit` has run
 */
export const isMarketplaceRegistered = (home?: string): boolean => {
  const parsed = readJsonFile(pluginsPath('known_marketplaces.json', home))

  return isPlainObject(parsed) && MARKETPLACE_NAME in parsed
}

const toInstallation = (entry: unknown): PluginInstallation | null => {
  if (!isPlainObject(entry)) return null

  return {
    scope: readString(entry, 'scope'),
    projectPath: readString(entry, 'projectPath'),
    installPath: readString(entry, 'installPath'),
    version: readString(entry, 'version'),
  }
}

const readInstallations = (home?: string): PluginInstallation[] => {
  const parsed = readJsonFile(pluginsPath('installed_plugins.json', home))

  if (!isPlainObject(parsed) || !isPlainObject(parsed.plugins)) return []

  const entries = parsed.plugins[PLUGIN_KEY]

  if (!Array.isArray(entries)) return []

  return entries.flatMap((entry): PluginInstallation[] => {
    const installation = toInstallation(entry)

    return installation === null ? [] : [installation]
  })
}

export interface PluginInstallationQuery {
  /** Override `$HOME` (tests, and nothing else). */
  home?: string
  /** The project root being asked about. Omitted, only a user-scope entry can count as installed. */
  projectPath?: string
}

/**
 * Whether the plugin is installed FOR THIS PROJECT — not merely present somewhere on the machine.
 *
 * `elsewhere` is the distinction that matters: it carries the records that exist, so the caller can
 * say which other project they belong to instead of reporting a bare "not installed".
 */
export type PluginInstallState =
  | { kind: 'installed'; installation: PluginInstallation }
  | { kind: 'elsewhere'; installations: readonly PluginInstallation[] }
  | { kind: 'absent' }

/**
 * A path in the form the two sides can be compared in. `realpath` on both sides or neither: on macOS
 * `/tmp` resolves to `/private/tmp`, so a resolved path compared against an unresolved one never
 * matches. Falls back to `path.resolve` for a path that no longer exists, which `realpath` rejects.
 */
const canonicalPath = (target: string): string => {
  try {
    return fs.realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * Does one record make the plugin active in `root`?
 *
 * A `user`-scope install is machine-wide and covers every project. Otherwise the record has to NAME
 * this project: `claude plugin install --scope project` stores the directory the session was started
 * in, so an install done for another repo covers that repo and nothing else.
 *
 * A record whose `projectPath` is this root counts whatever scope string it carries — the path is the
 * stronger signal, and an older Claude Code wrote records with no `scope` field at all.
 */
const coversProject = (entry: PluginInstallation, root: string | null): boolean => {
  if (entry.scope === 'user') return true
  if (root === null || entry.projectPath === null) return false

  return canonicalPath(entry.projectPath) === root
}

/**
 * Resolve what `~/.claude/plugins/installed_plugins.json` says about THIS project.
 *
 * @example
 * resolvePluginInstall({ projectPath: '/repo' })
 * // => { kind: 'elsewhere', installations: [{ projectPath: '/other', … }] }  // installed, but not here
 */
export const resolvePluginInstall = (query: PluginInstallationQuery = {}): PluginInstallState => {
  const installations = readInstallations(query.home)

  if (installations.length === 0) return { kind: 'absent' }

  const root = query.projectPath === undefined ? null : canonicalPath(query.projectPath)

  const covering = installations.find((entry) => {
    return coversProject(entry, root)
  })

  return covering === undefined ? { kind: 'elsewhere', installations } : { kind: 'installed', installation: covering }
}

/**
 * The installed plugin's version: the record's own `version`, falling back to the manifest at
 * `<installPath>/.claude-plugin/plugin.json`.
 *
 * The fallback is not redundant. `installed_plugins.json` records a git-commit sha as `version` for
 * marketplaces served from a repo, so the manifest is the only place a human-readable `0.4.0` lives
 * — and an entry written by an older Claude Code may carry no `version` at all.
 *
 * @example
 * readInstalledPluginVersion({ scope: 'project', projectPath: null, installPath: '/cache/infra-kit', version: null })
 * // => '0.4.0'  (read from /cache/infra-kit/.claude-plugin/plugin.json)
 */
export const readInstalledPluginVersion = (installation: PluginInstallation): string | null => {
  if (installation.installPath === null) return installation.version

  const manifest = readJsonFile(path.join(installation.installPath, '.claude-plugin', 'plugin.json'))
  const declared = isPlainObject(manifest) ? readString(manifest, 'version') : null

  return declared ?? installation.version
}

/** How a repo's `.mcp.json` registers (or fails to register) the infra-kit MCP server. */
export type McpRegistration =
  | { kind: 'ok' }
  | { kind: 'missing-file' }
  | { kind: 'unparseable' }
  | { kind: 'wrong-key'; key: string }
  | { kind: 'absent' }

/** A server entry that IS infra-kit's, whatever key it was filed under. */
const looksLikeInfraKitServer = (value: unknown): boolean => {
  if (!isPlainObject(value)) return false

  const command = readString(value, 'command') ?? ''
  const args = Array.isArray(value.args) ? value.args.join(' ') : ''

  return `${command} ${args}`.includes('infra-kit')
}

/**
 * Inspect a repo's `.mcp.json` for the `infra-kit` server key.
 *
 * Why the KEY and not merely the server: Claude Code namespaces MCP tools as
 * `mcp__<server key>__<tool>`, and every skill this plugin ships names its tools with the
 * `mcp__infra-kit__` prefix. Register the same server under `ik` and every one of those references
 * silently resolves to nothing — the skills do not fail loudly, they just never find the tool. So a
 * correctly-configured server under the wrong key is a FAILURE here, and it is reported as one.
 *
 * @example
 * inspectMcpRegistration('/repo') // => { kind: 'ok' }
 * inspectMcpRegistration('/other') // => { kind: 'wrong-key', key: 'ik' }
 */
export const inspectMcpRegistration = (projectRoot: string): McpRegistration => {
  const mcpPath = path.join(projectRoot, '.mcp.json')

  if (!fs.existsSync(mcpPath)) return { kind: 'missing-file' }

  const parsed = readJsonFile(mcpPath)

  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) return { kind: 'unparseable' }

  const servers = parsed.mcpServers

  if (MARKETPLACE_NAME in servers) return { kind: 'ok' }

  const misfiled = Object.keys(servers).find((key) => {
    return looksLikeInfraKitServer(servers[key])
  })

  return misfiled === undefined ? { kind: 'absent' } : { kind: 'wrong-key', key: misfiled }
}
