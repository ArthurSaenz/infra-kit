/**
 * The projects an unattended setup visits: every project Claude Code recorded the infra-kit plugin for
 * (`installed_plugins.json`, written by `setup`'s own project-scope install), narrowed to the ones that
 * still exist and carry an `infra-kit.json`.
 *
 * A linked worktree folds into its main checkout: the per-project config and the worktree scaffold are
 * keyed to the main root anyway, so visiting each worktree would repeat one run under another name.
 * The fold reads `.git` as a file instead of spawning `git`, so a broken checkout costs one skip.
 */
import fs from 'node:fs'
import path from 'node:path'

import { listProjectPluginInstallations } from 'src/lib/plugin-pointer/install-state'
import type { PluginInstallation } from 'src/lib/plugin-pointer/install-state'

export interface DiscoverDeps {
  listInstallations?: () => readonly PluginInstallation[]
  exists?: (target: string) => boolean
  /** `<root>/.git` when it is a FILE (a linked worktree), else null. */
  readGitFile?: (gitPath: string) => string | null
  realpath?: (target: string) => string
}

const defaultReadGitFile = (gitPath: string): string | null => {
  try {
    return fs.statSync(gitPath).isFile() ? fs.readFileSync(gitPath, 'utf8') : null
  } catch {
    return null
  }
}

const defaultRealpath = (target: string): string => {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

/**
 * A linked worktree's main checkout, from its `gitdir: <main>/.git/worktrees/<name>` pointer; the root
 * itself when it is not a linked worktree or the pointer has another shape (a submodule, a bare repo).
 *
 * @example
 * mainCheckoutOf('/p/api-worktrees/feature/x', () => 'gitdir: /p/api/.git/worktrees/x\n') // => '/p/api'
 */
export const mainCheckoutOf = (root: string, readGitFile: (gitPath: string) => string | null): string => {
  const pointer = readGitFile(path.join(root, '.git'))
  const line = pointer
    ?.split('\n')
    .map((entry) => {
      return entry.trim()
    })
    .find((entry) => {
      return entry.startsWith('gitdir:')
    })
  const gitdir = line?.slice('gitdir:'.length).trim()

  if (!gitdir) return root

  const absolute = path.resolve(root, gitdir)
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`
  const index = absolute.lastIndexOf(marker)

  return index === -1 ? root : absolute.slice(0, index)
}

/**
 * @example
 * discoverInfraKitProjects() // => ['/Users/me/projects/hulyo', '/Users/me/projects/travelist']
 */
export const discoverInfraKitProjects = (deps: DiscoverDeps = {}): string[] => {
  const listInstallations = deps.listInstallations ?? listProjectPluginInstallations
  const exists = deps.exists ?? fs.existsSync
  const readGitFile = deps.readGitFile ?? defaultReadGitFile
  const realpath = deps.realpath ?? defaultRealpath

  const roots = new Map<string, string>()

  for (const installation of listInstallations()) {
    if (installation.projectPath === null) continue

    const root = mainCheckoutOf(installation.projectPath, readGitFile)

    if (!exists(path.join(root, 'infra-kit.json'))) continue

    const key = realpath(root)

    if (!roots.has(key)) roots.set(key, root)
  }

  return [...roots.values()].sort()
}
