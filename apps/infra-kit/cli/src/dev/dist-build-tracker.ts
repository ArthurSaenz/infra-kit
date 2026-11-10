import fs from 'node:fs'
import path from 'node:path'

import {
  buildInfoCoversOutputs,
  findStaleSources,
  formatBuildErrors,
  readLatestBuildInfo,
  readPackageName,
  summarizeBuildErrors,
} from './build-freshness.js'
import type { BuildInfo, StaleSource } from './build-freshness.js'

type LogFn = (msg: string, level?: 'info' | 'warn' | 'error' | 'debug') => void

export interface DistBuildTrackerDeps {
  log: LogFn
  /** Runs one shell build command; the same seam the runner builds with. */
  runBuild: (cmd: string, logFn?: LogFn) => Promise<void>
  /** Once true, no rebuild is started and no verdict is printed. */
  isStopped: () => boolean
}

/**
 * What the watched dist directories say about the builds that wrote them: which build a changed file
 * came from, whether that build emitted through type errors, and whether it missed a save — in which
 * case the save is recovered by a forced rebuild.
 */
export class DistBuildTracker {
  /**
   * How long a stale build must STAY stale before the runner rebuilds it: a save that simply landed after
   * the last build is compiled by `turbo watch` itself, and a second concurrent `tsc -b` would race it.
   */
  private static readonly STALE_BUILD_GRACE_MS = 1000

  /** Every dist dir the watcher covers — maps a changed dist file back to the package that built it. */
  distDirs: string[] = []
  /**
   * Per package dir, the stale sources (path + current hash) a forced rebuild was already spent on. The
   * same staleness is never nudged twice, so a source a build legitimately never compiles cannot loop.
   */
  private readonly nudgedStaleness = new Map<string, string>()
  private readonly deps: DistBuildTrackerDeps

  constructor(deps: DistBuildTrackerDeps) {
    this.deps = deps
  }

  /**
   * The packages (a dist dir's parent) whose dist changes triggered this restart, each with the buildinfo
   * of the build that wrote them — a package whose buildinfo did not write them (see
   * {@link buildInfoCoversOutputs}) or that has none is left out: nothing trustworthy to say about it.
   */
  triggeringBuilds(changed: string[]): Array<{ pkgDir: string; info: BuildInfo }> {
    const distFilesByPkg = new Map<string, string[]>()

    for (const file of changed) {
      const distDir = this.distDirs.find((dir) => {
        return file === dir || file.startsWith(dir + path.sep)
      })

      if (distDir === undefined) continue

      const pkgDir = path.dirname(distDir)

      distFilesByPkg.set(pkgDir, [...(distFilesByPkg.get(pkgDir) ?? []), file])
    }

    return [...distFilesByPkg].flatMap(([pkgDir, distFiles]) => {
      const info = readLatestBuildInfo(pkgDir)

      return info && buildInfoCoversOutputs(info, distFiles) ? [{ pkgDir, info }] : []
    })
  }

  /** The type errors the triggering builds emitted through, as one clause, or `undefined` when all are clean. */
  describeBuildErrors(builds: Array<{ pkgDir: string; info: BuildInfo }>): string | undefined {
    const clauses = builds.flatMap(({ pkgDir, info }) => {
      const errors = summarizeBuildErrors(info, pkgDir)

      return errors ? [formatBuildErrors(readPackageName(pkgDir), errors)] : []
    })

    return clauses.length > 0 ? clauses.join('; ') : undefined
  }

  /**
   * Rebuild a package whose last build did not compile its sources' current text, so the save it missed
   * reaches the server through an ordinary dist change and restart.
   *
   * The miss is real: during a save burst `turbo watch` re-runs the build for the last save, but `tsc -b`
   * judges it up to date because that save's mtime is older than the buildinfo the in-flight run wrote.
   * turbo then caches that no-op under the last save's hash, so neither a re-save nor `turbo run` without
   * `--force` recovers — and turbo ignores an mtime-only touch. Hence: touch (so `tsc -b` sees the input as
   * newer) and a forced single-package `turbo run build` (which also overwrites the poisoned cache entry).
   */
  async recoverLostSaves(builds: Array<{ pkgDir: string; info: BuildInfo }>): Promise<void> {
    try {
      for (const { pkgDir, info } of builds) {
        await this.recoverLostSave(pkgDir, info)
      }
    } catch (error) {
      this.deps.log(`   Lost-save check failed: ${String(error)}`, 'debug')
    }
  }

  private async recoverLostSave(pkgDir: string, info: BuildInfo): Promise<void> {
    const stale = findStaleSources(info, pkgDir)

    if (stale.length === 0) {
      this.nudgedStaleness.delete(pkgDir)

      return
    }

    const staleness = stale
      .map(({ file, hash }) => {
        return `${file}:${hash}`
      })
      .join('\n')

    if (this.nudgedStaleness.get(pkgDir) === staleness) return

    await new Promise((resolve) => {
      setTimeout(resolve, DistBuildTracker.STALE_BUILD_GRACE_MS)
    })

    // A build that wrote in the meantime brings its own dist change and restart, which re-checks.
    if (this.deps.isStopped() || readLatestBuildInfo(pkgDir)?.mtimeMs !== info.mtimeMs) return

    this.nudgedStaleness.set(pkgDir, staleness)
    await this.forceRebuild(pkgDir, stale)
  }

  private async forceRebuild(pkgDir: string, stale: StaleSource[]): Promise<void> {
    const pkgName = readPackageName(pkgDir)

    const files = stale
      .map(({ file }) => {
        return path.relative(pkgDir, file)
      })
      .join(', ')

    const now = new Date()

    this.deps.log(`👀 ${pkgName}: last build missed a save of ${files}; forcing a rebuild`, 'debug')

    for (const { file } of stale) {
      try {
        fs.utimesSync(file, now, now)
      } catch {
        // Deleted since the hash was taken — nothing left to rebuild for.
      }
    }

    try {
      await this.deps.runBuild(
        `pnpm exec turbo run build --filter=${pkgName} --env-mode=loose --output-logs=errors-only --no-update-notifier --force`,
        (message) => {
          this.deps.log(message, 'debug')
        },
      )
    } catch (error) {
      // A type error fails the build yet still emits; the re-read below is the verdict either way.
      this.deps.log(`   Forced rebuild of ${pkgName} failed: ${String(error)}`, 'debug')
    }

    const retry = readLatestBuildInfo(pkgDir)

    if (this.deps.isStopped() || !retry || findStaleSources(retry, pkgDir).length === 0) return

    this.deps.log(
      `⚠️  ${pkgName}: ${files} changed but a forced rebuild still did not compile it — the server may be ` +
        'serving an older save. Save the file again, or re-run `infra-kit dev`.',
      'warn',
    )
  }
}
