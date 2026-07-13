/**
 * Dependency-closure map for scoped `infra-kit dev --watch` restarts (plan Phase 1, Option B).
 *
 * `pnpm` is resolved from PATH — the same trust posture as the rest of the dev-server, which
 * already shells out to `pnpm exec turbo …`; the args are fixed literals plus discovered package
 * names, never shell-interpolated.
 *
 * Rather than re-derive the workspace graph in-process, infra-kit asks turbo what it would
 * rebuild: `turbo run build --dry=json --filter=...<pkg>` lists every package in an app's build
 * closure (`tasks[].package`). That set is authoritative — it is exactly what the running
 * `turbo watch build` engine rebuilds — so there is no drift and no glob-parser/BFS/cycle-guard
 * to maintain here. The runner inverts these per-app closures into `dependentsByPackageDir`
 * (which app folders depend on each `packages/<x>/dist`) and, on a package-dist change, restarts
 * only the dependent backends instead of every one.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'

import { getPackageDistDirs } from './discovery.js'

const execFileAsync = promisify(execFile)

/** The subset of an app's identity the closure map needs. */
export interface ClosureApp {
  /** App folder name (e.g. `client`) — the restart key in the dependents map. */
  name: string
  /** package.json `name` (e.g. `sls-trvl-client`) — the turbo `--filter` target. */
  packageName: string
}

/**
 * Resolve one app's build closure: the set of workspace package **names** turbo would rebuild
 * for it. Injectable so tests drive `buildClosureMap` without spawning a real turbo. A rejection
 * propagates through `Promise.all` so the caller can apply its restart-all fail-safe.
 */
export type DryRunner = (packageName: string) => Promise<string[]>

/** The inverted closure: `packages/<x>/dist` → the app folders that depend on it, plus the dir→name bridge. */
export interface ClosureMap {
  /** `packages/<x>/dist` absolute dir → set of app folder names whose closure includes it. */
  dependentsByPackageDir: Map<string, Set<string>>
  /** `packages/<x>/dist` absolute dir → that package's package.json `name` (dir ≠ name for scoped pkgs). */
  packageNameByDir: Map<string, string>
}

/** Read `<dir>/package.json` `name`, or `undefined` when absent/unreadable (never throws). */
const readPackageName = (dir: string): string | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as { name?: unknown }

    return typeof parsed.name === 'string' ? parsed.name : undefined
  } catch {
    return undefined
  }
}

/**
 * Default {@link DryRunner}: `turbo run build --dry=json --filter=...<pkg>` in `root`, returning the
 * unique `tasks[].package` set (the packages turbo would rebuild for `<pkg>`). `...` includes the
 * app's own dependency closure, mirroring the `turbo watch build` filter.
 */
export const defaultDryRunner = (root: string): DryRunner => {
  return async (packageName: string): Promise<string[]> => {
    const { stdout } = await execFileAsync(
      'pnpm',
      ['exec', 'turbo', 'run', 'build', '--dry=json', `--filter=...${packageName}`],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 },
    )
    const parsed = JSON.parse(stdout) as { tasks?: Array<{ package?: unknown }> }
    const names = (parsed.tasks ?? [])
      .map((t) => {
        return t.package
      })
      .filter((p): p is string => {
        return typeof p === 'string'
      })

    return [...new Set(names)]
  }
}

/** Build `packageNameByDir` (and its reverse) for every existing `packages/<x>/dist` under `root`. */
const readPackageDirs = (root: string): { packageNameByDir: Map<string, string>; dirByName: Map<string, string> } => {
  const packageNameByDir = new Map<string, string>()
  const dirByName = new Map<string, string>()

  for (const distDir of getPackageDistDirs(root)) {
    const name = readPackageName(path.dirname(distDir))

    if (name !== undefined) {
      packageNameByDir.set(distDir, name)
      dirByName.set(name, distDir)
    }
  }

  return { packageNameByDir, dirByName }
}

/**
 * Ask turbo for each app's build closure (in parallel) and invert it into {@link ClosureMap}:
 * `packages/<x>/dist` → the app folders whose closure includes that package. Apps' own packages
 * (not under `packages/`) simply don't appear in the map, so they never scope a package restart.
 *
 * A {@link DryRunner} rejection propagates (via `Promise.all`) so the caller falls back to
 * restart-all — the map is never silently partial.
 *
 * @example
 * // appX deps pkgA+pkgC; appY deps pkgC only →
 * //   dependentsByPackageDir: { '…/pkgA/dist': {appX}, '…/pkgC/dist': {appX, appY} }
 */
export const buildClosureMap = async (
  root: string,
  apps: ClosureApp[],
  dryRunner: DryRunner = defaultDryRunner(root),
): Promise<ClosureMap> => {
  const { packageNameByDir, dirByName } = readPackageDirs(root)
  const dependentsByPackageDir = new Map<string, Set<string>>()

  const closures = await Promise.all(
    apps.map(async (app) => {
      return { app, closure: await dryRunner(app.packageName) }
    }),
  )

  for (const { app, closure } of closures) {
    for (const pkgName of closure) {
      const distDir = dirByName.get(pkgName)

      if (distDir === undefined) continue

      const dependents = dependentsByPackageDir.get(distDir) ?? new Set<string>()

      dependents.add(app.name)
      dependentsByPackageDir.set(distDir, dependents)
    }
  }

  return { dependentsByPackageDir, packageNameByDir }
}

/** Debounce key for a package-dist change — distinct per package dir so unrelated packages never collapse into one bucket. */
export const packageDebounceKey = (packageDir: string): string => {
  return `__pkg__:${packageDir}`
}

/**
 * Decide which launched apps a `packages/<pkg>/dist` change should restart. `null` means
 * "fail-safe: restart all" — the closure map is missing (a `--dry` failure) or the change carried
 * no package identity. Otherwise the participating (`watchDeps`) apps whose closure includes that
 * package dir — possibly an empty array (the package is UI-only, or every dependent opted out),
 * which the caller treats as "restart nothing".
 *
 * @example
 * // closure: pkgA → {appX}; pkgC → {appX, appY}
 * selectPackageRestartTargets([appX, appY], map, '…/pkgA/dist') // => [appX]   (not appY)
 * selectPackageRestartTargets([appX, appY], map, '…/uiOnly/dist') // => []     (restart nothing)
 * selectPackageRestartTargets([appX, appY], null, '…/pkgA/dist') // => null    (fail-safe: restart all)
 */
export const selectPackageRestartTargets = <T extends { name: string; watchDeps: boolean }>(
  apps: T[],
  closureMap: ClosureMap | null,
  packageDir: string | undefined,
): T[] | null => {
  if (closureMap === null || packageDir === undefined) return null

  const dependents = closureMap.dependentsByPackageDir.get(packageDir) ?? new Set<string>()

  return apps.filter((a) => {
    return a.watchDeps && dependents.has(a.name)
  })
}
