import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * The dev-context fragment directory the running dev server writes to. This MIRRORS
 * `DevServerRunner.devContextDir` (see `src/dev/dev-server.ts` — `path.join(process.cwd(), '.infra-kit',
 * 'dev-context')`): the runner writes ONE `<app>.json` fragment per app it starts, and this reader reads
 * exactly those. Kept as a tiny standalone helper (not imported from the dev-server module) so `dev-status`
 * stays a light, side-effect-free read that never pulls the fastify/chokidar dev stack into its graph.
 */
export const getDevContextDir = (cwd: string = process.cwd()): string => {
  return path.join(cwd, '.infra-kit', 'dev-context')
}

/**
 * Reader-side view of one `<app>.json` fragment (the writer's `DevContextFragment`), plus the fragment
 * file's on-disk mtime — the AUTHORITATIVE freshness signal. Every field is defensively coerced: a
 * fragment can be half-written (the runner writes tmp-then-rename, but a foreign process or an old wire
 * version could still leave a partial or oddly-typed file), and a status read must never throw on one.
 */
export interface DevContextRecord {
  /** App folder name — the fragment filename without its `.json` suffix. */
  app: string
  /** The app package name the vite helper reads to decide a `local` route. */
  package: string
  /** The ACTUAL bound port the dev server is listening on (the writer is the binder). */
  port: number
  /** PID of the dev-server process that wrote the fragment (ownership / staleness metadata). */
  pid: number
  /** Registered portless hostname for the app. */
  alias: string
  /** Authoritative local origin the vite helper proxies to. */
  origin: string
  /** Release slug the runner recorded for this worktree. */
  release: string
  /** Epoch ms the runner self-reported writing the fragment (writer clock — may lie; prefer mtime). */
  writtenAt: number
  /** Filesystem mtime of the fragment (epoch ms) — the authoritative freshness signal. */
  fragmentMtimeMs: number
}

const asString = (value: unknown): string => {
  return typeof value === 'string' ? value : ''
}

const asNumber = (value: unknown): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Read every dev-context fragment currently on disk, sorted by app name. Returns `[]` — never throws —
 * when there is no dev session: a missing directory, an empty directory, an unreadable or corrupt fragment
 * all resolve to "not present", which the caller reports as a clean empty status, not an error.
 *
 * Purely reads: it does a `readdirSync` + `statSync` + `readFileSync` per fragment and nothing else. It
 * starts no process and opens no socket, so it cannot bring a dev server up.
 */
export const readDevContextFragments = (cwd?: string): DevContextRecord[] => {
  const dir = getDevContextDir(cwd)

  let entries: string[]

  try {
    entries = fs.readdirSync(dir)
  } catch {
    // No dev-context dir at all → no active dev session.
    return []
  }

  const records: DevContextRecord[] = []

  for (const name of entries) {
    // Only committed fragments. The runner writes `<app>.json.<pid>.tmp` before renaming, so a `.json`
    // suffix excludes the in-flight temp files by construction.
    if (!name.endsWith('.json')) continue

    const full = path.join(dir, name)

    let mtimeMs: number
    let raw: string

    try {
      const stat = fs.statSync(full)

      if (!stat.isFile()) continue

      mtimeMs = stat.mtimeMs
      raw = fs.readFileSync(full, 'utf-8')
    } catch {
      continue
    }

    let parsed: unknown

    try {
      parsed = JSON.parse(raw)
    } catch {
      // Half-written or non-JSON fragment — skip it rather than fail the whole read.
      continue
    }

    if (parsed === null || typeof parsed !== 'object') continue

    const fragment = parsed as Record<string, unknown>

    records.push({
      app: name.replace(/\.json$/, ''),
      package: asString(fragment.package),
      port: asNumber(fragment.port),
      pid: asNumber(fragment.pid),
      alias: asString(fragment.alias),
      origin: asString(fragment.origin),
      release: asString(fragment.release),
      writtenAt: asNumber(fragment.writtenAt),
      fragmentMtimeMs: mtimeMs,
    })
  }

  return records.sort((a, b) => {
    return a.app.localeCompare(b.app)
  })
}
