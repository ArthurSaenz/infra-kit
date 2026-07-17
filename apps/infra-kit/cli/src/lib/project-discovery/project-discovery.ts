import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { OperationError } from 'src/lib/errors/operation-error'
import { getMainRepoRoot } from 'src/lib/git-utils'

/**
 * A live infra-kit project found by scanning a workspace root. `repoRoot` is
 * realpath'd so two entries that resolve to the same directory (a symlink, a
 * `/var`→`/private/var` alias) collapse to one.
 */
export interface DiscoveredProject {
  name: string
  repoRoot: string
}

export interface DiscoverInfraKitProjectsOptions {
  /**
   * Explicit discovery roots. When non-empty these win outright; otherwise the
   * scan falls back to `dirname(getMainRepoRoot())` (the workspace dir).
   */
  roots?: string[]
}

/** True iff `target` exists (file or dir); tolerates ENOENT and any other stat error. */
const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target)

    return true
  } catch {
    return false
  }
}

/**
 * Resolve the scan roots per the discovery ladder: explicit `roots` win; else
 * `[dirname(await getMainRepoRoot())]`. Throws an `OperationError` with a
 * remediation hint when neither is available (not inside a git repo, no roots).
 */
const resolveRoots = async (roots?: string[]): Promise<string[]> => {
  if (roots && roots.length > 0) return roots

  try {
    const mainRepoRoot = await getMainRepoRoot()

    return [path.dirname(mainRepoRoot)]
  } catch (error) {
    throw new OperationError(error, {
      operation: 'discover infra-kit projects',
      remediation: 'run inside an infra-kit repo, or pass --root <dir>',
    })
  }
}

/** A candidate is worth stat-ing only if it is a directory or a symlink to one. */
const isScanCandidate = (child: Dirent): boolean => {
  return child.isDirectory() || child.isSymbolicLink()
}

/**
 * Resolve one direct child of a root into a {@link DiscoveredProject}, or `null`
 * when it is not a live infra-kit project. Live = BOTH `<candidate>/.git` (file
 * or dir — worktrees use a `.git` file) and `<candidate>/infra-kit.json` exist.
 * `repoRoot` is realpath'd; an unresolvable path yields `null`.
 */
const resolveCandidate = async (root: string, child: Dirent): Promise<DiscoveredProject | null> => {
  if (!isScanCandidate(child)) return null

  const candidate = path.join(root, child.name)

  const [hasGit, hasConfig] = await Promise.all([
    pathExists(path.join(candidate, '.git')),
    pathExists(path.join(candidate, 'infra-kit.json')),
  ])

  if (!hasGit || !hasConfig) return null

  try {
    const repoRoot = await fs.realpath(candidate)

    return { name: path.basename(candidate), repoRoot }
  } catch {
    return null
  }
}

/** Read a root's direct children; a missing or unreadable root yields none. */
const readRootChildren = async (root: string): Promise<Dirent[]> => {
  try {
    return await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Scan the workspace for live infra-kit projects.
 *
 * SCAN-BASED — the registry (`~/.infra-kit/projects/`) is never read. For each
 * root (per {@link resolveRoots}), read its DIRECT children (depth 1 only — a
 * recursive home crawl is a `node_modules` latency bomb) and keep the ones that
 * {@link resolveCandidate} deems live. Entries are deduped by realpath'd
 * `repoRoot` and returned sorted by name.
 */
export const discoverInfraKitProjects = async (
  options: DiscoverInfraKitProjectsOptions = {},
): Promise<DiscoveredProject[]> => {
  const roots = await resolveRoots(options.roots)

  const byRepoRoot = new Map<string, DiscoveredProject>()

  for (const root of roots) {
    const children = await readRootChildren(root)

    for (const child of children) {
      const project = await resolveCandidate(root, child)

      if (project && !byRepoRoot.has(project.repoRoot)) {
        byRepoRoot.set(project.repoRoot, project)
      }
    }
  }

  return [...byRepoRoot.values()].sort((a, b) => {
    return a.name.localeCompare(b.name)
  })
}
