/**
 * @fileoverview
 *
 * Whole-graph ESM invalidation for `infra-kit dev --watch`, via a synchronous `module.registerHooks`
 * resolve hook.
 *
 * The backends run IN-PROCESS. Node's ESM registry is keyed by fully-resolved URL and lives for the whole
 * process, so re-`import()`ing a handler entry with a cache-busting query re-evaluates THAT module and
 * nothing it imports — every shared package and service module stays frozen at the version first loaded
 * (see {@link file://./reload-scope.ts}). Appending a per-restart generation token to every resolved
 * `file:` URL under the repo makes the whole local graph a fresh set of URLs, so a restart re-evaluates
 * all of it.
 *
 * The token is added AFTER `nextResolve`, so it rides on top of whatever the real resolver produced —
 * including a bare specifier that pnpm resolved through a `node_modules/@pkg/x` symlink into the
 * workspace. That case is the whole point, and it drives the two rules below.
 *
 * ## The two rules that decide whether this works at all
 *
 * Both are silent when wrong — the hook installs, restarts run, and the runner keeps reporting success
 * while serving stale code, which is precisely the bug this exists to remove.
 *
 * 1. **`root` is the runner's own `monorepoRoot`** — the same value the dist watcher is anchored on.
 *    NOT the main-repo root: inside a linked worktree those differ, and anchoring on the main root would
 *    make every path fail the containment test and the hook a no-op for the whole session.
 * 2. **`node_modules` is tested on the REALPATH'd path.** Every workspace dependency is a symlink out of
 *    `node_modules` (`apps/x/api/node_modules/@pkg/lib` → `packages/lib`), so testing the pre-realpath
 *    URL would exclude exactly the packages the fix targets, while leaving third-party deps correctly
 *    excluded either way.
 */
import * as fs from 'node:fs'
import module from 'node:module'
import * as path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** Query parameter carrying the generation token. */
export const GENERATION_QUERY = 'ikgen'

/**
 * The process size past which a dev session is told to stop, in bytes.
 *
 * A generation COUNT cannot carry this meaning. Every generation permanently adds module records for
 * the whole local graph — Node's ESM registry is keyed by resolved URL and offers no eviction — so the
 * cost of one generation is a property of the CONSUMER's module graph. A count calibrated on one repo
 * is wrong for the next and stale in the first after any dependency change. Bytes mean the same thing
 * everywhere: "this Node process is too big" needs no per-repo calibration.
 *
 * 2 GB is the one policy constant here, and it is defensible on its own terms rather than as a proxy
 * for an unmeasured slope: a dev-machine Node process past 2 GB is a problem whatever put it there.
 */
export const DEFAULT_STOP_BYTES = 2_000_000_000

/** Runtime view of the installed hook, handed to the runner. */
export interface ModuleGenerationHandle {
  /** Start a new generation (called before a restart re-imports). Returns the new generation number. */
  bump: () => number
  /** Did the CURRENT generation re-resolve anything under `dir`? The runner's earned-green check. */
  bustedUnder: (dir: string) => boolean
  /** The current generation number — a LABEL for messages now, never a control input. */
  generation: () => number
  /**
   * Read process size and judge it. Called once per restart, BEFORE {@link ModuleGenerationHandle.bump}.
   *
   * - `'stop'` — over `stopBytes` on TWO CONSECUTIVE calls. The hysteresis is not decoration: RSS moves
   *   with GC timing, and a single spike must not kill a session someone is working in.
   * - `'warn'` — at or past `stopBytes / 2`, and at least `warnStrideBytes` above the last warned
   *   sample. A session that keeps growing keeps saying so; one that sits flat says it once.
   * - `'ok'` — otherwise.
   *
   * It reads `busted` never, and mutates nothing the reload path depends on. That is deliberate: the
   * runner aborts on `'stop'` BEFORE calling `bump()`, so a refusal can never leave a cleared busted
   * set behind for `resolveStaleFiles` to misread as "nothing stale".
   */
  budgetState: () => 'ok' | 'warn' | 'stop'
}

interface HookState {
  busted: Set<string>
  generation: number
  root: string
  selfDist: string
}

/**
 * Live state, shared by the one installed hook. Module-level because `registerHooks` cannot be
 * uninstalled: installing per runner would stack hooks (the test suite builds many runners in one
 * process), so the hook is installed once and re-pointed on each install.
 */
