import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createOrcaOpenPoll, openOrcaWorktreeTerminals } from '../open-worktree-terminals'
import { OrcaError } from '../run-orca'
import { fail, ok, orcaCli, routes } from './orca-cli-mock'

vi.mock('zx', async () => {
  return (await import('./orca-cli-mock')).zxModule
})

const WORKTREE_CWD = '/home/dev/repo-worktrees/release/v1.0.0'
const CREATE_ARGV = ['terminal', 'create', '--worktree', `path:${WORKTREE_CWD}`, '--title', '1.0.0']

const created = (handle: string) => {
  return ok({ terminal: { handle, tabId: 'tab-1', surface: 'visible' } })
}

let splitCounter = 0

const layoutRoutes = () => {
  return routes({
    'terminal create': created('h0'),
    'terminal split': () => {
      splitCounter += 1

      return ok({ split: { handle: `h${splitCounter}`, tabId: 'tab-1' } })
    },
  })
}

const open = (overrides: Partial<Parameters<typeof openOrcaWorktreeTerminals>[0]> = {}) => {
  return openOrcaWorktreeTerminals({
    cwd: WORKTREE_CWD,
    title: '1.0.0',
    focus: true,
    layout: 'full',
    panes: 'two-columns',
    ...overrides,
  })
}

describe('openOrcaWorktreeTerminals', () => {
  beforeEach(() => {
    orcaCli.reset()
    splitCounter = 0
  })

  it('two-columns: create with --focus, then one horizontal split on h0', async () => {
    orcaCli.respond = layoutRoutes()

    await expect(open()).resolves.toEqual({ handles: ['h0', 'h1'], layout: 'full' })
    expect(orcaCli.calls).toEqual([
      [...CREATE_ARGV, '--focus'],
      ['terminal', 'split', '--terminal', 'h0', '--direction', 'horizontal'],
    ])
  })

  it('three-pane: horizontal then vertical, both anchored on h0', async () => {
    orcaCli.respond = layoutRoutes()

    await expect(open({ panes: 'three-pane' })).resolves.toEqual({ handles: ['h0', 'h1', 'h2'], layout: 'full' })
    expect(orcaCli.calls.slice(1)).toEqual([
      ['terminal', 'split', '--terminal', 'h0', '--direction', 'horizontal'],
      ['terminal', 'split', '--terminal', 'h0', '--direction', 'vertical'],
    ])
  })

  it('single-pane: only the create, no splits', async () => {
    orcaCli.respond = layoutRoutes()

    await expect(open({ layout: 'single-pane', focus: false })).resolves.toEqual({
      handles: ['h0'],
      layout: 'single-pane',
    })
    expect(orcaCli.calls).toEqual([CREATE_ARGV])
  })

  it('never passes --focus when focus is false', async () => {
    orcaCli.respond = layoutRoutes()

    await open({ focus: false, panes: 'three-pane' })

    expect(orcaCli.calls.flat()).not.toContain('--focus')
  })

  describe('fresh-worktree poll', () => {
    const notSelectableThenCreated = (refusals: number) => {
      let creates = 0

      return routes({
        'terminal create': () => {
          creates += 1

          return creates <= refusals ? fail('selector_not_found') : created('h0')
        },
        'terminal split': ok({ split: { handle: 'h1' } }),
      })
    }

    it('resolves on the second try', async () => {
      orcaCli.respond = notSelectableThenCreated(1)

      await expect(open({ poll: createOrcaOpenPoll({ delayMs: 0 }) })).resolves.toEqual({
        handles: ['h0', 'h1'],
        layout: 'full',
      })
      expect(
        orcaCli.calls.filter(([, verb]) => {
          return verb === 'create'
        }),
      ).toHaveLength(2)
    })

    it('exhausts to orca_worktree_not_selectable after the budget', async () => {
      orcaCli.respond = notSelectableThenCreated(Number.POSITIVE_INFINITY)

      const error = await open({ poll: createOrcaOpenPoll({ attempts: 3, delayMs: 0 }) }).catch((thrown: unknown) => {
        return thrown
      })

      expect(error).toBeInstanceOf(OrcaError)
      expect(error).toMatchObject({ code: 'orca_worktree_not_selectable', data: { cwd: WORKTREE_CWD, attempts: 3 } })
      expect(orcaCli.calls).toHaveLength(3)
    })

    it('circuit-breaks: after one exhaustion the next target of the same batch attempts once', async () => {
      orcaCli.respond = notSelectableThenCreated(Number.POSITIVE_INFINITY)
      const poll = createOrcaOpenPoll({ attempts: 3, delayMs: 0 })

      await expect(open({ poll })).rejects.toMatchObject({ code: 'orca_worktree_not_selectable' })
      expect(poll.exhausted).toBe(true)

      orcaCli.calls = []

      await expect(open({ poll, cwd: '/home/dev/repo-worktrees/other' })).rejects.toMatchObject({
        code: 'orca_worktree_not_selectable',
      })
      expect(orcaCli.calls).toHaveLength(1)
    })

    it('does not retry a non-selector error from create', async () => {
      orcaCli.respond = routes({ 'terminal create': fail('runtime_error', 'Timed out waiting for terminal handle') })

      await expect(open({ poll: createOrcaOpenPoll({ delayMs: 0 }) })).rejects.toMatchObject({ code: 'runtime_error' })
      expect(orcaCli.calls).toHaveLength(1)
    })
  })
})
