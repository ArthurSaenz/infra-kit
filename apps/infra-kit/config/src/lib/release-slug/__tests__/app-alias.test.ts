import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readAppAliasHost, readAppAliasName } from '../app-alias'
import { DEFAULT_REPO_SLUG, readRepoIdentity, readRepoSlug } from '../repo-slug'

let temp: string

const git = (cwd: string, ...args: string[]) => {
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })
}

/** A repo at `<temp>/<name>` on `branch`, with an app package at `apps/website/ui`; returns the app dir. */
const seedRepo = (name: string, branch: string, packageName = 'website-ui'): string => {
  const root = path.join(temp, name)
  const appDir = path.join(root, 'apps/website/ui')

  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: packageName }))
  git(root, 'init', '-q', '-b', branch)
  git(root, 'add', '-A')
  // Committed so `rev-parse --abbrev-ref HEAD` names the branch, and so a worktree checks the app out.
  git(root, 'commit', '-q', '-m', 'init')

  return appDir
}

beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-alias-')))
})

afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true })
})

describe('readAppAliasName', () => {
  it('is `<release>.<package>.<repo>`', () => {
    const appDir = seedRepo('hulyo-monorepo', 'feature/HUL-7', '@hulyo/client-ui')

    expect(readAppAliasName('@hulyo/client-ui', appDir)).toBe('hul-7.hulyo-client-ui.hulyo-monorepo')
    expect(readAppAliasHost('@hulyo/client-ui', appDir)).toBe('hul-7.hulyo-client-ui.hulyo-monorepo.localhost')
  })

  it('keeps two repos apart when their branch and package name are the same', () => {
    // travelist and hulyo both ship a `website-ui` and both cut `dev`; a shared alias let `dev --reuse`
    // adopt the other repo's server.
    const travelist = seedRepo('travelist-monorepo', 'dev')
    const hulyo = seedRepo('hulyo-monorepo', 'dev')

    expect(readAppAliasName('website-ui', travelist)).toBe('dev.website-ui.travelist-monorepo')
    expect(readAppAliasName('website-ui', hulyo)).toBe('dev.website-ui.hulyo-monorepo')
  })

  it('names a worktree after its main checkout, so it never collides with another repo', () => {
    const main = path.join(temp, 'hulyo-monorepo')

    seedRepo('hulyo-monorepo', 'dev')
    const worktree = path.join(temp, 'hulyo-monorepo-worktrees/feature/x')

    git(main, 'worktree', 'add', '-q', '-b', 'feature/x', worktree)

    expect(readAppAliasName('website-ui', path.join(worktree, 'apps/website/ui'))).toBe('x.website-ui.hulyo-monorepo')
  })

  it("takes `<repo>` from the main checkout's `aliasRepo`, in every worktree", () => {
    const main = path.join(temp, 'travelist-monorepo')

    seedRepo('travelist-monorepo', 'dev')
    fs.writeFileSync(path.join(main, 'infra-kit.json'), JSON.stringify({ aliasRepo: 'trvl' }))
    const worktree = path.join(temp, 'travelist-monorepo-worktrees/feature/x')

    git(main, 'worktree', 'add', '-q', '-b', 'feature/x', worktree)

    expect(readAppAliasName('website-ui', path.join(main, 'apps/website/ui'))).toBe('dev.website-ui.trvl')
    expect(readAppAliasName('website-ui', path.join(worktree, 'apps/website/ui'))).toBe('x.website-ui.trvl')
  })

  it('throws for a package name with no DNS-legal characters', () => {
    const appDir = seedRepo('hulyo-monorepo', 'dev')

    expect(() => {
      return readAppAliasName('@@@', appDir)
    }).toThrow(/no letters or digits/)
  })
})

describe('readRepoSlug', () => {
  it('slugifies the main checkout directory name', () => {
    expect(readRepoSlug(seedRepo('My_Repo.v2', 'dev'))).toBe('my-repo-v2')
  })

  it('names a bare repo after itself, minus `.git`, and roots it at itself rather than its parent', () => {
    const bare = path.join(temp, 'hulyo-monorepo.git')

    git(temp, 'init', '-q', '--bare', bare)

    // Rooted at the parent, an env-load scope would take in every sibling repo under it.
    expect(readRepoIdentity(bare)).toEqual({ root: bare, slug: 'hulyo-monorepo' })
  })

  it('roots a checkout and each of its worktrees at the main checkout', () => {
    const main = path.join(temp, 'hulyo-monorepo')

    seedRepo('hulyo-monorepo', 'dev')
    const worktree = path.join(temp, 'hulyo-monorepo-worktrees/feature/x')

    git(main, 'worktree', 'add', '-q', '-b', 'feature/x', worktree)

    expect(readRepoIdentity(path.join(main, 'apps'))).toEqual({ root: main, slug: 'hulyo-monorepo' })
    expect(readRepoIdentity(worktree)).toEqual({ root: main, slug: 'hulyo-monorepo' })
  })

  it('keeps `root` from git when `aliasRepo` renames the label', () => {
    const main = path.join(temp, 'hulyo-monorepo')

    seedRepo('hulyo-monorepo', 'dev')
    fs.writeFileSync(path.join(main, 'infra-kit.json'), JSON.stringify({ aliasRepo: 'hulyo' }))

    expect(readRepoIdentity(main)).toEqual({ root: main, slug: 'hulyo' })
  })

  it.each([
    ['no `aliasRepo`', { envManagement: {} }],
    ['a non-string `aliasRepo`', { aliasRepo: 7 }],
    ['an `aliasRepo` with no DNS-legal characters', { aliasRepo: '@@' }],
  ])('falls back to the directory name for %s', (_case, config) => {
    const main = path.join(temp, 'hulyo-monorepo')

    seedRepo('hulyo-monorepo', 'dev')
    fs.writeFileSync(path.join(main, 'infra-kit.json'), JSON.stringify(config))

    expect(readRepoSlug(main)).toBe('hulyo-monorepo')
  })

  it('falls back to the directory name when `infra-kit.json` is not JSON', () => {
    const main = path.join(temp, 'hulyo-monorepo')

    seedRepo('hulyo-monorepo', 'dev')
    fs.writeFileSync(path.join(main, 'infra-kit.json'), '{')

    expect(readRepoSlug(main)).toBe('hulyo-monorepo')
  })

  it('falls back outside a git repo', () => {
    expect(readRepoIdentity(temp)).toEqual({ root: null, slug: DEFAULT_REPO_SLUG })
  })
})
