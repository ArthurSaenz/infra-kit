import type { InfraKitDevOptions, InfraKitViteProxy } from '@slip-stream-kit/config/vite'
import { infraKitDev } from '@slip-stream-kit/config/vite'
import fs from 'node:fs'
import path from 'node:path'

/** Repo-relative dev-context fragment directory the `infra-kit dev` runner writes into. */
const DEV_CONTEXT_DIR = path.join('.infra-kit', 'dev-context')

/** The state directory that holds {@link DEV_CONTEXT_DIR} — watched too, so a first fragment is seen. */
const STATE_DIR = '.infra-kit'

/** The package's own config: editing `dev.proxy` must take effect without a manual restart. */
const PACKAGE_CONFIG_FILE = 'infra-kit.config.ts'

/** Coalesce the burst of writes a runner makes when it brings several packages up at once. */
const DEBOUNCE_MS = 150

/**
 * A dummy `port` passed to the re-resolve. Only `proxy` is read from the result, and an omitted port
 * makes the helper probe (bind + release) a fresh free one — a pointless side effect to repeat on every
 * fragment write. Any number suppresses it.
 */
const PROBE_PORT = 1

/** Search upward from `start` for `relative`, returning the first hit or undefined. */
const findUp = (start: string, relative: string): string | undefined => {
  let dir = path.resolve(start)

  for (;;) {
    const candidate = path.join(dir, relative)

    if (fs.existsSync(candidate)) return candidate

    const parent = path.dirname(dir)

    if (parent === dir) return undefined

    dir = parent
  }
}

/** The paths whose changes can alter this package's proxy map. */
export interface WatchTargets {
  /** The dev-context fragment dir, or `undefined` when no repo root could be located. */
  fragmentDir: string | undefined
  /** The dir to watch so the fragment dir is seen even when it does not exist yet. */
  stateDir: string | undefined
  /** This package's own `infra-kit.config.ts` (watched whether or not it exists yet). */
  configFile: string
}

/**
 * Where to watch, resolved from the package dir.
 *
 * The fragment dir is found by searching upward — but it may legitimately NOT EXIST yet: a frontend
 * started before any backend has none, and that is exactly the case the live re-resolve exists to fix.
 * So fall back to the `.infra-kit` state dir (also searched upward), then to the git root, and let the
 * watcher pick up the directory when the runner creates it. With no repo root at all there is nothing
 * to watch and the plugin stays inert.
 */
export const resolveWatchTargets = (cwd: string): WatchTargets => {
  const configFile = path.join(cwd, PACKAGE_CONFIG_FILE)
  const existing = findUp(cwd, DEV_CONTEXT_DIR)

  if (existing) return { fragmentDir: existing, stateDir: path.dirname(existing), configFile }

  const state = findUp(cwd, STATE_DIR)

  if (state) return { fragmentDir: path.join(state, 'dev-context'), stateDir: state, configFile }

  const gitDir = findUp(cwd, '.git')

  if (!gitDir) return { fragmentDir: undefined, stateDir: undefined, configFile }

  const root = path.dirname(gitDir)

  return { fragmentDir: path.join(root, DEV_CONTEXT_DIR), stateDir: path.join(root, STATE_DIR), configFile }
}

/** Order-independent, field-stable digest of a resolved proxy map. */
export const proxySignature = (proxy: InfraKitViteProxy): string => {
  const entries = Object.entries(proxy)
    .map(([routePath, entry]) => {
      const fields = Object.entries(entry as unknown as Record<string, unknown>).sort(([a], [b]) => {
        return a < b ? -1 : 1
      })

      return [routePath, fields] as const
    })
    .sort(([a], [b]) => {
      return a < b ? -1 : 1
    })

  return JSON.stringify(entries)
}

/**
 * The slice of `ViteDevServer` this module needs. Narrowed to an interface so the watch loop is
 * driveable by a fake in tests — booting a real vite dev server to assert "it restarted once" would
 * test vite, not this.
 */
export interface RestartableServer {
  watcher: {
    add: (target: string) => void
    on: (event: 'add' | 'change' | 'unlink' | 'addDir', listener: (file: string) => void) => void
  }
  restart: () => Promise<void>
  warn: (message: string) => void
}

export interface WatchDevContextArgs {
  server: RestartableServer
  /** The package dir whose config + proxy are resolved (the plugin's `cwd`). */
  cwd: string
  /** The options the plugin was constructed with, re-applied on every re-resolve. */
  options: InfraKitDevOptions
  /** The signature of the proxy map vite is currently serving (taken in the `config` hook). */
  current: string
}

/**
 * Re-resolve the proxy on every dev-context write, and restart vite when — and ONLY when — the resolved
 * proxy actually changed.
 *
 * This is the whole reason the plugin exists as a plugin. `infraKitDev()` resolves once, while vite is
 * computing its config, so a backend started AFTER the frontend can never flip its route from `cloud` to
 * `local`: the answer was already baked. Watching the fragments closes that, and a `local → cloud`
 * demotion (a backend that died) heals the same way.
 *
 * The signature compare is not an optimisation, it is the loop guard. The runner rewrites its fragments
 * on every restart of its own (fresh `pid`, fresh `writtenAt`) and writes a fragment for THIS UI too, so
 * a watcher that restarted on any write would restart on writes caused by its own restart. Comparing the
 * resolved PROXY — the only thing a restart would change — makes those writes inert by construction.
 */
export const watchDevContext = (args: WatchDevContextArgs): { dispose: () => void } => {
  const { server, cwd, options, current } = args
  const { fragmentDir, stateDir, configFile } = resolveWatchTargets(cwd)

  if (!fragmentDir || !stateDir) return { dispose: () => {} }

  let signature = current
  let timer: NodeJS.Timeout | undefined

  const recompute = async (): Promise<void> => {
    let proxy: InfraKitViteProxy

    try {
      proxy = (await infraKitDev({ ...options, cwd, command: 'serve', port: PROBE_PORT })).proxy
    } catch (error) {
      // A half-written fragment, or a `dev.proxy` edit mid-save, resolves to an error. It is transient by
      // nature — the next write re-runs this — so warn and keep serving the proxy we already have rather
      // than tearing the dev server down over it.
      server.warn(`[infra-kit] dev-context changed but the proxy could not be re-resolved: ${String(error)}`)

      return
    }

    const next = proxySignature(proxy)

    if (next === signature) return

    signature = next
    await server.restart()
  }

  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      void recompute()
    }, DEBOUNCE_MS)
  }

  const isRelevant = (file: string): boolean => {
    return file === configFile || file === fragmentDir || file.startsWith(fragmentDir + path.sep)
  }

  server.watcher.add(stateDir)
  server.watcher.add(configFile)

  for (const event of ['add', 'change', 'unlink', 'addDir'] as const) {
    server.watcher.on(event, (file: string) => {
      if (isRelevant(file)) schedule()
    })
  }

  return {
    dispose: () => {
      clearTimeout(timer)
    },
  }
}
