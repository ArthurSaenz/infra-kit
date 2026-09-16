import { setTimeout as sleep } from 'node:timers/promises'

import { OrcaError, runOrca } from './run-orca'

export type OrcaPanes = 'two-columns' | 'three-pane'
export type OrcaOpenedLayout = 'full' | 'single-pane'

/**
 * Shared per batch (one `worktrees add --all`, one `reopen`): a fresh worktree
 * that `git worktree add` created milliseconds ago may not be selectable yet, so
 * `terminal create` is retried on `selector_not_found`. The cause of an
 * exhaustion (Orca not scanning the repo) is per-repo, so after the first one the
 * remaining targets attempt once — worst case `1 × budget + (N−1) × 0`.
 */
export interface OrcaOpenPoll {
  attempts: number
  delayMs: number
  exhausted: boolean
}

const DEFAULT_POLL_ATTEMPTS = 3
const DEFAULT_POLL_DELAY_MS = 300

export const createOrcaOpenPoll = (
  overrides: Partial<Pick<OrcaOpenPoll, 'attempts' | 'delayMs'>> = {},
): OrcaOpenPoll => {
  return {
    attempts: overrides.attempts ?? DEFAULT_POLL_ATTEMPTS,
    delayMs: overrides.delayMs ?? DEFAULT_POLL_DELAY_MS,
    exhausted: false,
  }
}

interface OpenOrcaWorktreeTerminalsArgs {
  cwd: string
  title: string
  /**
   * `--focus` steals the window; callers pass `false` on every fan-out and from
   * `reopen`. It must also stay `false` on a row the sidebar hides — there
   * `--focus` times out after ~10 s (docs/orca-cli-findings.md, axis 1).
   */
  focus: boolean
  layout: OrcaOpenedLayout
  /** The configured pane preset; only consulted when `layout` is `full`. */
  panes: OrcaPanes
  poll?: OrcaOpenPoll
}

export interface OrcaTerminalCreateResult {
  terminal: { handle: string }
}

export interface OrcaTerminalSplitResult {
  split: { handle: string }
}

type CreateOutcome = { created: OrcaTerminalCreateResult } | { notSelectable: OrcaError }

const tryCreate = async (argv: string[]): Promise<CreateOutcome> => {
  try {
    return { created: await runOrca<OrcaTerminalCreateResult>(argv) }
  } catch (error) {
    if (error instanceof OrcaError && error.code === 'selector_not_found') {
      return { notSelectable: error }
    }

    throw error
  }
}

const createWithPoll = async (argv: string[], cwd: string, poll: OrcaOpenPoll): Promise<string> => {
  const attempts = poll.exhausted ? 1 : poll.attempts
  const schedule = Array.from({ length: attempts }, (_, index) => {
    return index + 1
  })

  let lastRefusal: OrcaError | undefined

  for (const attempt of schedule) {
    const outcome = await tryCreate(argv)

    if ('created' in outcome) {
      return outcome.created.terminal.handle
    }

    lastRefusal = outcome.notSelectable

    if (attempt < attempts) {
      await sleep(poll.delayMs)
    }
  }

  poll.exhausted = true

  throw new OrcaError({
    code: 'orca_worktree_not_selectable',
    message: `orca: worktree ${cwd} is not selectable after ${attempts} attempt(s): ${lastRefusal?.message ?? ''}`,
    data: { cwd, attempts, cause: lastRefusal?.data },
  })
}

const split = async (handle: string, direction: 'horizontal' | 'vertical'): Promise<string> => {
  const result = await runOrca<OrcaTerminalSplitResult>([
    'terminal',
    'split',
    '--terminal',
    handle,
    '--direction',
    direction,
  ])

  return result.split.handle
}

/**
 * Opens terminals for the worktree at `cwd` in one Orca tab and returns their
 * handles (`handles[0]` is the tab's first pane). `full` lays out the preset:
 * `horizontal` on `h0` puts a pane to the RIGHT, and `three-pane` adds a
 * `vertical` split on the same `h0` for the pane BELOW it (measured tree:
 * `horizontal(vertical(h0, h2), h1)`).
 *
 * A background (non-`--focus`) handle is splittable in the same tab, so no
 * layout depends on focus.
 */
export const openOrcaWorktreeTerminals = async (
  args: OpenOrcaWorktreeTerminalsArgs,
): Promise<{ handles: string[]; layout: OrcaOpenedLayout }> => {
  const { cwd, title, focus, layout, panes, poll = createOrcaOpenPoll() } = args

  const createArgv = [
    'terminal',
    'create',
    '--worktree',
    `path:${cwd}`,
    '--title',
    title,
    ...(focus ? ['--focus'] : []),
  ]

  const first = await createWithPoll(createArgv, cwd, poll)
  const handles = [first]

  if (layout === 'full') {
    handles.push(await split(first, 'horizontal'))

    if (panes === 'three-pane') {
      handles.push(await split(first, 'vertical'))
    }
  }

  return { handles, layout }
}
