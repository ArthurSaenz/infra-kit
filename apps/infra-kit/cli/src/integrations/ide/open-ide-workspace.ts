import { openCursorWorkspace } from 'src/integrations/cursor'
import { openZedWorkspace } from 'src/integrations/zed'
import { assertNever } from 'src/lib/assert-never'
import { getInfraKitConfig, resolveConfiguredIdes } from 'src/lib/infra-kit-config'

import type { OpenIdeWorkspaceOutcome } from './types'

interface OpenIdeWorkspaceArgs {
  projectRoot: string
  worktreeDir: string
  currentBranches: string[]
}

/**
 * Provider-agnostic entry point for the reload open: for every configured
 * editor, reconciles (or, for Zed, simply assembles) the workspace against the
 * release worktrees on disk and launches it — skipping the launch when there are
 * no worktrees, so `worktrees-reload` never pops a bare editor window. Returns
 * one outcome per configured provider (empty array when no IDE is configured).
 * Iterates sequentially — `worktrees-reload` already wraps this call in an outer
 * `Promise.all` with cmux, so a `Promise.all` here would compound editor-spawn
 * concurrency. Best-effort — every provider swallows failures into a warning.
 */
export const openIdeWorkspace = async (args: OpenIdeWorkspaceArgs): Promise<OpenIdeWorkspaceOutcome[]> => {
  const config = await getInfraKitConfig()
  const ides = resolveConfiguredIdes(config)

  const outcomes: OpenIdeWorkspaceOutcome[] = []

  for (const ide of ides) {
    switch (ide.provider) {
      case 'cursor': {
        const outcome = await openCursorWorkspace({ ...args, cursorConfig: ide.config })

        outcomes.push({ ...outcome, provider: 'cursor' })
        break
      }
      case 'zed': {
        const outcome = await openZedWorkspace(args)

        outcomes.push({ ...outcome, provider: 'zed' })
        break
      }
      default: {
        assertNever(ide)
      }
    }
  }

  return outcomes
}
