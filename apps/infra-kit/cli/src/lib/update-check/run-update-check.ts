/**
 * The CHILD half of the auto-update, spawned detached by `maybeAutoUpdate`. It outlives the CLI
 * invocation that started it, so it may take its time and it may replace the binary.
 *
 * WHY IT WAITS FOR THE PARENT TO EXIT — the load-bearing invariant of this whole feature:
 * `scripts/build.js` sets esbuild `splitting: true`, so `dist/cli.js` lazily imports sibling
 * `chunk-*.js` files at runtime (that is how the Ink TUI stays off the fast path). A package manager
 * installing over `dist/` mid-command deletes chunks the parent has not imported yet, and the parent
 * dies on a dynamic import of a file that no longer exists. Waiting for the parent to exit is what
 * makes a silent background install safe rather than a random crash under `infra-kit dev`.
 */
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import process from 'node:process'

import { PACKAGE_NAME, defaultLazyNpmRoot, detectInstallManager, safeRealpath } from 'src/lib/install-manager'
import { packageManagerInstallEnv } from 'src/lib/pm-env'

import { acquireUpdateLock } from './lock'
import { fetchLatestVersion } from './registry'
import { isNewerVersion } from './semver'
import { writeUpdateCache } from './update-cache'
import type { UpdateCache } from './update-cache'
// Static, like every import in this file — see the module doc: on the `installed` path the plugin step
// runs after `dist/` has been replaced, and a lazy `import()` of a chunk from a replaced dist is unsafe.
import { updatePlugin } from './update-plugin'
import type { UpdatePluginDeps } from './update-plugin'

/** How often to re-check whether the parent is gone. */
export const PARENT_POLL_INTERVAL_MS = 200

/**
 * Give up waiting after this long. A long-lived parent (`infra-kit dev` runs for hours) must not leave
 * an immortal child pinned to a stale version: we simply skip this cycle. `lastCheckMs` is already
 * persisted by then, so the next short-lived command re-checks after the normal throttle window.
 */
export const PARENT_WAIT_TIMEOUT_MS = 5 * 60 * 1000

export interface RunUpdateCheckDeps extends UpdatePluginDeps {
  env?: NodeJS.ProcessEnv
  nowMs?: number
  fetchLatest?: (env: NodeJS.ProcessEnv) => Promise<string | null>
  writeCache?: typeof writeUpdateCache
  isProcessAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  /** Monotonic-ish source for the parent-wait deadline. Injected so the timeout is testable without real time. */
  clock?: () => number
  /** `npm root -g` probe. Defaults to the real subprocess; this child is detached, so it can afford one. */
  lazyNpmRoot?: () => string | undefined
  /** Single-flight guard. Returns a release fn, or null when another worker already holds the lock. */
  acquireLock?: () => (() => void) | null
  spawnSync?: typeof spawnSync
  /**
   * The version the user now gets from the `infra-kit` on their PATH. Consulted once, after the install
   * command returns 0, because that exit code is not proof of anything — see {@link readInstalledVersion}.
   */
  installedVersion?: (env: NodeJS.ProcessEnv) => string | null
  /** Realpath of the installed `dist/cli.js`, used to identify the owning package manager. */
  selfRealPath: string
  parentPid?: number
}

/** Bounds the post-install probe; a hung shim must not pin this worker for the parent's 5-minute budget. */
const VERSION_PROBE_TIMEOUT_MS = 15_000

/**
 * Ask the freshly installed CLI what it is, the way the user will: the `infra-kit` bin on PATH.
 *
 * Not `<selfRealPath>/../package.json`. pnpm keeps each version in its own directory
 * (`.pnpm/infra-kit@0.5.1/…`, `global/v11/<hash>/…`) and repoints the shim, so the path THIS worker was
 * launched from keeps reporting the old version forever, while the path the user gets has moved.
 *
 * `--json` doubles as the guard that stops the probe spawning a second updater from inside the first:
 * `autoUpdateSkipReason` returns `json` before anything else runs, and piped stdio fails the tty arm too.
 * Anything short of a parseable version is `null` — a shim that no longer resolves, a bin that crashes on
 * boot, output that is not JSON — and the caller treats every one of those as "not verified".
 */
