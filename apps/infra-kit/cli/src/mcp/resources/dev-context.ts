import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** Repo-relative dev-context fragment directory the `infra-kit dev` runner writes into. */
const DEV_CONTEXT_DIR = path.join('.infra-kit', 'dev-context')

/** The state directory that holds {@link DEV_CONTEXT_DIR}, used as an up-tree fallback anchor. */
const STATE_DIR = '.infra-kit'

/**
 * Search upward from `start` for `relative`, returning the first hit or `undefined`. Mirrors the
 * `infra-kit/vite` helper's own `findUp`, because the MCP server is long-lived and may be rooted at
 * any nested package dir — the fragments live at the repo root's `.infra-kit/dev-context`, not the cwd.
 */
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

/**
 * Locate the dev-context fragment directory for `cwd`: prefer an existing `.infra-kit/dev-context` found
 * up-tree, else derive it from an up-tree `.infra-kit` (which may exist before the runner has written any
 * fragment), else `undefined` when neither anchor is present.
 */
const resolveFragmentDir = (cwd: string): string | undefined => {
  const existing = findUp(cwd, DEV_CONTEXT_DIR)

  if (existing) return existing

  const state = findUp(cwd, STATE_DIR)

  return state ? path.join(state, 'dev-context') : undefined
}

/** One backend the `infra-kit dev` runner has recorded as up, plus advisory staleness metadata. */
export interface DevContextApp {
  /** App folder name the fragment is keyed by (`<app>.json`). */
  app: string
  /** The app's package name (what the vite helper's `readLocalSet` matches on). */
  package: string
  /** The ACTUAL bound port — the runner is the binder, so this is authoritative. */
  port: number
  /** The registered portless hostname the runner published for this backend. */
  alias: string
  /** The authoritative local origin the vite helper proxies to. */
  origin: string
  /** Release slug the runner recorded (empty when it derived none). */
  release: string
  /** Writer PID — advisory only; NOT probed for liveness here. */
  pid: number
  /** Epoch ms the runner stamped into the fragment. */
  writtenAt: number
  /** The fragment file's mtime in epoch ms — the freshness signal a consumer should judge staleness by. */
  mtimeMs: number
  /** How old the fragment is (now − mtime), in ms. Advisory: a live backend refreshes this on each write. */
  ageMs: number
}

/**
 * The dev-context resource payload. Read-only and side-effect free: this reflects what `infra-kit dev`
 * last wrote to disk, never a live probe. `session: 'none'` (with an empty `apps`) is the normal,
 * non-error state when no dev session has written any fragment — an absent session is not a failure.
 */
export interface DevContextSnapshot {
  /** `'active'` iff at least one readable fragment was found, else `'none'`. */
  session: 'active' | 'none'
  /** The resolved fragment directory, or `undefined` when no `.infra-kit` anchor exists up-tree. */
  fragmentDir: string | undefined
  /** Epoch ms this snapshot was read, so a consumer can compute freshness against {@link DevContextApp.mtimeMs}. */
  readAt: number
  /** Every backend the runner currently records as up, sorted by app name. Empty when the session is `none`. */
  apps: DevContextApp[]
}

/** Coerce an unknown parsed fragment field to a number, defaulting to `0` when absent/non-numeric. */
const num = (value: unknown): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Coerce an unknown parsed fragment field to a string, defaulting to `''`. */
const str = (value: unknown): string => {
  return typeof value === 'string' ? value : ''
}

/** Parse one `<app>.json` fragment into a {@link DevContextApp}, or `null` when it is unreadable/not JSON. */
const readFragment = (fragmentDir: string, file: string, now: number): DevContextApp | null => {
  const full = path.join(fragmentDir, file)

  try {
    const stat = fs.statSync(full)
    const parsed: unknown = JSON.parse(fs.readFileSync(full, 'utf-8'))

    if (typeof parsed !== 'object' || parsed === null) return null

    const fragment = parsed as Record<string, unknown>

    return {
      app: file.replace(/\.json$/, ''),
      package: str(fragment.package),
      port: num(fragment.port),
      alias: str(fragment.alias),
      origin: str(fragment.origin),
      release: str(fragment.release),
      pid: num(fragment.pid),
      writtenAt: num(fragment.writtenAt),
      mtimeMs: Math.round(stat.mtimeMs),
      ageMs: Math.max(0, Math.round(now - stat.mtimeMs)),
    }
  } catch {
    // A half-written, deleted-mid-read, or non-JSON fragment is skipped rather than failing the whole
    // read — the resource stays advisory and never throws on a transient runner write.
    return null
  }
}

/**
 * Read the dev-context fragments `infra-kit dev` last wrote for the repo containing `cwd`.
 *
 * Strictly read-only and never throws: a missing anchor, a missing fragment dir, or an unreadable
 * fragment all resolve to a clean snapshot (`session: 'none'` when nothing readable was found). Freshness
 * is reported via each fragment's `mtimeMs`/`ageMs`; no liveness is asserted that was not observed on disk.
 */
export const readDevContext = (cwd: string = process.cwd()): DevContextSnapshot => {
  const now = Date.now()
  const fragmentDir = resolveFragmentDir(cwd)

  if (!fragmentDir || !fs.existsSync(fragmentDir)) {
    return { session: 'none', fragmentDir, readAt: now, apps: [] }
  }

  let files: string[]

  try {
    files = fs.readdirSync(fragmentDir).filter((file) => {
      return file.endsWith('.json')
    })
  } catch {
    return { session: 'none', fragmentDir, readAt: now, apps: [] }
  }

  const apps = files
    .map((file) => {
      return readFragment(fragmentDir, file, now)
    })
    .filter((app): app is DevContextApp => {
      return app !== null
    })
    .sort((a, b) => {
      return a.app.localeCompare(b.app)
    })

  return { session: apps.length > 0 ? 'active' : 'none', fragmentDir, readAt: now, apps }
}
