import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveEnvLoadRoots } from '../env-load'

let temp: string

const git = (cwd: string, ...args: string[]) => {
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })
}

beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-env-roots-')))
})

afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true })
})

describe('resolveEnvLoadRoots', () => {
  it('scopes a load from a worktree to the main checkout, its worktrees container and the worktree', () => {
    const main = path.join(temp, 'hulyo-monorepo')
    const worktree = path.join(temp, 'elsewhere/feature-x')

    fs.mkdirSync(main)
    git(main, 'init', '-q', '-b', 'dev')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(main, 'worktree', 'add', '-q', '-b', 'feature/x', worktree)

    expect(resolveEnvLoadRoots(worktree)).toEqual([main, `${main}-worktrees`, worktree])
  })

  it('scopes a worktree of a bare repo to the bare repo, never to the directory holding it', () => {
    const bare = path.join(temp, 'hulyo.git')
    const seed = path.join(temp, 'seed')
    const worktree = path.join(temp, 'hulyo-wt')

    git(temp, 'init', '-q', '--bare', '-b', 'dev', bare)
    fs.mkdirSync(seed)
    git(seed, 'init', '-q', '-b', 'dev')
    git(seed, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(seed, 'push', '-q', bare, 'dev')
    git(bare, 'worktree', 'add', '-q', worktree, 'dev')

    const roots = resolveEnvLoadRoots(worktree)

    expect(roots).toEqual([bare, `${bare}-worktrees`, worktree])
    expect(roots).not.toContain(temp)
  })

  it('scopes a load outside git to the directory it ran in', () => {
    expect(resolveEnvLoadRoots('', temp)).toEqual([temp])
  })
})