const readInstalledVersion = (env: NodeJS.ProcessEnv): string | null => {
  const result = spawnSync(PACKAGE_NAME, ['version', '--json'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
    cwd: homedir(),
    env,
    timeout: VERSION_PROBE_TIMEOUT_MS,
    windowsHide: true,
    encoding: 'utf8',
  })

  if (result.error || result.signal || result.status !== 0) return null

  try {
    const parsed: unknown = JSON.parse(result.stdout)
    const version = (parsed as { version?: unknown } | null)?.version

    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

/** Signal 0 performs the permission/existence check without delivering anything. */
const defaultIsProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

const defaultSleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Block until `parentPid` exits or {@link PARENT_WAIT_TIMEOUT_MS} elapses. Returns whether the parent
 * is actually gone — the caller must not install on a timeout.
 */
const waitForParentExit = async (
  parentPid: number,
  deps: Required<Pick<RunUpdateCheckDeps, 'isProcessAlive' | 'sleep' | 'clock'>>,
): Promise<boolean> => {
  const deadline = deps.clock() + PARENT_WAIT_TIMEOUT_MS

  while (deps.clock() < deadline) {
    if (!deps.isProcessAlive(parentPid)) return true

    await deps.sleep(PARENT_POLL_INTERVAL_MS)
  }

  return !deps.isProcessAlive(parentPid)
}

export type UpdateCheckOutcome =
  | 'installed'
  | 'install-failed'
  /** The install command returned 0, yet the `infra-kit` on PATH still does not report `latestVersion`. */
  | 'install-stale'
  | 'up-to-date'
  | 'fetch-failed'
  | 'cannot-self-spawn'
  | 'parent-still-running'
  | 'parent-unknown'
  | 'already-running'

/**
 * Fetch, decide, and (when safe) install — returning WHY it did what it did so tests can distinguish
 * "no update" from "could not install". Never throws.
 *
 * `lastCheckMs` is written from the ATTEMPT, before any early return. If it were written only on
 * success, an offline user would re-spawn a doomed child on every single command.
 *
 * @example
 * await runUpdateCheck('0.1.130', { selfRealPath: '/usr/local/lib/node_modules/infra-kit/dist/cli.js' })
 * // => 'installed'
 */
export const runUpdateCheck = async (currentVersion: string, deps: RunUpdateCheckDeps): Promise<UpdateCheckOutcome> => {
  const acquireLock = deps.acquireLock ?? acquireUpdateLock
  const writeCache = deps.writeCache ?? writeUpdateCache

  // Single-flight. N shells launched at once all read the same stale cache and each spawns a worker;
  // the cache throttle cannot stop them because it is only written after the fetch returns. Without
  // this, a pending update means N concurrent `npm install -g` over one global directory.
  const release = acquireLock()

  if (!release) return 'already-running'

  // Remember the locked function's final cache write so the plugin step can stamp its own outcome
  // onto it instead of reading the file back (a holder, not a `let`: TypeScript cannot see a closure
  // assignment and would narrow a `let` to its initial `null`).
  const written: { last: UpdateCache | null } = { last: null }
  const recordingWriteCache: typeof writeUpdateCache = (cache) => {
    written.last = cache
    writeCache(cache)
  }

  try {
    const outcome = await runUpdateCheckLocked(currentVersion, { ...deps, writeCache: recordingWriteCache })

    // The plugin step runs AFTER the locked function has returned, on EVERY outcome — `up-to-date`
    // included, which is what makes a plugin-only bump deliverable — and never inside its early-return
    // chain or ahead of the fetch. Placement is about the throttle: `lastCheckMs` is stamped only by
    // `finish()` after the fetch, and the lock is reaped as stale at `LOCK_STALE_MS` (30 min). A
    // `claude` probe (up to 120 s) plus an update ahead of the fetch would delay that stamp on every
    // run and eat into the stale window on a slow link. Here the stamp is written, the lock is still
    // held (single-flight), and the step has a bounded budget of its own. "Every outcome" has one
    // exception, decided by the cache the locked function wrote rather than by name: see
    // `pluginStepWithheld`.
    recordPluginUpdate(deps, written.last, currentVersion, writeCache)

    return outcome
  } finally {
    release()
  }
}

/**
 * Must the plugin step stand down because the CLI is behind? Reads the `latestVersion` the locked
 * function wrote, not its outcome name: "a newer CLI exists and this run did not install it" is
 * exactly what a non-null value newer than `currentVersion` encodes.
 *
 * That covers `cannot-self-spawn` (`:300`), `parent-unknown` (`:305`), `parent-still-running` (`:326`),
 * `install-failed` (`:353`) and `install-stale` (`:364`) — each leaves the newer version in the cache —
 * and any outcome added later that does the same, without this list needing to know. `installed` clears
 * `latestVersion` (`:367`) and `up-to-date` writes a non-newer one (`:282`), so both still advance the
 * plugin and a plugin-only bump keeps delivering; `fetch-failed` writes null (`:280`) and cannot be
 * gated — the plugin advances, as before; `already-running` never reaches the wrapper.
 *
 * @example
 * pluginStepWithheld('0.8.0', '0.7.2') // => true
 * pluginStepWithheld(null, '0.7.2') // => false
 */
// Without this a Homebrew or unknown-location machine advances the plugin on every run while its CLI
// waits for a hand-typed update, and once a repo serves infra-kit through the plugin, plugin N+1 spawns
// CLI N — skills citing tool names that server does not serve, a `doctor` that fails on a key that is
// meant to be absent, and a `setup` that re-adds it to a tracked `.mcp.json`.
export const pluginStepWithheld = (latestVersion: string | null, currentVersion: string): boolean => {
  return latestVersion !== null && isNewerVersion(latestVersion, currentVersion)
}

/**
 * Run the plugin step and write its outcome beside the CLI outcome. Never throws: `updatePlugin` is
 * total, and a cache write that fails here has nowhere left to record itself — the CLI outcome the
 * worker already produced is worth more than a plugin diagnostic.
 */
const recordPluginUpdate = (
  deps: UpdatePluginDeps,
  base: UpdateCache | null,
  currentVersion: string,
  writeCache: typeof writeUpdateCache,
): void => {
  const outcome = pluginStepWithheld(base?.latestVersion ?? null, currentVersion)
    ? 'skipped-cli-stale'
    : updatePlugin(deps)
  const checkedMs = (deps.clock ?? Date.now)()

  // `finish()` writes on every path the locked function returns through, so `base` is only null if that
  // invariant breaks — and then there is no throttle stamp to attach the outcome to either.
  if (base === null) return

  try {
    writeCache({ ...base, plugin: { outcome, checkedMs } })
  } catch {
    // Recorded nowhere, deliberately: see the function doc.
  }
}

const runUpdateCheckLocked = async (currentVersion: string, deps: RunUpdateCheckDeps): Promise<UpdateCheckOutcome> => {
  const env = deps.env ?? process.env
  const nowMs = deps.nowMs ?? Date.now()
  const fetchLatest = deps.fetchLatest ?? fetchLatestVersion
  const writeCache = deps.writeCache ?? writeUpdateCache
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive
  const sleep = deps.sleep ?? defaultSleep
  const clock = deps.clock ?? Date.now
  const lazyNpmRoot = deps.lazyNpmRoot ?? defaultLazyNpmRoot
  const spawn = deps.spawnSync ?? spawnSync
  const installedVersion = deps.installedVersion ?? readInstalledVersion

  const latestVersion = await fetchLatest(env)

  // Every path below writes the cache EXACTLY once, and always with `lastCheckMs: nowMs` — the throttle
  // burns on the ATTEMPT, never on success. If it burned only on success, an offline user would respawn
  // a doomed child on every command.
  const finish = (
    outcome: UpdateCheckOutcome,
    cache: Omit<UpdateCache, 'lastCheckMs' | 'outcome'>,
  ): UpdateCheckOutcome => {
    // `outcome` is recorded on EVERY write: it is what lets a reader (human or `isStale`) tell a settled
    // `installed`/`up-to-date` from a transient `fetch-failed`, all of which otherwise write an identical
    // `{latestVersion:null}`. See `UpdateCache.outcome`.
    writeCache({ lastCheckMs: nowMs, ...cache, outcome })

    return outcome
  }

  if (latestVersion === null) return finish('fetch-failed', { latestVersion: null, updateCommand: null })
  if (!isNewerVersion(latestVersion, currentVersion))
    return finish('up-to-date', { latestVersion, updateCommand: null })

  // `lazyNpmRoot` is what makes the COMMON case work: a plain `npm i -g infra-kit` leaves no
  // `npm_config_prefix` in the user's shell, so every cheap matcher misses and detection would report
  // `unknown` / `canSelfSpawn: false`. Without this probe the auto-update would silently degrade to a
  // notice for the majority of installs. The subprocess is affordable here and nowhere else.
  // `version` pins the spec to what we just fetched: a `@latest` command is resolved by the package
  // manager from ITS cache, which pnpm does not revalidate — see `pinSpec` in install-manager.
  const { canSelfSpawn, updateCommand } = detectInstallManager({
    selfRealPath: deps.selfRealPath,
    env,
    realpath: safeRealpath,
    lazyNpmRoot,
    version: latestVersion,
  })

  // Homebrew relinks its prefix and may prompt; an unknown location means the command is a guess.
  // Both stay the user's call, so record the command for `maybeAutoUpdate` to print next invocation.
  if (!canSelfSpawn) return finish('cannot-self-spawn', { latestVersion, updateCommand })

  // Fail SAFE. Without a parent to outlive we cannot know whether a live CLI is still lazily importing
  // `chunk-*.js` out of the `dist/` we are about to replace, so we skip the cycle rather than install
  // blind. The real spawn always passes `--parent-pid`; only a hand-run worker lands here.
  if (deps.parentPid == null) return finish('parent-unknown', { latestVersion, updateCommand: null })

  // Burn the throttle NOW, before the two unbounded-ish operations below (a 5-minute parent wait, then an
  // install of no fixed duration). Everything after this point can take many minutes, and until the cache
  // is written it still reads as STALE — so every new shell in that window spawns its own worker, and the
  // single-flight lock becomes the only thing standing between them and concurrent `npm install -g` runs
  // over one global directory. The lock is reaped by mtime (LOCK_STALE_MS), so a slow enough install has
  // its live lock stolen and we get exactly the pile-up the lock exists to prevent.
  //
  // Writing the stamp here makes the throttle — not the lock — the primary guard, which is what the cache
  // was always for. `finish()` overwrites this with the real outcome; this is the only path that writes
  // the cache twice, and deliberately so.
  //
  // `outcome: 'installing'` marks a mid-install checkpoint: if the worker is killed here (machine sleeps,
  // SIGKILL) and never reaches `finish()`, this stamp is what the next run reads, and the cache says so
  // rather than looking like a settled result. It does not shorten the next window — see CHECK_INTERVAL_MS.
  writeCache({ lastCheckMs: nowMs, latestVersion, updateCommand: null, outcome: 'installing' })

  const parentGone = await waitForParentExit(deps.parentPid, { isProcessAlive, sleep, clock })

  // A long-lived parent (`infra-kit dev`) outlasted the wait. Stay silent and retry next window.
  if (!parentGone) return finish('parent-still-running', { latestVersion, updateCommand: null })

  // `shell` on win32 so the `.cmd` shims npm/pnpm/yarn ship as global bins resolve.
  //
  // `packageManagerInstallEnv` strips the inherited npx/dlx markers — which otherwise make
  // pnpm/portless-style tools believe they were invoked via `npx`/`dlx` and refuse to run — while KEEPING
  // `npm_config_prefix` and `npm_config_registry`. Using the blunt `withoutPackageManagerEnv` here was a
  // bug: it also erased the prefix that `detectInstallManager` had just matched on, so we would detect a
  // global install at prefix P and then install into the default prefix instead — silently, forever. See
  // the module doc on `packageManagerInstallEnv`.
  //
  // `cwd` is pinned to the home directory, and this is a SECURITY control, not tidiness: npm resolves
  // `registry=` from an `.npmrc` on disk relative to the cwd. Inheriting the caller's cwd would let any
  // repo containing a hostile `.npmrc` silently redirect this unattended `install -g` to an attacker's
  // registry, executing its lifecycle scripts. Stripping `npm_config_registry` from the env does NOT
  // close that hole, because the redirect lives in a file, not the environment.
  const result = spawn(updateCommand[0] as string, updateCommand.slice(1), {
    stdio: 'ignore',
    shell: process.platform === 'win32',
    cwd: homedir(),
    env: packageManagerInstallEnv(env),
    windowsHide: true,
  })

  // Record the manual command so a persistently failing silent install (EACCES on a root-owned global
  // dir, say) still surfaces ONE actionable line, instead of failing invisibly forever.
  if (result.error || result.signal || result.status !== 0) {
    return finish('install-failed', { latestVersion, updateCommand })
  }

  // Exit 0 is the package manager saying it is content, not that anything changed. `pnpm add -g
  // infra-kit@latest` resolved the tag from its own stale metadata cache, reinstalled the version already
  // present, and returned 0 — and this function recorded `installed`, cleared `latestVersion`, and
  // repeated the same no-op every cycle. The spec is pinned now, but the check that would have SHOWN
  // that bug is this one: ask the binary the user actually runs. A mismatch keeps `latestVersion` and the
  // command in the cache, so the parent prints the manual line instead of staying silent.
  const nowInstalled = installedVersion(env)

  if (nowInstalled !== latestVersion) return finish('install-stale', { latestVersion, updateCommand })

  // Verified: clear `latestVersion` so the next run does not re-notify.
  return finish('installed', { latestVersion: null, updateCommand: null })
}
