import { z } from 'zod'

import { configKeys } from 'src/commands/config-set'
import { getInfraKitConfig, getInfraKitConfigPaths } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { defineMcpTool, textContent } from 'src/types'

export interface ConfigGetArgs {
  /** One top-level key to report as `value` (null when no layer sets it). */
  key?: string
}

/**
 * Return the fully MERGED infra-kit config — the exact object every other command sees at runtime, after
 * the three override layers (project `infra-kit.json` → `~/.infra-kit/infra-kit.json` →
 * `~/.infra-kit/projects/<repo>/infra-kit.json`) are shallow-merged. Read-only introspection: it REUSES
 * {@link getInfraKitConfig} (never re-implements the loader), so an agent sees precisely the resolved
 * config, not a re-derived approximation, and can reason about dev presets / env management / proxy routes
 * without shelling out.
 *
 * Throws the same "infra-kit.json not found" error the loader throws when run outside a configured repo —
 * that is an honest failure, not an empty success.
 */
export const configGet = async ({ key }: ConfigGetArgs = {}) => {
  const [config, paths] = await Promise.all([getInfraKitConfig(), getInfraKitConfigPaths()])

  const merged = config as Record<string, unknown>

  if (key === undefined) {
    const topLevelKeys = Object.keys(config).sort()

    logger.info(
      `Merged config for ${paths.projectName} — ${topLevelKeys.length} section(s): ${topLevelKeys.join(', ')}`,
    )
    logger.info(`  source: ${paths.main}`)
  } else {
    if (!configKeys().includes(key)) {
      throw new Error(`Unknown config key "${key}". Top-level keys: ${configKeys().join(', ')}.`)
    }

    logger.info(`${key} = ${JSON.stringify(merged[key] ?? null, null, 2)}`)
  }

  const structuredContent = {
    // `config` is the merged object. A typed InfraKitConfig is assignable to Record<string, unknown>.
    config: merged,
    configPath: paths.main,
    projectName: paths.projectName,
    ...(key === undefined ? {} : { key, value: merged[key] ?? null }),
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

const configGetOutputSchema = {
  config: z
    .record(z.string(), z.unknown())
    .describe(
      'The fully resolved infra-kit configuration — the same object every command sees at runtime, after the project infra-kit.json, the user-global, and the user-scope per-project override layers are merged (later layers win). Top-level sections include envManagement, ide, worktrees, dev, devServersPresets, and protectedEnvs.',
    ),
  configPath: z
    .string()
    .describe('Absolute path to the project-level infra-kit.json (the base layer / committed source of truth).'),
  key: z.string().optional().describe('The top-level key asked for, when one was.'),
  value: z.unknown().optional().describe('The merged value of `key` (null when no layer sets it).'),
  projectName: z
    .string()
    .describe(
      'Repository name the config is keyed to (the main-repo basename; shared across all worktrees of the repo).',
    ),
}

// MCP Tool Registration
export const configGetMcpTool = defineMcpTool({
  name: 'config-get',
  description:
    'Return the fully merged infra-kit configuration (project + user-global + per-project override layers) as it is resolved at runtime. Read-only introspection — makes no changes; use `config-set` / `config-unset` (top-level keys) or `config edit` (CLI-only) to modify the per-machine override file (every key except `mcp`, which is project-layer only and refused there). Fails with the loader error when run outside a configured infra-kit repo, or when an override layer carries a refused key.',
  inputSchema: {
    key: z.string().optional().describe('Report only this top-level key as `value` (e.g. `ide`).'),
  },
  outputSchema: configGetOutputSchema,
  handler: (params: ConfigGetArgs) => {
    return configGet(params)
  },
})
