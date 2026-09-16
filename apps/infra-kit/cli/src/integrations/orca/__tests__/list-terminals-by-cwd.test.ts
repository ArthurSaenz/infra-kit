import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listOrcaTerminals } from '../list-terminals-by-cwd'
import { OrcaError } from '../run-orca'
import { fail, ok, orcaCli } from './orca-cli-mock'

vi.mock('zx', async () => {
  return (await import('./orca-cli-mock')).zxModule
})

const WORKTREE_CWD = '/home/dev/repo-worktrees/release/v1.0.0'
const TERMINAL = { handle: 'h1', title: '1.0.0', tabId: 't1', connected: true, orphaned: false }

describe('listOrcaTerminals', () => {
  beforeEach(() => {
    orcaCli.reset()
  })

  it('selects by the literal path with --limit 200 and returns terminals + truncated', async () => {
    orcaCli.respond = () => {
      return ok({ terminals: [TERMINAL], totalCount: 1, truncated: false })
    }

    await expect(listOrcaTerminals(WORKTREE_CWD)).resolves.toEqual({ terminals: [TERMINAL], truncated: false })
    expect(orcaCli.calls).toEqual([['terminal', 'list', '--worktree', `path:${WORKTREE_CWD}`, '--limit', '200']])
  })

  it('reads selector_not_found as nothing open', async () => {
    orcaCli.respond = () => {
      return fail('selector_not_found')
    }

    await expect(listOrcaTerminals(WORKTREE_CWD)).resolves.toEqual({ terminals: [], truncated: false })
  })

  it('propagates any other OrcaError', async () => {
    orcaCli.respond = () => {
      return fail('runtime_error')
    }

    await expect(listOrcaTerminals(WORKTREE_CWD)).rejects.toBeInstanceOf(OrcaError)
  })
})
