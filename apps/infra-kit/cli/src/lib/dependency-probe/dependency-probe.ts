/**
 * Turn one {@link DependencySpec} into the state doctor/install actually need: is the tool findable at
 * all, and separately, does `<binName>` resolve on `PATH`. Those two are NOT the same question — the
 * AWS-documented installer puts `aws` in `$HOME/.local/bin`, which is routinely absent from `PATH`, so a
 * successful install can still leave `aws --version` failing on `PATH` alone. Collapsing the two into one
 * boolean would report that install as "not installed", which is wrong and actively misleading.
 *
 * Every process interaction is an injected seam ({@link ProbeDeps}), same discipline as
 * `src/dev/proxy/portless-driver.ts` and `src/commands/self-update/self-update.ts`: nothing here calls
 * `spawn`/`zx`/`fs` directly, so the whole matrix — including the aws script-vs-homebrew split-brain case —
 * is table-testable without shelling out.
 */
import type { DependencyId, DependencyManager, DependencySpec } from 'src/lib/dependency-registry'
import { specFor, supportsPlatform } from 'src/lib/dependency-registry'

export interface DependencyState {
  id: DependencyId
  /** The tool is installed somewhere we can find — on `PATH` or not. */
  present: boolean
  /** `<binName>` resolves on `PATH`. Can be `false` while `present` is `true`; see the file header. */
  onPath: boolean
  binRealPath: string | null
  version: string | null
  manager: DependencyManager
}

export interface ProbeRunResult {
  stdout: string
}

/**
 * Seams for {@link probeDependency}. Every field is a real process/filesystem interaction elsewhere in
 * the codebase, injected here so tests assert exact inputs without touching the real machine.
 */
export interface ProbeDeps {
  /** Run `argv`, resolving with its stdout. Rejects on a non-zero exit or a missing binary — mirrors `execFile`. */
  runCommand: (argv: string[]) => Promise<ProbeRunResult>
  /**
   * Find `binName` however deps see fit — `PATH` plus whatever extra locations a real implementation
   * wants to search (e.g. the aws installer's `$HOME/.local/bin`). Null when not found anywhere. This is
   * NOT restricted to `PATH`: that is what lets `present` and `onPath` disagree.
   */
  resolveBinPath: (binName: string) => Promise<string | null>
  /** Canonicalise a resolved path (follow symlinks), same contract as install-manager's `RealpathFn`. */
  realpath: (p: string) => string
  platform: NodeJS.Platform
}

const NOT_FOUND = (id: DependencyId): DependencyState => {
  return { id, present: false, onPath: false, binRealPath: null, version: null, manager: 'unknown' }
}

/** Run `argv`, swallowing any rejection into `null` — the non-throwing half of every seam call below. */
const tryRun = async (runCommand: ProbeDeps['runCommand'], argv: string[]): Promise<ProbeRunResult | null> => {
  try {
    return await runCommand(argv)
  } catch {
    return null
  }
}

/**
 * `resolveBinPath` and `realpath` are caller-supplied and may be backed by real filesystem calls, so
 * neither is trusted not to throw — requirement 4 (never a throw) has to hold regardless of what a
 * production implementation does on a permissions error or a dangling symlink.
 */
const tryResolveRealBin = async (deps: ProbeDeps, binName: string): Promise<string | null> => {
  try {
    const resolved = await deps.resolveBinPath(binName)

    return resolved == null ? null : deps.realpath(resolved)
  } catch {
    return null
  }
}

/**
 * Probe one dependency. Never throws: an unresolvable binary, a non-zero exit, or a misbehaving seam all
 * fold into `present: false, manager: 'unknown'`.
 *
 * A tool unsupported on `deps.platform` is not probed at all — no seam call is made — since asking "is gh
 * on `PATH`" is meaningless on a platform its recipe never targets.
 */
export const probeDependency = async (spec: DependencySpec, deps: ProbeDeps): Promise<DependencyState> => {
  if (!supportsPlatform(spec, deps.platform)) return NOT_FOUND(spec.id)

  const viaPath = await tryRun(deps.runCommand, spec.probeArgv)
  const binRealPath = await tryResolveRealBin(deps, spec.binName)

  if (viaPath == null && binRealPath == null) return NOT_FOUND(spec.id)

  // Version comes from whichever invocation actually succeeded: the `PATH` run when there was one,
  // otherwise a second attempt run BY absolute path — `present && !onPath` still deserves a version.
  const versionSource =
    viaPath ?? (binRealPath == null ? null : await tryRun(deps.runCommand, [binRealPath, ...spec.probeArgv.slice(1)]))

  return {
    id: spec.id,
    present: true,
    onPath: viaPath != null,
    binRealPath,
    version: versionSource == null ? null : spec.versionFrom(versionSource.stdout),
    manager: binRealPath == null ? 'unknown' : spec.identify(binRealPath),
  }
}

/** Probe every id in `ids`, independently and in parallel — order preserved, one {@link probeDependency} per id. */
export const probeAll = async (ids: readonly DependencyId[], deps: ProbeDeps): Promise<DependencyState[]> => {
  return Promise.all(
    ids.map((id) => {
      return probeDependency(specFor(id), deps)
    }),
  )
}
