import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  ENV_CLEAR_FILE,
  ENV_LOAD_FILE,
  INFRA_KIT_SESSION_VAR,
  getSessionCacheDir,
  parseUnsetNamesFromEnvFile,
  parseVarsFromEnvFile,
} from 'src/lib/constants'
import { logger } from 'src/lib/logger'
import { PROTECTED_CHILD_ENV_NAMES } from 'src/lib/mcp-proxy/protected-env'

/**
 * What the session dir says is loaded right now, read the way `~/.zshenv` reads it
 * (src/commands/init/init.ts): env-load.sh wins unless env-clear.sh is strictly newer.
 * `signature` identifies the file the state came from so an unchanged file is never
 * re-parsed; `no-session` carries none because nothing is ever applied for it.
 */
export type SessionEnvState =
  | { kind: 'load'; vars: Record<string, string>; signature: string }
  | { kind: 'clear'; unset: string[]; signature: string }
  | { kind: 'none'; signature: 'none' }
  | { kind: 'no-session' }

export interface SessionEnvApplyResult {
  set: string[]
  unset: string[]
  changed: boolean
}

/**
 * Names the file may carry but the overlay must never touch, on assign or on unset.
 * The proxy's set is reused so the two overlays cannot disagree about what plumbing
 * is; the four additions decide WHICH session dir this process reads and where the
 * plugin lives — a Doppler config defining `INFRA_KIT_SESSION` would otherwise point
 * the next read at another session.
 */
const NEVER_OVERLAID: ReadonlySet<string> = new Set([
  ...PROTECTED_CHILD_ENV_NAMES,
  INFRA_KIT_SESSION_VAR,
  'XDG_CACHE_HOME',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_PLUGIN_ROOT',
])

/**
 * Captured on the FIRST apply, not at import: unit tests build their environment
 * before calling, and the lazy stdio factory may run twice per connection, so an
 * import-time capture could freeze either the wrong env or a half-applied one.
 */
let baseline: NodeJS.ProcessEnv | null = null
/** Every name the previous apply wrote or deleted — what the next apply restores first. */
const touched = new Set<string>()
let lastSignature: string | null = null
/** Latched on the first throw of `getSessionCacheDir`: one log line per process, then silence. */
let noSession = false

export const resetSessionEnvForTests = (): void => {
  baseline = null
  touched.clear()
  lastSignature = null
  noSession = false
}

const statOrNull = (file: string): fs.Stats | null => {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/**
 * Unlike the proxy's `NO_SESSION` fallback this never reads a `no-session` dir:
 * `env-load` throws on a missing session id, so nothing could have written one.
 */
const resolveSessionDir = (): string | null => {
  if (noSession) return null

  try {
    return getSessionCacheDir()
  } catch {
    noSession = true
    logger.warn(`session-env: ${INFRA_KIT_SESSION_VAR} unset — no overlay`)

    return null
  }
}

/**
 * Which file the shell would source, decided from the stat pair alone so the signature
 * exists BEFORE anything is parsed. `atomicWriteFileSync` renames a fresh temp file into
 * place, so every write lands a new inode and `ino` makes the signature exact.
 */
type SourcedFile =
  | { kind: 'load'; file: string; signature: string }
  | { kind: 'clear'; file: string; signature: string }
  | { kind: 'none'; signature: 'none' }

const chooseSourcedFile = (dir: string): SourcedFile => {
  const loadPath = path.join(dir, ENV_LOAD_FILE)
  const clearPath = path.join(dir, ENV_CLEAR_FILE)
  const load = statOrNull(loadPath)
  const clear = statOrNull(clearPath)

  // zshenv: `! clear -nt load` — a tie goes to the load file.
  if (load && !(clear && clear.mtimeMs > load.mtimeMs)) {
    return { kind: 'load', file: loadPath, signature: `load:${load.ino}:${load.mtimeMs}:${load.size}` }
  }

  if (clear) return { kind: 'clear', file: clearPath, signature: `clear:${clear.ino}:${clear.mtimeMs}` }

  return { kind: 'none', signature: 'none' }
}

const parseSourcedFile = (sourced: SourcedFile): SessionEnvState => {
  if (sourced.kind === 'load') {
    return { kind: 'load', vars: parseVarsFromEnvFile(sourced.file), signature: sourced.signature }
  }

  if (sourced.kind === 'clear') {
    return { kind: 'clear', unset: parseUnsetNamesFromEnvFile(sourced.file), signature: sourced.signature }
  }

  return sourced
}

export const readSessionEnvState = (dir = resolveSessionDir()): SessionEnvState => {
  if (dir === null) return { kind: 'no-session' }

  return parseSourcedFile(chooseSourcedFile(dir))
}

/** `readSessionEnvState` minus the parse when the file is the one already applied. */
const readSessionEnvStateIfMoved = (): SessionEnvState | null => {
  const dir = resolveSessionDir()

  if (dir === null) return { kind: 'no-session' }

  const sourced = chooseSourcedFile(dir)

  return sourced.signature === lastSignature ? null : parseSourcedFile(sourced)
}

const restoreTouched = (): void => {
  for (const name of touched) {
    const original = baseline![name]

    if (original === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = original
    }
  }

  touched.clear()
}

interface Overlay {
  set: string[]
  unset: string[]
  skipped: string[]
}

const assign = (overlay: Overlay, name: string, value: string): void => {
  if (NEVER_OVERLAID.has(name)) {
    overlay.skipped.push(name)

    return
  }

  process.env[name] = value
  touched.add(name)
  overlay.set.push(name)
}

const remove = (overlay: Overlay, name: string): void => {
  if (NEVER_OVERLAID.has(name)) {
    overlay.skipped.push(name)

    return
  }

  delete process.env[name]
  touched.add(name)
  overlay.unset.push(name)
}

const overlayState = (state: Exclude<SessionEnvState, { kind: 'no-session' }>): Overlay => {
  const overlay: Overlay = { set: [], unset: [], skipped: [] }

  if (state.kind === 'load') {
    for (const [name, value] of Object.entries(state.vars)) assign(overlay, name, value)
  }

  if (state.kind === 'clear') {
    for (const name of state.unset) remove(overlay, name)
  }

  return overlay
}

const describeState = (state: Exclude<SessionEnvState, { kind: 'no-session' }>): string => {
  return state.kind === 'load' ? `load, ${Object.keys(state.vars).length} vars` : state.kind
}

/**
 * Make `process.env` equal `baseline ⊕ state`. SYNCHRONOUS on purpose: the SDK
 * dispatches tool handlers concurrently, and a restore+overlay that cannot yield
 * cannot interleave — `process.env` is always one full result, never a mix of two.
 *
 * The stat pair is the whole per-call cost: the default state is read through the
 * signature check, so an unchanged file is never parsed. Never throws: a missing
 * session id or a vanished file degrades to "nothing applied", corrected on the
 * next call.
 */
export const applySessionEnv = (state = readSessionEnvStateIfMoved()): SessionEnvApplyResult => {
  baseline ??= { ...process.env }

  if (state === null || state.kind === 'no-session' || state.signature === lastSignature) {
    return { set: [], unset: [], changed: false }
  }

  restoreTouched()

  const { set, unset, skipped } = overlayState(state)

  lastSignature = state.signature

  if (skipped.length > 0) logger.warn(`session-env: skipped protected names [${skipped.join(', ')}]`)

  logger.info(`session-env applied: set [${set.join(', ')}] unset [${unset.join(', ')}] (${describeState(state)})`)

  return { set, unset, changed: true }
}
