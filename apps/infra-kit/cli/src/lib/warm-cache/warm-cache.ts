import fs from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_WARM_TTL_SECONDS,
  ENV_CLEAR_FILE,
  ENV_LOAD_FILE,
  atomicWriteFileSync,
  getProjectWarmCacheDir,
  getWarmCacheRoot,
} from 'src/lib/constants'
import { logger } from 'src/lib/logger'

/** Inputs for {@link shouldWriteWarm}. All derivable without I/O so the gate is pure. */
export interface ShouldWriteWarmInput {
  /** Was this an automatic load? Manual loads must never become the project default. */
  autoLoaded: boolean
  /** The canonical project dir the SHELL passed via `--project-dir` (undefined for cli-invocation / non-startup callers). */
  projectDir: string | undefined
  /** `realpath(git top-level)` for this load, or '' when non-git / unresolvable (see {@link canonicalizeProjectRoot}). */
  canonicalProjectRoot: string
}

/**
 * Decide whether an auto-load should ALSO write a project-scoped warm copy. Pure
 * (no I/O) so the full gate matrix is unit-testable. Warm requires ALL of:
 *  - the load was automatic (a manual `env-load prod` must not warm the project);
 *  - the shell passed a canonical `--project-dir` (warm is a shell-startup-only
 *    optimization; the cli-invocation trigger passes none and gets no warm file);
 *  - a non-empty git root (else every non-git project would collapse to one key
 *    and cross-leak secrets);
 *  - the realpath'd git root EQUALS the shell's canonical dir — the byte-identical
 *    key contract. On any mismatch (symlink/nested-config monorepo) we skip warm
 *    and degrade to the already-correct poll rather than write under a key the
 *    shell will never look up.
 */
export const shouldWriteWarm = ({ autoLoaded, projectDir, canonicalProjectRoot }: ShouldWriteWarmInput): boolean => {
  if (!autoLoaded) return false
  if (!projectDir) return false
  if (!canonicalProjectRoot) return false

  return canonicalProjectRoot === projectDir
}

/** `realpath(projectRoot)`, or '' when projectRoot is empty or unresolvable. Never throws. */
export const canonicalizeProjectRoot = (projectRoot: string): string => {
  if (!projectRoot) return ''

  try {
    return fs.realpathSync(projectRoot)
  } catch {
    return ''
  }
}

/**
 * Write the warm copy of env-load.sh for a project (0o600). Best-effort: a warm
 * write must never break the real (session) load, so failures are swallowed to
 * debug. `contents` is the SAME bytes as the session file so a warm-source is
 * indistinguishable from a fresh one.
 */
export const writeWarmCache = (canonicalProjectDir: string, contents: string): void => {
  try {
    const dir = getProjectWarmCacheDir(canonicalProjectDir)

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    atomicWriteFileSync(path.join(dir, ENV_LOAD_FILE), contents, 0o600)
  } catch (error) {
    logger.debug(`warm-cache write skipped: ${(error as Error).message}`)
  }
}

/**
 * Delete every project's warm dir whose env-load.sh is older than the TTL. The
 * codebase has no cache reaper, so warm files (plaintext secrets) would otherwise
 * accumulate indefinitely at a stable path; each successful warm write sweeps the
 * whole `projects/` tree. The just-written project is fresh (mtime≈now) so it is
 * never swept. Best-effort, concurrency-tolerant (force), never throws.
 */
export const evictStaleWarmCaches = (
  nowMs: number = Date.now(),
  ttlSeconds: number = DEFAULT_WARM_TTL_SECONDS,
): void => {
  const root = getWarmCacheRoot()

  let entries: fs.Dirent[]

  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return // no warm root yet — nothing to sweep
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const projectDir = path.join(root, entry.name)

    try {
      const { mtimeMs } = fs.statSync(path.join(projectDir, ENV_LOAD_FILE))

      if (nowMs - mtimeMs >= ttlSeconds * 1000) {
        fs.rmSync(projectDir, { recursive: true, force: true })
      }
    } catch {
      // missing/unreadable warm file — leave the dir (a lone clear marker is harmless)
    }
  }
}

/**
 * Invalidate a project's warm cache on `env-clear`. `purge` removes the project's
 * warm dir outright (durable disable). Otherwise, when a warm file exists, write a
 * clear-marker (`env-clear.sh`) so the NEXT shell's startup gate skips warm-source
 * (it compares marker mtime vs warm mtime, clear wins). The marker is TRANSIENT: a
 * later successful auto-load writes a newer warm file and warm resumes — durable
 * disable requires `purge`. Best-effort, never throws.
 */
export const invalidateProjectWarmCache = (canonicalProjectDir: string, purge: boolean): void => {
  try {
    const dir = getProjectWarmCacheDir(canonicalProjectDir)

    if (purge) {
      fs.rmSync(dir, { recursive: true, force: true })

      return
    }

    // No warm file ⇒ nothing to suppress; don't create a dir just to hold a marker.
    if (!fs.existsSync(path.join(dir, ENV_LOAD_FILE))) return

    atomicWriteFileSync(path.join(dir, ENV_CLEAR_FILE), '# infra-kit warm cache cleared\n', 0o600)
  } catch (error) {
    logger.debug(`warm-cache invalidate skipped: ${(error as Error).message}`)
  }
}
