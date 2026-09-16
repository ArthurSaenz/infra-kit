import { beforeEach, describe, expect, it, vi } from 'vitest'

import { closeOrcaWorktreeTerminals } from '../close-worktree-terminals'
import { OrcaError } from '../run-orca'
import { absent, fail, ok, orcaCli, routes } from './orca-cli-mock'

vi.mock('zx', async () => {
  return (await import('./orca-cli-mock')).zxModule
})

const WORKTREE_CWD = '/home/dev/repo-worktrees/release/v1.0.0'
const LIST_ARGV = ['terminal', 'list', '--worktree', `path:${WORKTREE_CWD}`, '--limit', '200']
const RETIRE_ARGV = ['terminal', 'close', '--worktree', `path:${WORKTREE_CWD}`, '--all']

const terminal = (handle: string) => {
  return { handle, title: 'zsh', tabId: 'tab-1', connected: true, orphaned: false }
}

describe('closeOrcaWorktreeTerminals', () => {
  beforeEach(() => {
    orcaCli.reset()
  })

  it('closes each handle, then retires the surfaces with --all', async () => {
    orcaCli.respond = routes({
      'terminal list': ok({ terminals: [terminal('h0'), terminal('h1')], truncated: false }),
      'terminal close --terminal': ok({ close: { ptyKilled: true } }),
      'terminal close --worktree': ok({ closed: 0, stopped: 0, retiredSurfaces: true }),
    })

    await expect(closeOrcaWorktreeTerminals(WORKTREE_CWD, 'ready')).resolves.toEqual({ closed: true, count: 2 })
    expect(orcaCli.calls).toEqual([
      LIST_ARGV,
      ['terminal', 'close', '--terminal', 'h0'],
      ['terminal', 'close', '--terminal', 'h1'],
      RETIRE_ARGV,
    ])
  })

  it("ignores --all's terminal_close_incomplete", async () => {
    orcaCli.respond = routes({
      'terminal list': ok({ terminals: [terminal('h0')] }),
      'terminal close --worktree': fail('terminal_close_incomplete', 'a terminal is still running'),
    })

    await expect(closeOrcaWorktreeTerminals(WORKTREE_CWD, 'ready')).resolves.toEqual({ closed: true, count: 1 })
  })

  it('reports not_found when neither the list nor the retire resolve the selector', async () => {
    orcaCli.respond = () => {
      return fail('selector_not_found')
    }

    await expect(closeOrcaWorktreeTerminals(WORKTREE_CWD, 'ready')).resolves.toEqual({
      closed: false,
      skipped: 'not_found',
    })
  })

  it.each(['absent', 'unreachable'] as const)('probe %s → skipped without spawning', async (probe) => {
    await expect(closeOrcaWorktreeTerminals(WORKTREE_CWD, probe)).resolves.toEqual({ closed: false, skipped: probe })
    expect(orcaCli.calls).toEqual([])
  })

  it('returns { closed: false, error } for an OrcaError from a per-handle close and never throws', async () => {
    orcaCli.respond = routes({
      'terminal list': ok({ terminals: [terminal('h0')] }),
      'terminal close --terminal': fail('runtime_error', 'pty is stuck'),
    })

    const outcome = await closeOrcaWorktreeTerminals(WORKTREE_CWD, 'ready')

    expect(outcome).toMatchObject({ closed: false, error: expect.any(OrcaError) })
    expect(outcome).toMatchObject({ error: { code: 'runtime_error' } })
    expect(orcaCli.calls).not.toContainEqual(RETIRE_ARGV)
  })

  it('reads Orca vanishing mid-close as skipped: absent', async () => {
    orcaCli.respond = routes({
      'terminal list': ok({ terminals: [terminal('h0')] }),
      'terminal close --terminal': absent(),
    })

    await expect(closeOrcaWorktreeTerminals(WORKTREE_CWD, 'ready')).resolves.toEqual({
      closed: false,
      skipped: 'absent',
    })
  })

  it('wraps a malformed reply into an OrcaError outcome', async () => {
    orcaCli.respond = routes({ 'terminal list': { exitCode: 1, stdout: 'crash', stderr: 'stack' } })

    await expect(closeOrcaWorktreeTerminals(WORKTREE_CWD, 'ready')).resolves.toMatchObject({
      closed: false,
      error: { code: 'orca_malformed_output', data: { exitCode: 1, stderrTail: 'stack' } },
    })
  })
})
