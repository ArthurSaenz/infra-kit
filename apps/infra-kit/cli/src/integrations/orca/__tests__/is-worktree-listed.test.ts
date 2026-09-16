import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { isOrcaWorktreeListed } from '../is-worktree-listed'
import { ok, orcaCli } from './orca-cli-mock'

vi.mock('zx', async () => {
  return (await import('./orca-cli-mock')).zxModule
})

const scratch = mkdtempSync(join(tmpdir(), 'orca-listed-'))
const worktree = join(scratch, 'wt')
const worktreeLink = join(scratch, 'wt-link')
const MAIN = '/home/dev/repo'

mkdirSync(worktree)
symlinkSync(worktree, worktreeLink)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('isOrcaWorktreeListed', () => {
  beforeEach(() => {
    orcaCli.reset()
  })

  it('lists the repo by path with --limit 500 and matches by realpath', async () => {
    orcaCli.respond = () => {
      return ok({ worktrees: [{ path: MAIN }, { path: realpathSync(worktree) }] })
    }

    await expect(isOrcaWorktreeListed(MAIN, worktreeLink)).resolves.toBe(true)
    expect(orcaCli.calls).toEqual([['worktree', 'list', '--repo', `path:${MAIN}`, '--limit', '500']])
  })

  it('is false when the sidebar omits the worktree', async () => {
    orcaCli.respond = () => {
      return ok({ worktrees: [{ path: MAIN }] })
    }

    await expect(isOrcaWorktreeListed(MAIN, worktree)).resolves.toBe(false)
  })
})
