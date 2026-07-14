/**
 * Per-service log files for `infra-kit dev`.
 *
 * Replaces the single shared `<cacheRoot>/<session>/logs.txt`, which was written through TWO handles —
 * a buffered `fs.createWriteStream` (the turbo tee) and a sync `fs.appendFileSync` (everything else) —
 * so line order was never deterministic. Worse, `--cmux` spawns N `infra-kit dev` processes that all
 * INHERIT the same `INFRA_KIT_SESSION`, so N processes appended to one file through 2N handles. The
 * `<pid>` path segment makes that collision structurally impossible; one fd per service kills the rest.
 *
 * Writes are `fs.writeSync` on a long-lived fd, NOT a `WriteStream`. That is deliberate: a stream's
 * pending buffer is lost on `process.exit()` (an exit handler can only run sync code), which would drop
 * the tail of the log — precisely the lines anyone reads a crash log for. A held fd + `writeSync` is
 * durable by construction, so there is no flush to forget and no second handle to race.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { INFRA_KIT_SESSION_VAR, getCacheRoot } from 'src/lib/constants'

import type { LogLevel } from './render.js'

/**
 * The un-patched `process.stdout.write`, reached through the PROTOTYPE rather than captured off the
 * instance at module load.
 *
 * A module-load capture is only order-immune if nothing patched stdout before this file was evaluated —
 * an assumption no import graph can guarantee. A monkeypatch installs an OWN property on the stream
 * instance, so resolving `write` from the prototype chain steps over it regardless of import order.
 * This is the panel's bypass: it must reach the terminal even while the interceptor owns `process.stdout`.
 */
const protoWrite = (Object.getPrototypeOf(process.stdout) as { write: NodeJS.WriteStream['write'] }).write

/** Write straight to the real stdout, bypassing any patch installed on the stream instance. */
export const rawStdoutWrite = (chunk: string): boolean => {
  return protoWrite.call(process.stdout, chunk)
}

/**
 * The same bypass for stderr. Separate from {@link rawStdoutWrite} because they are different fds:
 * echoing stderr through stdout would send it to the terminal under `dev 2>boot.log` and leave the
 * redirect empty — the caller asked for stderr on a file, and we would have quietly moved it.
 */
export const rawStderrWrite = (chunk: string): boolean => {
  return (Object.getPrototypeOf(process.stderr) as { write: NodeJS.WriteStream['write'] }).write.call(
    process.stderr,
    chunk,
  )
}

/** True when something has already monkeypatched `process.stdout.write` as an own property. */
export const hasForeignStdoutPatch = (): boolean => {
  return Object.getOwnPropertyDescriptor(process.stdout, 'write') != null
}

/**
 * A `process.stdout` stand-in whose `write` goes straight to the real terminal, stepping over any patch
 * the output interceptor has installed. THIS is what the status panel must paint through.
 *
 * Hand the panel the raw `process.stdout` instead and its frames are quietly filed into a log file
 * rather than drawn — the screen simply stays blank, with no error and no failing test. That black hole,
 * not a stack overflow, is the failure mode this exists to prevent.
 *
 * Every other property (`columns`, `rows`, `isTTY`, `on('resize')`) is forwarded LIVE to the real
 * stream, so a resize still reaches the renderer.
 */
