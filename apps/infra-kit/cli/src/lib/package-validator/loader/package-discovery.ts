import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'yaml'

import { pathExists } from '../fs-utils'

const WORKSPACE_FILE = 'pnpm-workspace.yaml'

/**
 * List the immediate child directories of `dir`, returning `[]` when the path
 * can't be read (e.g. the parent glob segment matched a non-existent dir).
 */
const listChildDirs = async (dir: string): Promise<string[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => {
    return []
  })

  return entries
    .filter((entry) => {
      return entry.isDirectory()
    })
    .map((entry) => {
      return path.join(dir, entry.name)
    })
}

/**
 * Apply one glob segment to a set of directories: `*` fans out to every child
 * directory, a literal segment keeps the dirs where that child path exists.
 */
const expandSegment = async (dirs: string[], segment: string): Promise<string[]> => {
  const next: string[] = []

  for (const dir of dirs) {
    if (segment === '*') {
      next.push(...(await listChildDirs(dir)))

      continue
    }

    const candidate = path.join(dir, segment)

    if (await pathExists(candidate)) {
      next.push(candidate)
    }
  }

  return next
}

/**
 * Expand a single pnpm-workspace glob (only the `*` segment wildcard is
 * supported, which covers every pattern this monorepo uses) into directories.
 */
const expandGlob = async (projectRoot: string, pattern: string): Promise<string[]> => {
  let dirs = [projectRoot]

  for (const segment of pattern.split('/')) {
    dirs = await expandSegment(dirs, segment)
  }

  return dirs
}

/**
 * Discover validatable workspace packages from `pnpm-workspace.yaml`.
 *
 * Negation patterns (`!…`) and everything under `vendor/` are excluded —
 * vendor is mirrored from `starter-workspace` and is checksum-enforced by
 * `pnpm vendor:check`, so its configs are owned upstream, not here. Only
 * directories that actually contain a package.json are returned.
 *
 * @example
 * await discoverPackages('/repo')
 * // => ['/repo/apps/infra-kit/cli', '/repo/packages/serverless-config']
 */
export const discoverPackages = async (projectRoot: string): Promise<string[]> => {
  const raw = await fs.readFile(path.join(projectRoot, WORKSPACE_FILE), 'utf-8')
  const parsed = (yaml.parse(raw) ?? {}) as { packages?: string[] }

  const patterns = (parsed.packages ?? []).filter((pattern) => {
    return !pattern.startsWith('!') && !pattern.startsWith('vendor')
  })

  const found = new Set<string>()

  for (const pattern of patterns) {
    const dirs = await expandGlob(projectRoot, pattern)

    for (const dir of dirs) {
      if (await pathExists(path.join(dir, 'package.json'))) {
        found.add(dir)
      }
    }
  }

  return [...found].sort()
}
