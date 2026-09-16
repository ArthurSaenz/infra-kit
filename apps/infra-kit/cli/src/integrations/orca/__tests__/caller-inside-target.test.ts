import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { orcaCallerInsideTargets } from '../caller-inside-target'

const scratch = mkdtempSync(join(tmpdir(), 'orca-caller-'))
const worktree = join(scratch, 'wt')
const worktreeLink = join(scratch, 'wt-link')
const OTHER = '/home/dev/repo-worktrees/other'

mkdirSync(worktree)
symlinkSync(worktree, worktreeLink)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const withId = (id: string | undefined): NodeJS.ProcessEnv => {
  return id === undefined ? {} : { ORCA_WORKTREE_ID: id }
}

describe('orcaCallerInsideTargets', () => {
  it.each([
    ['env unset', withId(undefined), [worktree], null],
    ['exact match', withId(`repo-1::${worktree}`), [OTHER, worktree], worktree],
    ['realpath match through a symlink', withId(`repo-1::${realpathSync(worktree)}`), [worktreeLink], worktreeLink],
    ['no match', withId(`repo-1::${OTHER}`), [worktree], null],
    ['no :: separator', withId(worktree), [worktree], null],
    ['empty path half', withId('repo-1::'), [worktree], null],
  ])('%s', async (_label, env, paths, expected) => {
    await expect(orcaCallerInsideTargets(paths, env)).resolves.toBe(expected)
  })

  it('keeps a :: inside the path: only the first separator splits the id', async () => {
    const odd = join(scratch, 'wt::nested')

    mkdirSync(odd)

    await expect(orcaCallerInsideTargets([odd], withId(`repo-1::${odd}`))).resolves.toBe(odd)
  })
})
