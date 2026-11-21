import fs from 'node:fs'
import path from 'node:path'

import { resolvePluginInstall } from './install-state'

/**
 * @fileoverview
 *
 * Which plugins a repo's own Claude Code settings enable, and which of those have no install record
 * covering the project. Read-only and total, like every reader beside it: an absent or malformed
 * settings file enables nothing.
 */

/** One `enabledPlugins` key set to `true`, with the install scope that matches the file naming it. */
export interface EnabledPlugin {
  /** `<plugin>@<marketplace>`. */
  key: string
  /** `project` for `.claude/settings.json`, `local` for `.claude/settings.local.json`. */
  scope: 'project' | 'local'
}

/** Read in this order: the local file is the higher-precedence layer, so its `false` disables a shared `true`. */
const SETTINGS_LAYERS: ReadonlyArray<readonly [file: string, scope: EnabledPlugin['scope']]> = [
  ['settings.json', 'project'],
  ['settings.local.json', 'local'],
]

const readEnabledMap = (filePath: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

    const enabled =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).enabledPlugins : null

    return typeof enabled === 'object' && enabled !== null && !Array.isArray(enabled)
      ? (enabled as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * The plugins `<root>/.claude/settings.json` and `settings.local.json` enable, in file order.
 *
 * @example
 * readProjectEnabledPlugins('/repo') // => [{ key: 'context7@claude-plugins-official', scope: 'project' }]
 */
export const readProjectEnabledPlugins = (root: string): EnabledPlugin[] => {
  const merged = new Map<string, EnabledPlugin | null>()

  for (const [file, scope] of SETTINGS_LAYERS) {
    for (const [key, value] of Object.entries(readEnabledMap(path.join(root, '.claude', file)))) {
      if (value === true) merged.set(key, merged.get(key) ?? { key, scope })
      else merged.set(key, null)
    }
  }

  return [...merged.values()].filter((plugin): plugin is EnabledPlugin => {
    return plugin !== null
  })
}

/**
 * The enabled plugins with no install record covering `projectPath` — a user-scope record, or one
 * naming this directory. A record for another checkout does not count: `claude plugin install
 * --scope project` binds to the directory it ran in, so every worktree needs its own.
 *
 * @example
 * listUninstalledEnabledPlugins({ projectPath: '/repo' }) // => [{ key: 'atlassian@claude-plugins-official', scope: 'project' }]
 */
export const listUninstalledEnabledPlugins = (query: { projectPath: string; home?: string }): EnabledPlugin[] => {
  return readProjectEnabledPlugins(query.projectPath).filter((plugin) => {
    return resolvePluginInstall({ ...query, pluginKey: plugin.key }).kind !== 'installed'
  })
}
