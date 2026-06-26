import path from 'node:path'
import { z } from 'zod'

import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { loadFactoryConfig } from 'src/lib/vendor/factory-config'
import { getSourceCommit, runManifest, selectTargets } from 'src/lib/vendor/sync-ops'
import { defineMcpTool, textContent } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

interface VendorManifestOptions extends RequiredConfirmedOptionArg {
  cwd?: string
  repos?: string[]
}

/**
 * Regenerate each target repo's `vendor/.sync-manifest.json` + README from the
 * CURRENT vendor content, without copying anything. Mutating (writes manifests).
 */
export const vendorManifest = async (options: VendorManifestOptions) => {
  const sourceRoot = options.cwd ?? (await getProjectRoot())

  const factory = await loadFactoryConfig()
  const targets = selectTargets(factory.targets, options.repos)

  const commit = await getSourceCommit(sourceRoot)
  const source = path.basename(sourceRoot)

  const repos = await runManifest(factory.workspaceDir, targets, { source, commit })

  for (const repo of repos) {
    logger.info(
      repo.skipped ? `⚠️  ${repo.repo}: target does not exist — skipped` : `📝 ${repo.repo}: manifest written`,
    )
  }

  const structuredContent = { source, commit, repos }

  return { content: textContent(JSON.stringify(structuredContent, null, 2)), structuredContent }
}

const vendorManifestOutputSchema = {
  source: z.string(),
  commit: z.string(),
  repos: z.array(z.object({ repo: z.string(), skipped: z.boolean() })),
}

// MCP Tool Registration (mutating).
export const vendorManifestMcpTool = defineMcpTool({
  name: 'vendor-manifest',
  description:
    'Regenerate each target repo vendor/.sync-manifest.json + README from current content without copying. Mutating; run from the source repo root.',
  inputSchema: {
    repos: z.array(z.string()).optional().describe('Restrict to these target repo names'),
  },
  outputSchema: vendorManifestOutputSchema,
  handler: (params) => {
    return vendorManifest({ repos: params.repos, confirmedCommand: params.confirmedCommand })
  },
})