export const panelStream = (): NodeJS.WriteStream => {
  return new Proxy(process.stdout, {
    get(target, property, receiver) {
      if (property === 'write') {
        return (chunk: unknown): boolean => {
          return rawStdoutWrite(String(chunk))
        }
      }

      const value = Reflect.get(target, property, receiver) as unknown

      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

/** Running totals for one service row on the status panel. Bumped from DECLARED level, never from content. */
export interface ServiceStats {
  errors: number
  warns: number
  /** Epoch ms of the most recent error, or `null` when the service has never errored. */
  lastErrorAt: number | null
}

const emptyStats = (): ServiceStats => {
  return { errors: 0, warns: 0, lastErrorAt: null }
}

/**
 * Collapse an untrusted string into ONE safe path segment, or `null` when nothing survives.
 *
 * Split-and-rejoin rather than replace-then-trim: it collapses runs, drops leading and trailing
 * separators by construction, and has no backtracking quantifier to be super-linear about. Dots are NOT
 * in the allow-set, so the result is structurally incapable of being `..` or of holding a separator —
 * `path.join(root, safeSegment(x))` cannot leave `root` for any input.
 *
 * Used for BOTH halves of the path. Hardening the file name while leaving the directory unhardened was
 * the wrong half to protect: the directory is the root `gcOldLogDirs` walks with a recursive delete.
 */
const safeSegment = (raw: string): string | null => {
  const safe = raw
    .split(/\W+/)
    .filter((part) => {
      return part !== ''
    })
    .join('-')

  return safe === '' ? null : safe
}

/**
 * Session log root: `<cacheRoot>/<INFRA_KIT_SESSION>/dev/<pid>/`.
 *
 * The `<pid>` segment is load-bearing, not cosmetic. `--cmux` spawns one `infra-kit dev` per pane and
 * every pane inherits the SAME `INFRA_KIT_SESSION`, so without it N panes interleave into one file.
 * Falls back to a literal `no-session` folder when the shell exported no id, so dev logging never
 * depends on `infra-kit init` having run.
 */
export const resolveLogDir = (): string => {
  // The session id is collapsed to a single safe segment, exactly as a service name is. It is normally
  // an 8-hex id the init rc exports — but it is an env var, and this path is the ROOT that `gcOldLogDirs`
  // walks with `rmSync(recursive, force)`. Hardening the file name while leaving the directory that the
  // recursive delete is anchored to unhardened is the wrong half to protect.
  const raw = process.env[INFRA_KIT_SESSION_VAR] ?? ''
  const session = safeSegment(raw) ?? 'no-session'

  return path.join(getCacheRoot(), session, 'dev', String(process.pid))
}

/** `client/api` → `client-api.log`. */
export const logFileName = (service: string): string => {
  return `${safeSegment(service) ?? 'unnamed'}.log`
}

/**
 * Drop dev log dirs older than {@link GC_MAX_AGE_MS}. A `<pid>` segment means a fresh dir per run, and
 * nothing else ever prunes them — so the sink prunes its own. Best-effort: a GC failure must never
 * take down a dev session, so every error is swallowed.
 */
const GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Is `name` a pid that is still running? `kill(pid, 0)` sends no signal — it only asks the kernel whether
 * the process exists (and whether we may signal it; `EPERM` means it exists but is not ours, which still
 * answers "alive"). A name that is not a pid at all is treated as dead, so a stray directory is still
 * collectable.
 */
const isPidAlive = (name: string): boolean => {
  const pid = Number(name)

  if (!Number.isInteger(pid) || pid <= 0) return false

  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM'
  }
}

const gcOldLogDirs = (devRoot: string, now: number): void => {
  let entries: fs.Dirent[]

  try {
    entries = fs.readdirSync(devRoot, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // NEVER touch a dir whose pid is still alive. Age alone is not enough to call one dead: a directory's
    // mtime is not bumped by writes INTO the files it holds, only by create/unlink, and every service
    // file is created at boot. So a dev session left running over a long break looks a week old from the
    // moment it starts — and deleting it would unlink the very inodes it still holds open, whose writes
    // then succeed silently into nothing. Liveness answers the question age only guesses at.
    if (isPidAlive(entry.name)) continue

    const dir = path.join(devRoot, entry.name)

    try {
      if (now - fs.statSync(dir).mtimeMs > GC_MAX_AGE_MS) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      // A dir we cannot stat or remove is a dir we leave alone.
    }
  }
}

/**
 * The per-service log sink. One held fd per service, opened lazily on first write.
 *
 * Every routing and counting decision here reads DECLARED provenance — the service the caller named and
 * the level it chose — never the bytes of the line. Content is written, never inspected.
 */
export class DevLogSink {
  readonly dir: string
  private readonly fds = new Map<string, number>()
  private readonly counters = new Map<string, ServiceStats>()
  private closed = false

  constructor(dir: string = resolveLogDir()) {
    this.dir = dir
    fs.mkdirSync(this.dir, { recursive: true })
    gcOldLogDirs(path.dirname(this.dir), Date.now())
    this.linkLatest()
  }

  /**
   * Point `<session>/dev/latest` at this run's dir, so `tail -f` has a stable path across runs even
   * though the real dir is pid-scoped. Best-effort — a filesystem without symlink support just loses
   * the shortcut, not the logs.
   */
  private linkLatest(): void {
    const link = path.join(path.dirname(this.dir), 'latest')

    try {
      fs.rmSync(link, { force: true })
      fs.symlinkSync(this.dir, link, 'dir')
    } catch {
      // No symlink → the panel still prints the absolute dir.
    }
  }

  /** Absolute path of a service's log file (whether or not it has been written to yet). */
  pathFor(service: string): string {
    return path.join(this.dir, logFileName(service))
  }

  /** Lazily open (and cache) the append fd for a service. */
  private fdFor(service: string): number | null {
    const cached = this.fds.get(service)

    if (cached != null) return cached

    try {
      const fd = fs.openSync(this.pathFor(service), 'a')

      this.fds.set(service, fd)

      return fd
    } catch {
      // A log file we cannot open must never down the dev session — the line is dropped, not thrown.
      return null
    }
  }

  /**
   * Append `text` to `<service>.log` and fold its DECLARED level into that service's counters.
   *
   * `text` is written verbatim (a trailing newline is added when absent) — the sink never parses it.
   * `level` comes from the emitter (the `console` method it chose, the Powertools level it set, the
   * HTTP status it returned), so the counter reports what the caller declared rather than guessing.
   */
  write(service: string, text: string, meta: { level?: LogLevel } = {}): void {
    if (this.closed) return

    const stats = this.counters.get(service) ?? emptyStats()

    if (meta.level === 'error') {
      stats.errors += 1
      stats.lastErrorAt = Date.now()
    } else if (meta.level === 'warn') {
      stats.warns += 1
    }
    this.counters.set(service, stats)

    const fd = this.fdFor(service)

    if (fd == null) return

    try {
      fs.writeSync(fd, text.endsWith('\n') ? text : `${text}\n`)
    } catch {
      // A failed write is a dropped line, never a crashed dev server.
    }
  }

  /** Counters for one service (a service that has never written returns zeroes, not `undefined`). */
  statsFor(service: string): ServiceStats {
    return this.counters.get(service) ?? emptyStats()
  }

  /** Every service that has written at least one line. */
  services(): string[] {
    return [...this.fds.keys()]
  }

  /**
   * Close every fd. Idempotent, and synchronous by design so it is safe from a `process.on('exit')`
   * handler — there is no buffered data to flush, because there was never a buffer.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const fd of this.fds.values()) {
      try {
        fs.closeSync(fd)
      } catch {
        // Already closed / bad fd — nothing left to do at teardown.
      }
    }
    this.fds.clear()
  }
}
