import { z } from 'zod'

import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { loadVendorConfig } from 'src/lib/vendor/config'
import { loadFactoryConfig } from 'src/lib/vendor/factory-config'
import { runDiff, selectTargets } from 'src/lib/vendor/sync-ops'
import { defineMcpTool, textContent } from 'src/types'

/** Max itemized changes to print per drifted path before truncating. */
const MAX_REPORTED = 20

interface VendorDiffOptions {
  cwd?: string
  repos?: string[]
}

/**
 * Source-aware drift check: compare each target repo's `vendored:true` subtree
 * against the source via `rsync --dry-run --delete`. Read-only (does NOT extend
 * RequiredConfirmedOptionArg).
 */
export const vendorDiff = async (options: VendorDiffOptions = {}) => {
  const sourceRoot = options.cwd ?? (await getProjectRoot())

  const config = await loadVendorConfig(sourceRoot)
  const factory = await loadFactoryConfig()
  const targets = selectTargets(factory.targets, options.repos)

  const entries = await runDiff(config, sourceRoot, factory.workspaceDir, targets)

  if (entries.length === 0) {
    logger.info('🎉 No drift detected.')
  } else {
    for (const entry of entries) {
      logger.info(`❌ ${entry.repo} → ${entry.target} (${entry.changes.length} change(s)):`)

      for (const change of entry.changes.slice(0, MAX_REPORTED)) {
        logger.info(`   ${change}`)
      }

      if (entry.changes.length > MAX_REPORTED) {
        logger.info(`   …and ${entry.changes.length - MAX_REPORTED} more`)
      }
    }
  }

  const structuredContent = { ok: entries.length === 0, drifted: entries.length, entries }

  return { content: textContent(JSON.stringify(structuredContent, null, 2)), structuredContent }
}

const vendorDiffOutputSchema = {
  ok: z.boolean().describe('Whether every target is in sync with the source'),
  drifted: z.number(),
  entries: z.array(
    z.object({
      repo: z.string(),
      target: z.string(),
      changes: z.array(z.string()),
    }),
  ),
}

// MCP Tool Registration (read-only; safe to expose).
export const vendorDiffMcpTool = defineMcpTool({
  name: 'vendor-diff',
  description:
    'Source-aware drift check: compare each target repo vendored subtree against the source via rsync dry-run. Read-only; run from the source repo root. ok=false when any target has drifted.',
  inputSchema: {
    repos: z.array(z.string()).optional().describe('Restrict to these target repo names'),
  },
  outputSchema: vendorDiffOutputSchema,
  handler: (params) => {
    return vendorDiff({ repos: params.repos })
  },
})
