/**
 * What `infra-kit dev --watch` can and cannot actually hot-reload.
 *
 * The backends run IN-PROCESS, and a watch restart re-`import()`s each serverless handler ENTRY module
 * with a fresh cache-busting query ({@link file://./serverless-local-run.ts}). Node's ESM module registry
 * is keyed by fully-resolved URL and lives for the whole process, so those entry modules are the ONLY
 * ones ever re-evaluated: everything they import — shared `packages/*` and the app's own service/util
 * modules — stays frozen at the version first loaded. Closing and rebinding fastify does not change that;
 * only a new process does.
 *
 * So a dist change is hot-reloadable exactly when the changed file IS one of that app's handler entry
 * files. This module answers that question so the runner can stop printing `✅ Restarted` over a reload
 * that provably did not happen — the unearned green that sends people hunting for "where the stale copy
 * is loaded from" instead of just restarting.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Memoised entry set for one app, invalidated when its `serverless.yml` mtime moves. */
interface CachedEntries {
  entries: Set<string>
  mtimeMs: number
}

const entryCache = new Map<string, CachedEntries>()

/** Drop every memoised entry set. Tests only — a session never needs it (the cache self-invalidates). */
export const resetHandlerEntryCache = (): void => {
  entryCache.clear()
}

/**
 * Parse `serverless.yml` into the absolute paths of the compiled handler files it declares.
 *
 * The `handler` string is `<filepath>.<exportName>` (e.g. `dist/handler.ping`), and the runtime imports
 * `<appPath>/<filepath>.js` — so the `split('.')` here mirrors what `ServerlessLocalRun` actually loads.
 * Mirroring it is the point: if the two ever disagreed, this module would vouch for a file the runtime
 * never re-imports. Unreadable or malformed YAML yields an empty set, which is the conservative answer
 * (nothing is hot-reloadable → the runner warns rather than claiming a reload it cannot back).
 */
const parseHandlerEntries = (ymlPath: string, appPath: string): Set<string> => {
  const entries = new Set<string>()

  let data: { functions?: Record<string, { handler?: string } | null> } | null

  try {
    data = parseYaml(fs.readFileSync(ymlPath, 'utf8')) as typeof data
  } catch {
    return entries
  }

  for (const funcDef of Object.values(data?.functions ?? {})) {
    const handler = funcDef?.handler

    if (typeof handler !== 'string') continue

    const filepath = handler.split('.')[0] ?? ''

    if (filepath === '') continue

    entries.add(path.normalize(path.join(appPath, `${filepath}.js`)))
  }

  return entries
}

/**
 * Absolute paths of `appPath`'s compiled handler entry files, memoised on its `serverless.yml` mtime.
 *
 * The mtime key (rather than a plain memo) keeps a route added mid-session honest: the runner re-reads
 * once the file changes. A missing `serverless.yml` returns an empty set — the app declares no entries we
 * can vouch for, so nothing counts as hot-reloadable.
 *
 * @example
 * readHandlerEntries('/repo/apps/omega/api') // => Set { '/repo/apps/omega/api/dist/handler.js' }
 */
export const readHandlerEntries = (appPath: string): Set<string> => {
  const ymlPath = path.join(appPath, 'serverless.yml')

  let mtimeMs: number

  try {
    mtimeMs = fs.statSync(ymlPath).mtimeMs
  } catch {
    return new Set()
  }

  const cached = entryCache.get(appPath)

  if (cached && cached.mtimeMs === mtimeMs) return cached.entries

  const entries = parseHandlerEntries(ymlPath, appPath)

  entryCache.set(appPath, { entries, mtimeMs })

  return entries
}

/**
 * Will a watch restart actually pick up this change? True only when the changed file IS a handler entry
 * of `appPath` — the one module the restart re-imports. Every other dist file (a service the handler
 * imports, a shared package) answers `false`: the restart runs, and Node keeps serving the copy already
 * in its registry.
 *
 * @example
 * isHotReloadableChange('/repo/apps/omega/api/dist/handler.js', '/repo/apps/omega/api')  // => true
 * isHotReloadableChange('/repo/apps/omega/api/dist/services/x.js', '/repo/apps/omega/api') // => false
 */
export const isHotReloadableChange = (changedPath: string, appPath: string): boolean => {
  return readHandlerEntries(appPath).has(path.normalize(changedPath))
}

/** How many stale file names a warning names before collapsing the rest into a count. */
const MAX_NAMED_STALE = 2

/**
 * Render stale file paths for a one-line warning: up to {@link MAX_NAMED_STALE} basenames, then
 * `+N more`. Basenames because the full dist path is long, noisy, and the developer already knows
 * which file they just saved.
 *
 * @example
 * describeStaleFiles(['/a/dist/x.js', '/a/dist/y.js', '/a/dist/z.js']) // => 'x.js, y.js (+1 more)'
 */
export const describeStaleFiles = (files: string[]): string => {
  const named = files.slice(0, MAX_NAMED_STALE).map((f) => {
    return path.basename(f)
  })
  const rest = files.length - named.length

  return rest > 0 ? `${named.join(', ')} (+${rest} more)` : named.join(', ')
}
