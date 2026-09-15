import process from 'node:process'
import { z } from 'zod'

import { getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { prefixFor, resolveLaunch } from 'src/mcp/tool-prefix'
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
 * Print the infra-kit CLI version, and — for the MCP caller — where this server process stands.
 *
 * The location fields exist for the doctor skill (plan docs/archive/mcp/mcp-via-plugin-migration-plan.md §4
 * PM-4): a plugin-spawned server runs in `${CLAUDE_PROJECT_DIR}`, so `cwd`, `repoRoot` and
 * `projectDir` are expected equal, and a worktree session must see ITS checkout as `repoRoot`
 * (worktree-local by construction — `git rev-parse --show-toplevel` of `cwd`) while `mainRepoRoot`
 * names the main checkout. `launch` / `toolPrefix` say which route spawned the server, so the skill
 * can tell a shadowed legacy session from a plugin one without guessing from tool names (§3.3).
 *
 * @example
 * await version()
 * // => structuredContent: { version: '0.8.0', cwd: '/repo', repoRoot: '/repo', mainRepoRoot: '/repo',
 * //      projectDir: '/repo', launch: 'plugin', toolPrefix: MCP_TOOL_PREFIX }
 */
export const version = async () => {
  const cliVersion = packageJson.version

  logger.info(cliVersion)

  const launch = resolveLaunch(process.env)
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
    launch,
    toolPrefix: prefixFor(launch),
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
    'Print the installed infra-kit CLI version, where this server process runs (cwd, repo root, main repo root, CLAUDE_PROJECT_DIR) and which route spawned it (plugin or a repo .mcp.json entry) with the tool prefix that route produces',
  inputSchema: {},
  outputSchema: {
    version: z.string().describe('Installed infra-kit CLI version (from package.json)'),
    cwd: z.string().describe('The working directory of this server process'),
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
    projectDir: z.string().nullable().describe('CLAUDE_PROJECT_DIR as Claude Code set it for this server, or null'),
    launch: z
      .enum(['plugin', 'legacy'])
      .describe('Which route spawned this server: the Claude Code plugin, or a repo .mcp.json entry (legacy)'),
    toolPrefix: z.string().describe('The prefix every tool of this server carries in this session'),
  },
  handler: version,
})
