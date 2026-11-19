import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { $ } from 'zx'

/**
 * The release-rename command's step order (rename the branch, then move its worktree) rests on
 * four git behaviours that only real git can confirm. A git upgrade is the likeliest thing to
 * change any of them, so they are pinned here against real repositories.
 */

interface Fixture {
  root: string
  origin: string
  main: string
  wt: string
}

const BRANCH = 'release/v1.0.0'
const RENAMED = 'release/v1.1.0'

let fixture: Fixture

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await $({ cwd, quiet: true })`git ${args}`

  return result.stdout.trim()
}

const gitOutcome = async (
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stderr: string }> => {
  const result = await $({ cwd, quiet: true, nothrow: true, env: { ...process.env, ...env } })`git ${args}`

  return { exitCode: result.exitCode ?? -1, stderr: result.stderr }
}

const buildFixture = async (): Promise<Fixture> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-rename-'))
  const source = path.join(root, 'source')
  const origin = path.join(root, 'origin.git')
  const main = path.join(root, 'main')
  const wt = path.join(root, 'wt')

  await $({ quiet: true })`git init -q -b main ${source}`
  await git(source, 'config', 'user.email', 'test@example.com')
  await git(source, 'config', 'user.name', 'Test')
  await git(source, 'commit', '-q', '--allow-empty', '-m', 'init')
  await git(source, 'branch', BRANCH)

  await $({ quiet: true })`git clone -q --bare ${source} ${origin}`
  await $({ quiet: true })`git clone -q ${origin} ${main}`
  await git(main, 'config', 'user.email', 'test@example.com')
  await git(main, 'config', 'user.name', 'Test')
  await git(main, 'branch', '--track', BRANCH, `origin/${BRANCH}`)

  await git(main, 'worktree', 'add', wt, BRANCH)
  await fs.writeFile(path.join(wt, 'untracked.txt'), 'keep me\n')

  return { root, origin, main, wt }
}

beforeEach(async () => {
  fixture = await buildFixture()
})

afterEach(async () => {
  await fs.rm(fixture.root, { recursive: true, force: true })
})

describe('git behaviours the release rename depends on', () => {
  it('renames a branch from the main checkout while a linked worktree has it checked out', async () => {
    const { main, wt } = fixture

    const outcome = await gitOutcome(main, ['branch', '-m', BRANCH, RENAMED])

    expect(outcome.exitCode).toBe(0)
    expect(await git(wt, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${RENAMED}`)
  })

  it('moves a worktree together with its untracked files', async () => {
    const { main, wt, root } = fixture
    const moved = path.join(root, 'wt2')

    const outcome = await gitOutcome(main, ['worktree', 'move', wt, moved])

    expect(outcome.exitCode).toBe(0)
    expect(await fs.readFile(path.join(moved, 'untracked.txt'), 'utf8')).toBe('keep me\n')
    await expect(fs.stat(wt)).rejects.toThrow()

    const listing = await git(main, 'worktree', 'list', '--porcelain')
    const realMoved = await fs.realpath(moved)

    expect(listing.split('\n')).toContain(`worktree ${realMoved}`)
  })

  it('refuses to rename a branch whose worktree is mid-rebase', async () => {
    const { main, wt } = fixture
    const editorEnv = { GIT_SEQUENCE_EDITOR: ':', GIT_EDITOR: ':' }

    await git(wt, 'commit', '-q', '--allow-empty', '-m', 'extra')

    const rebase = await gitOutcome(wt, ['rebase', '--exec', 'false', 'HEAD~1'], editorEnv)

    expect(rebase.exitCode).not.toBe(0)

    const outcome = await gitOutcome(main, ['branch', '-m', BRANCH, RENAMED])

    await gitOutcome(wt, ['rebase', '--abort'], editorEnv)

    expect(outcome.exitCode).toBe(128)
    expect(outcome.stderr).toContain('is being rebased')
  })

  it('refuses to move a worktree that contains a submodule', async () => {
    const { main, wt, root, origin } = fixture
    const moved = path.join(root, 'wt2')

    await git(wt, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, 'sub')

    const outcome = await gitOutcome(main, ['worktree', 'move', wt, moved])

    expect(outcome.exitCode).toBe(128)
    expect(outcome.stderr).toContain('working trees containing submodules cannot be moved or removed')
  })
})
