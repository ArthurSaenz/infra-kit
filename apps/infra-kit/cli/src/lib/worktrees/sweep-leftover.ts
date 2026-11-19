import fs from 'node:fs/promises'

export interface LeftoverClassification {
  kind: 'gone' | 'sweepable' | 'not-sweepable'
  entries: string[]
}

/**
 * The only things the post-failure sweep may delete. Measured 2026-09-03: a Claude Code session's
 * oh-my-claudecode SessionEnd hook re-creates `<worktree>/.omc/{state,sessions}` ~2 s after the
 * session exits, racing `git worktree remove`; Finder leaves `.DS_Store`. Anything else (a
 * committable `.omc/skills/**`, user files) makes the leftover NOT sweepable.
 */
const SWEEPABLE_TOP_LEVEL = new Set(['.omc', '.DS_Store'])
const SWEEPABLE_OMC_ENTRIES = new Set(['state', 'sessions'])

/** The measured writer burst is ~2 s; one bounded retry covers a sweep that lands mid-burst. */
const SWEEP_RETRY_DELAY_MS = 2000

const errnoCode = (error: unknown): string | undefined => {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
}

/**
 * Two-level, name-only classification of what git left behind. Any read error other than ENOENT is
 * treated as not sweepable — the CLI never deletes what it could not inspect.
 */
export const classifyLeftover = async (worktreePath: string): Promise<LeftoverClassification> => {
  let entries: string[]

  try {
    entries = await fs.readdir(worktreePath)
  } catch (error) {
    return { kind: errnoCode(error) === 'ENOENT' ? 'gone' : 'not-sweepable', entries: [] }
  }

  const topLevelOk = entries.every((entry) => {
    return SWEEPABLE_TOP_LEVEL.has(entry)
  })

  if (!topLevelOk) return { kind: 'not-sweepable', entries }
  if (!entries.includes('.omc')) return { kind: 'sweepable', entries }

  try {
    const omcEntries = await fs.readdir(`${worktreePath}/.omc`)

    const omcOk = omcEntries.every((entry) => {
      return SWEEPABLE_OMC_ENTRIES.has(entry)
    })

    return { kind: omcOk ? 'sweepable' : 'not-sweepable', entries }
  } catch (error) {
    return { kind: errnoCode(error) === 'ENOENT' ? 'sweepable' : 'not-sweepable', entries }
  }
}

export type DirectoryState =
  | { state: 'absent' }
  | { state: 'sweepable-only'; entries: string[] }
  | { state: 'has-other-entries'; otherEntries: string[] }

/**
 * {@link classifyLeftover} for a caller that must NAME what blocks the sweep: the non-allowlisted
 * entries, with `.omc` children as `.omc/<name>`. An unreadable directory reports no names, never
 * `sweepable-only`.
 */
export const classifyDirectory = async (directory: string): Promise<DirectoryState> => {
  const leftover = await classifyLeftover(directory)

  if (leftover.kind === 'gone') return { state: 'absent' }
  if (leftover.kind === 'sweepable') return { state: 'sweepable-only', entries: leftover.entries }

  const otherEntries = leftover.entries.filter((entry) => {
    return !SWEEPABLE_TOP_LEVEL.has(entry)
  })

  if (leftover.entries.includes('.omc')) {
    const omcEntries = await fs.readdir(`${directory}/.omc`).catch(() => {
      return [] as string[]
    })

    for (const entry of omcEntries) {
      if (!SWEEPABLE_OMC_ENTRIES.has(entry)) otherEntries.push(`.omc/${entry}`)
    }
  }

  return { state: 'has-other-entries', otherEntries }
}

interface SweepArgs {
  worktreePath: string
  sleep: (ms: number) => Promise<void>
}

type RemoveTreeOutcome = 'removed' | 'busy' | 'failed'

/** One recursive removal attempt; `busy` is ENOTEMPTY — a writer got in between readdir and rmdir. */
export const removeTree = async (worktreePath: string): Promise<RemoveTreeOutcome> => {
  try {
    await fs.rm(worktreePath, { recursive: true, force: true })

    return 'removed'
  } catch (error) {
    return errnoCode(error) === 'ENOTEMPTY' ? 'busy' : 'failed'
  }
}

/** Recursive removal with exactly one retry when a concurrent writer makes it ENOTEMPTY again. */
export const sweepLeftover = async (args: SweepArgs): Promise<boolean> => {
  const { worktreePath, sleep } = args

  const first = await removeTree(worktreePath)

  // Only a concurrent writer earns the single retry; anything else is final.
  if (first !== 'busy') return first === 'removed'

  await sleep(SWEEP_RETRY_DELAY_MS)

  return (await removeTree(worktreePath)) === 'removed'
}
