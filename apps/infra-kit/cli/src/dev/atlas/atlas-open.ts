import { execFile } from 'node:child_process'
import process from 'node:process'

import { focusOrcaTerminal, openOrcaLogTerminal } from 'src/integrations/orca'

/** `unavailable` tells the page to fall back to its own editor link. */
export type AtlasOpenResult = 'opened' | 'unknown' | 'unavailable'

export type AtlasOpenTarget = { kind: 'folder'; path: string } | { kind: 'log'; service: string; path: string }

export interface AtlasOpenDeps {
  platform: NodeJS.Platform
  /** `ORCA_WORKTREE_ID` of the runner's terminal; absent outside Orca. */
  orcaWorktreeId: string | undefined
  revealFolder: (path: string) => Promise<void>
  openLogTerminal: typeof openOrcaLogTerminal
  focusTerminal: typeof focusOrcaTerminal
}

const revealInFinder = (path: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [path], (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export const defaultAtlasOpenDeps = (): AtlasOpenDeps => {
  return {
    platform: process.platform,
    orcaWorktreeId: process.env.ORCA_WORKTREE_ID,
    revealFolder: revealInFinder,
    openLogTerminal: openOrcaLogTerminal,
    focusTerminal: focusOrcaTerminal,
  }
}

/**
 * Opens a window for the viewer: the run folder in Finder, a log as an Orca terminal tab that follows it.
 * Every failure reads `unavailable`, so a click never ends in nothing — the page opens its editor link.
 */
export const createAtlasOpener = (deps: AtlasOpenDeps = defaultAtlasOpenDeps()) => {
  /** Per log: the tab this run opened for it, so a second click returns to it instead of adding one. */
  const tabs = new Map<string, string>()

  const openLog = async (service: string, path: string, worktreeId: string): Promise<void> => {
    const known = tabs.get(service)

    if (known !== undefined && (await deps.focusTerminal(known))) return

    tabs.set(service, await deps.openLogTerminal({ worktreeId, title: `log: ${service}`, logPath: path }))
  }

  return async (target: AtlasOpenTarget): Promise<AtlasOpenResult> => {
    try {
      if (target.kind === 'folder') {
        if (deps.platform !== 'darwin') return 'unavailable'
        await deps.revealFolder(target.path)

        return 'opened'
      }

      if (deps.orcaWorktreeId === undefined) return 'unavailable'
      await openLog(target.service, target.path, deps.orcaWorktreeId)

      return 'opened'
    } catch {
      return 'unavailable'
    }
  }
}
