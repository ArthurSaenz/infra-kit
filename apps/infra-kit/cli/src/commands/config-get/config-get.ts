import { z } from 'zod'

import { getInfraKitConfig, getInfraKitConfigPaths } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { defineMcpTool, textContent } from 'src/types'

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
export const configGet = async () => {
  const [config, paths] = await Promise.all([getInfraKitConfig(), getInfraKitConfigPaths()])

  const topLevelKeys = Object.keys(config).sort()

  logger.info(`Merged config for ${paths.projectName} — ${topLevelKeys.length} section(s): ${topLevelKeys.join(', ')}`)
  logger.info(`  source: ${paths.main}`)

  const structuredContent = {
    // `config` is the merged object. A typed InfraKitConfig is assignable to Record<string, unknown>.
    config: config as Record<string, unknown>,
    configPath: paths.main,
    projectName: paths.projectName,
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
      'The fully resolved infra-kit configuration — the same object every command sees at runtime, after the project infra-kit.json, the user-global, and the user-scope per-project override layers are merged (later layers win). Top-level sections include envManagement, ide, worktrees, envAutoLoad, dev, devServersPresets, and devProxy.',
    ),
  configPath: z
    .string()
    .describe('Absolute path to the project-level infra-kit.json (the base layer / committed source of truth).'),
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
    'Return the fully merged infra-kit configuration (project + user-global + per-project override layers) as it is resolved at runtime. Read-only introspection — makes no changes; use `config edit` (CLI-only) to modify the override file. Fails with the loader error when run outside a configured infra-kit repo.',
  inputSchema: {},
  outputSchema: configGetOutputSchema,
  handler: () => {
    return configGet()
  },
})
