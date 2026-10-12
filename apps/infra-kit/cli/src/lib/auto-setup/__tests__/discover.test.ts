import { describe, expect, it } from 'vitest'

import type { PluginInstallation } from 'src/lib/plugin-pointer/install-state'

import { discoverInfraKitProjects, mainCheckoutOf } from '../discover'

const installation = (projectPath: string | null): PluginInstallation => {
  return { scope: 'project', projectPath, installPath: null, version: '0.19.0' }
}

describe('mainCheckoutOf', () => {
  it('folds a linked worktree into its main checkout', () => {
    expect(
      mainCheckoutOf('/p/api-worktrees/feature/x', () => {
        return 'gitdir: /p/api/.git/worktrees/x\n'
      }),
    ).toBe('/p/api')
  })

  it('keeps a main checkout (no .git file) and an unrecognised pointer as they are', () => {
    expect(
      mainCheckoutOf('/p/api', () => {
        return null
      }),
    ).toBe('/p/api')
    expect(
      mainCheckoutOf('/p/sub', () => {
        return 'gitdir: ../.git/modules/sub\n'
      }),
    ).toBe('/p/sub')
  })
})

describe('discoverInfraKitProjects', () => {
  it('keeps infra-kit projects only, folds worktrees, dedupes, and sorts', () => {
    const projects = discoverInfraKitProjects({
      listInstallations: () => {
        return [
          installation('/p/web'),
          installation('/p/api'),
          installation('/p/api-worktrees/feature/x'),
          installation('/p/stranger'),
          installation(null),
          installation('/p/deleted'),
        ]
      },
      exists: (target) => {
        return ['/p/web/infra-kit.json', '/p/api/infra-kit.json'].includes(target)
      },
      readGitFile: (gitPath) => {
        return gitPath === '/p/api-worktrees/feature/x/.git' ? 'gitdir: /p/api/.git/worktrees/x' : null
      },
      realpath: (target) => {
        return target
      },
    })

    expect(projects).toEqual(['/p/api', '/p/web'])
  })

  it('dedupes two spellings of one checkout by realpath', () => {
    const projects = discoverInfraKitProjects({
      listInstallations: () => {
        return [installation('/link/api'), installation('/p/api')]
      },
      exists: () => {
        return true
      },
      readGitFile: () => {
        return null
      },
      realpath: (target) => {
        return target.replace('/link', '/p')
      },
    })

    expect(projects).toEqual(['/link/api'])
  })
})
