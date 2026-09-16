import process from 'node:process'
import { z } from 'zod'

import { getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { defineMcpTool, textContent } from 'src/types'

import packageJson from '../../../package.json' with { type: 'json' }

/**
 * A git root, or `null` when git cannot answer — `version` never throws.
 *
 * The one tool a session calls to learn where it stands must not fail on the machines it is most
 * needed on (a scratch directory, a broken checkout): a `null` is the answer, a throw is a
 * tool-call error the model cannot read a location out of.
 */
const rootOrNull = async (resolve: () => Promise<string>): Promise<string | null> => {
  try {
    return await resolve()
  } catch {
    return null
  }
}

/**
 * Print the infra-kit CLI version, and — for a `--json` caller — where this process stands.
 *
 * The location fields exist for the doctor skill (plan docs/archive/mcp/mcp-via-plugin-migration-plan.md §4
 * PM-4), which runs this over Bash from `${CLAUDE_PROJECT_DIR}`: `cwd`, `repoRoot` and `projectDir`
 * are expected equal, and a worktree session must see ITS checkout as `repoRoot` (worktree-local by
 * construction — `git rev-parse --show-toplevel` of `cwd`) while `mainRepoRoot` names the main
 * checkout.
 *
 * @example
 * await version()
 * // => structuredContent: { version: '0.8.0', cwd: '/repo', repoRoot: '/repo', mainRepoRoot: '/repo',
 * //      projectDir: '/repo' }
 */
export const version = async () => {
  const cliVersion = packageJson.version

  logger.info(cliVersion)

  const repoRoot = await rootOrNull(getProjectRoot)
  // Keyed off the resolved root so a `null` there is a `null` here too, not a second git failure.
  const mainRepoRoot =
    repoRoot === null
      ? null
      : await rootOrNull(() => {
          return getMainRepoRoot(repoRoot)
        })

  const structuredContent = {
    version: cliVersion,
    cwd: process.cwd(),
    repoRoot,
    mainRepoRoot,
    projectDir: process.env.CLAUDE_PROJECT_DIR || null,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

// MCP Tool Registration
export const versionMcpTool = defineMcpTool({
  name: 'version',
  description:
    'Print the installed infra-kit CLI version and where this process runs (cwd, repo root, main repo root, CLAUDE_PROJECT_DIR)',
  inputSchema: {},
  outputSchema: {
    version: z.string().describe('Installed infra-kit CLI version (from package.json)'),
    cwd: z.string().describe('The working directory of this process'),
    repoRoot: z
      .string()
      .nullable()
      .describe('git toplevel of cwd — the worktree itself in a linked worktree; null when git cannot answer'),
    mainRepoRoot: z
      .string()
      .nullable()
      .describe(
        'The main checkout a linked worktree belongs to (equals repoRoot outside worktrees); null with repoRoot',
      ),
    projectDir: z.string().nullable().describe('CLAUDE_PROJECT_DIR as Claude Code set it for this process, or null'),
  },
  handler: version,
})