let state: HookState | null = null
let installed = false

/** realpath is a syscall and resolve is hot; the mapping is stable for a session. */
const realpathCache = new Map<string, string>()

const realpathCached = (p: string): string | null => {
  const hit = realpathCache.get(p)

  if (hit !== undefined) return hit

  try {
    const resolved = fs.realpathSync(p)

    realpathCache.set(p, resolved)

    return resolved
  } catch {
    // A resolved-but-nonexistent path (a stale import, a virtual module) is not ours to rewrite.
    return null
  }
}

/** Is `child` `parent` itself or inside it? Both sides must already be realpath'd by the caller. */
const isUnder = (child: string, parent: string): boolean => {
  return child === parent || child.startsWith(parent + path.sep)
}

/**
 * Decide whether a resolved `file:` URL takes a generation token, and record it when it does.
 * Returns the rewritten URL, or `null` to leave the resolution untouched.
 */
const bustUrl = (url: string, current: HookState): string | null => {
  if (!url.startsWith('file:')) return null

  let filePath: string

  try {
    filePath = fileURLToPath(url)
  } catch {
    return null
  }

  const real = realpathCached(filePath)

  if (real === null) return null
  // Rule 1: inside the repo the runner is actually watching.
  if (!isUnder(real, current.root)) return null
  // Rule 2: on the REALPATH'd path — a workspace package reached through a `node_modules` symlink has
  // already been resolved out of it here, so it stays bustable while third-party deps do not.
  if (real.includes(`${path.sep}node_modules${path.sep}`)) return null
  // The CLI's own bundle. Excluded by realpath'd DIRECTORY, never by filename: the build emits
  // content-hashed chunks, so any name pattern would silently rot at the next build.
  if (isUnder(real, current.selfDist)) return null

  current.busted.add(real)

  const parsed = new URL(url)

  parsed.searchParams.set(GENERATION_QUERY, String(current.generation))

  return parsed.href
}

/** `module.registerHooks`, or `undefined` on a runtime without it (added in Node 22.15 / 23.5). */
const resolveRegisterHooks = (): ((hooks: unknown) => void) | undefined => {
  return (module as unknown as { registerHooks?: (hooks: unknown) => void }).registerHooks
}

/** Is whole-graph invalidation available on this runtime at all? */
export const isModuleGenerationSupported = (): boolean => {
  return typeof resolveRegisterHooks() === 'function'
}

export interface InstallOptions {
  /** The runner's own monorepo root, ALREADY realpath'd by the caller. See rule 1 in the file header. */
  root: string
  /** The CLI's own output directory, ALREADY realpath'd. See {@link selfDistDir}. */
  selfDist: string
  /** Process size at which {@link ModuleGenerationHandle.budgetState} says `'stop'`. See {@link DEFAULT_STOP_BYTES}. */
  stopBytes?: number
  /**
   * Suppress the `'stop'` verdict while leaving the warn thresholds intact — what
   * `INFRA_KIT_DEV_STOP_BYTES=0|off` resolves to.
   *
   * Modelled as a FLAG and never as `stopBytes = 0`, because both warn thresholds derive from
   * `stopBytes`: zeroing it drags `warnBytes` and the stride to zero too, and the warn predicate then
   * holds on every sample — "disable the stop, keep the warnings" would become "warn on every restart
   * forever", the exact opposite of the intent.
   */
  stopEnabled?: boolean
  /**
   * Distance a sample must climb above the last warned one before warning again. Default
   * `stopBytes / 8`. It is what keeps a growing session talking without letting a flat one spam.
   */
  warnStrideBytes?: number
  /** Process-size seam. Defaults to `process.memoryUsage.rss()`; injected so the budget is testable without allocating gigabytes. */
  sampleRss?: () => number
}

/** What {@link resolveStopBudget} yields: whether the stop fires at all, and the budget it fires on. */
export interface StopBudget {
  stopEnabled: boolean
  stopBytes: number
}

/**
 * Read `INFRA_KIT_DEV_STOP_BYTES`.
 *
 * A positive integer raises or lowers the budget. `0` or `off` disables the STOP only — the budget is
 * preserved so both derived warn thresholds keep their meaning (see {@link InstallOptions.stopEnabled}).
 * Anything else, including unset, is the default budget with the stop armed.
 *
 * The escape hatch is load-bearing rather than polite: the budget is process-wide, and a backend that
 * legitimately holds a lot of memory would otherwise be stopped repeatedly with no recourse — re-running
 * `infra-kit dev` returns it to the same state.
 */
