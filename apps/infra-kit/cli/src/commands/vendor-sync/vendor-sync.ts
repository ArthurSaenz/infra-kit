import confirm from '@inquirer/confirm'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { loadVendorConfig } from 'src/lib/vendor/config'
import { loadFactoryConfig } from 'src/lib/vendor/factory-config'
import { getSourceCommit, runSync, selectTargets } from 'src/lib/vendor/sync-ops'
import { defineMcpTool, textContent } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

interface VendorSyncOptions extends RequiredConfirmedOptionArg {
  /** Source repo root. Defaults to the git toplevel. */
  cwd?: string
  /** Restrict the sync to these target repo names (defaults to all configured targets). */
  repos?: string[]
}

/**
 * Copy every item declared in the source repo's `vendor.config.ts` into each
 * target repo, then (re)write each target's `vendor/README.md` +
 * `.sync-manifest.json`. Mutating: extends {@link RequiredConfirmedOptionArg} and
 * prompts for confirmation unless `confirmedCommand` is set (MCP injects it).
 *
 * The config loader and `zx`/rsync live in `config`/`sync-ops`. `vendor check`
 * stays free of them because it never imports the write commands — not because
 * of how they are imported here.
 */
export const vendorSync = async (options: VendorSyncOptions) => {
  const sourceRoot = options.cwd ?? (await getProjectRoot())

  const config = await loadVendorConfig(sourceRoot)
  const factory = await loadFactoryConfig()
  const targets = selectTargets(factory.targets, options.repos)

  if (!options.confirmedCommand) {
    const proceed = await confirm(
      { message: `Sync vendor files from ${path.basename(sourceRoot)} into ${targets.length} repo(s)?` },
      { output: process.stderr },
    )

    if (!proceed) {
      process.exit(0)
    }
  }

  const commit = await getSourceCommit(sourceRoot)
  const source = path.basename(sourceRoot)

  const structuredContent = await runSync(config, sourceRoot, factory.workspaceDir, targets, { source, commit })

  for (const repo of structuredContent.repos) {
    if (repo.skipped) {
      logger.info(`⚠️  ${repo.repo}: target does not exist — skipped`)
    } else {
      logger.info(`✅ ${repo.repo}: copied ${repo.copied}/${repo.total} items + manifest`)
    }
  }

  return { content: textContent(JSON.stringify(structuredContent, null, 2)), structuredContent }
}

const vendorSyncOutputSchema = {
  source: z.string(),
  commit: z.string(),
  repos: z.array(
    z.object({
      repo: z.string(),
      copied: z.number(),
      total: z.number(),
      skipped: z.boolean(),
    }),
  ),
}

// MCP Tool Registration (mutating — createToolHandler injects confirmedCommand:true).
export const vendorSyncMcpTool = defineMcpTool({
  name: 'vendor-sync',
  description:
    'Copy vendored files from the source repo (vendor.config.ts) into each target repo and regenerate their vendor/.sync-manifest.json + README. Mutating; run from the source repo root.',
  inputSchema: {
    repos: z.array(z.string()).optional().describe('Restrict to these target repo names'),
  },
  outputSchema: vendorSyncOutputSchema,
  handler: (params) => {
    return vendorSync({ repos: params.repos, confirmedCommand: params.confirmedCommand })
  },
})
