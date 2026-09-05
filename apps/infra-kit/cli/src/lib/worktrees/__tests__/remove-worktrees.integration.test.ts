import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $ } from 'zx'

import { removeWorktrees } from '../remove-worktrees'

/**
 * Deliberately NOT mocking zx, git-utils or the filesystem: the sweep only fires on a path REAL git
 * has already unregistered, and a mocked `git worktree list` would only prove the parser can read a
 * string I typed.
 *
 * The state under test reproduces what a post-exit hook leaves behind: `git worktree remove` ran to
 * completion (path unregistered), then something re-created `<path>/.omc/state/…` — exactly the
 * measured oh-my-claudecode SessionEnd race. Re-running the removal must sweep that leftover rather
 * than report "not a working tree" as a failure.
 */

vi.mock('src/integrations/cmux', () => {
  return { closeCmuxWorkspaceByCwd: vi.fn(async () => {}) }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const BRANCH = 'release/x'

let tmp: string
let repo: string
let worktreeDir: string
let originalCwd: string

const git = (cwd: string) => {
  return $({ cwd, quiet: true })
}

const worktreeListedPaths = async (): Promise<string[]> => {
  const output = await git(repo)`git worktree list --porcelain`

  return output.stdout
    .split('\n')
    .filter((line) => {
      return line.startsWith('worktree ')
    })
    .map((line) => {
      return line.slice('worktree '.length)
    })
}

const noSleep = async (): Promise<void> => {}

beforeEach(async () => {
  originalCwd = process.cwd()

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remove-worktrees-')))
  repo = path.join(tmp, 'repo')
  worktreeDir = path.join(tmp, 'repo-worktrees')

  fs.mkdirSync(repo)

  await git(repo)`git init --quiet`
  await git(repo)`git -c user.email=t@t -c user.name=t commit --allow-empty -m init --quiet`
  await git(repo)`git worktree add -q -b ${BRANCH} ${path.join(worktreeDir, BRANCH)}`

  // zx snapshots process.cwd() at import; `git worktree remove` inside removeWorktrees must run in
  // the throwaway repo, not in the real infra-kit checkout.
  process.chdir(repo)
  $.cwd = repo
})

afterEach(() => {
  process.chdir(originalCwd)
  $.cwd = undefined

  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('removeWorktrees against real git', () => {
  it('sweeps a .omc leftover on a path git has already unregistered', async () => {
    const worktreePath = path.join(worktreeDir, BRANCH)

    await git(repo)`git worktree remove ${worktreePath}`
    expect(fs.existsSync(worktreePath)).toBe(false)

    // The post-exit hook's write, after git finished.
    fs.mkdirSync(path.join(worktreePath, '.omc', 'state'), { recursive: true })
    fs.writeFileSync(path.join(worktreePath, '.omc', 'state', 'x.json'), '{}')

    const result = await removeWorktrees({ branches: [BRANCH], worktreeDir, projectRoot: repo, sleep: noSleep })

    expect(result).toEqual({ removed: [BRANCH], failed: [] })
    expect(fs.existsSync(worktreePath)).toBe(false)
    expect(await worktreeListedPaths()).toEqual([repo])
  })

  it('reports a dirty, still-registered worktree as failed even when addressed through a symlink', async () => {
    const link = path.join(tmp, 'link')

    fs.symlinkSync(tmp, link)

    const linkedWorktreeDir = path.join(link, 'repo-worktrees')
    const worktreePath = path.join(worktreeDir, BRANCH)

    fs.writeFileSync(path.join(worktreePath, 'untracked.txt'), 'keep me')

    const result = await removeWorktrees({
      branches: [BRANCH],
      worktreeDir: linkedWorktreeDir,
      projectRoot: repo,
      sleep: noSleep,
    })

    expect(result.removed).toEqual([])
    expect(result.failed[0]?.branch).toBe(BRANCH)
    // The dirty-tree remediation, NOT the "already unregistered" one: registration was recognised
    // through the symlink, so nothing was classified as a leftover.
    expect(result.failed[0]?.reason).toMatch(/uncommitted changes block removal/)
    expect(fs.existsSync(path.join(worktreePath, 'untracked.txt'))).toBe(true)
    expect(await worktreeListedPaths()).toEqual([repo, worktreePath])
  })

  it('removes a clean worktree normally (no sweep involved)', async () => {
    const worktreePath = path.join(worktreeDir, BRANCH)

    const result = await removeWorktrees({ branches: [BRANCH], worktreeDir, projectRoot: repo, sleep: noSleep })

    expect(result).toEqual({ removed: [BRANCH], failed: [] })
    expect(fs.existsSync(worktreePath)).toBe(false)
    expect(await worktreeListedPaths()).toEqual([repo])
  })
})