export const resolveStopBudget = (raw: string | undefined): StopBudget => {
  if (raw === '0' || raw?.toLowerCase() === 'off') {
    return { stopEnabled: false, stopBytes: DEFAULT_STOP_BYTES }
  }

  const parsed = Number(raw)

  if (Number.isInteger(parsed) && parsed > 0) {
    return { stopEnabled: true, stopBytes: parsed }
  }

  return { stopEnabled: true, stopBytes: DEFAULT_STOP_BYTES }
}

/** The CLI's own bundle directory, realpath'd — the exclusion the hook needs to not re-evaluate itself. */
export const selfDistDir = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url))

  return realpathCached(here) ?? here
}

/**
 * Install (or re-point) the resolve hook and start at generation 0. Returns `null` when the runtime has
 * no `registerHooks`, so the caller can say so rather than silently running without invalidation.
 *
 * Idempotent by design: the hook itself is registered at most once per process and subsequent calls
 * re-point its state, because `registerHooks` offers no way to uninstall.
 */
export const installModuleGeneration = (opts: InstallOptions): ModuleGenerationHandle | null => {
  const registerHooks = resolveRegisterHooks()

  if (typeof registerHooks !== 'function') return null

  const current: HookState = {
    busted: new Set(),
    generation: 0,
    root: opts.root,
    selfDist: opts.selfDist,
  }
  const stopBytes = opts.stopBytes ?? DEFAULT_STOP_BYTES
  const stopEnabled = opts.stopEnabled ?? true
  // DERIVED, not chosen. Stating an independent warn threshold would add a second number nothing
  // justifies; half the budget is a relationship, and it needs no defending of its own.
  const warnBytes = stopBytes / 2
  const warnStrideBytes = opts.warnStrideBytes ?? stopBytes / 8
  const sampleRss =
    opts.sampleRss ??
    ((): number => {
      return process.memoryUsage.rss()
    })
  /** Consecutive over-budget samples. Two are required, so one GC-timing spike cannot end a session. */
  let overBudgetStreak = 0
  /** The sample the last warning was issued at — the floor the stride is measured from. */
  let lastWarnedAt = 0

  state = current

  if (!installed) {
    installed = true
    registerHooks({
      resolve: (
        specifier: string,
        context: unknown,
        nextResolve: (s: string, c: unknown) => { url: string },
      ): { url: string } => {
        const result = nextResolve(specifier, context)
        // Read the LIVE state, not the closed-over one: a later install re-points it, and a stale
        // capture would keep busting against a previous session's root.
        const active = state

        if (active === null) return result

        const rewritten = bustUrl(result.url, active)

        return rewritten === null ? result : { ...result, url: rewritten }
      },
    })
  }

  return {
    // Nothing but the generation. Every budget decision lives in `budgetState`, which the runner calls
    // FIRST and acts on BEFORE this runs — so a refusal cannot leave `busted` cleared behind it, and
    // `resolveStaleFiles` can never read a previous generation's set as "nothing stale". Keeping the
    // two apart is what makes that violation unreachable rather than merely avoided.
    bump: (): number => {
      current.generation += 1
      current.busted = new Set()

      return current.generation
    },
    budgetState: (): 'ok' | 'warn' | 'stop' => {
      const sample = sampleRss()

      if (stopEnabled && sample > stopBytes) {
        overBudgetStreak += 1

        if (overBudgetStreak >= 2) return 'stop'
      } else {
        overBudgetStreak = 0
      }

      if (sample >= warnBytes && sample >= lastWarnedAt + warnStrideBytes) {
        lastWarnedAt = sample

        return 'warn'
      }

      return 'ok'
    },
    bustedUnder: (dir: string): boolean => {
      const real = realpathCached(dir) ?? dir

      for (const p of current.busted) {
        if (isUnder(p, real)) return true
      }

      return false
    },
    generation: (): number => {
      return current.generation
    },
  }
}

/** Drop the installed state so a later install starts clean. Tests only — the hook itself stays registered. */
export const resetModuleGenerationForTests = (): void => {
  state = null
  realpathCache.clear()
}
