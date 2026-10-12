/**
 * What the last unattended setup did, at `$cacheRoot/auto-setup.json`: the version it ran for, how
 * many times it has tried that version, and one verdict per run (the machine, then each project).
 *
 * Read on the interactive startup path for the one-line notice, so this module imports nothing heavier
 * than `fs`: a corrupt or missing file is `null`, never a throw.
 */
import fs from 'node:fs'
import path from 'node:path'

import { atomicWriteFileSync, getCacheRoot } from 'src/lib/constants'

export const AUTO_SETUP_RECORD_FILE = 'auto-setup.json'

export const AUTO_SETUP_LOG_FILE = 'auto-setup.log'

export const AUTO_SETUP_LOCK_FILE = 'auto-setup.lock'

/**
 * Which record the interactive notice has already been printed for. Its own file, never a field of the
 * record: the startup path rewriting the record would race the background pass writing a newer one,
 * and a lost write there rewinds the attempt counter.
 */
export const AUTO_SETUP_NOTIFIED_FILE = 'auto-setup.notified'

/**
 * `attention`: the run finished, but left something only a human can do (a withheld tracked-file
 * write, a missing tool, a sudo command) — it is not retried, its notes are the commands. `failed` is
 * a run that crashed, timed out or reported a failed row, and is retried on the next update check.
 */
export type AutoSetupRunStatus = 'ok' | 'attention' | 'failed'

export interface AutoSetupRun {
  /** The project root, or null for the machine-level run from `$HOME`. */
  root: string | null
  status: AutoSetupRunStatus
  /** The lines a human acts on: each `manual`/`warn`/`fail` row with its notes, or why the run failed. */
  notes: string[]
}

export interface AutoSetupRecord {
  /** The infra-kit version that ran — the trigger is "this differs from the running version". */
  version: string
  /** Tries for `version`; the retry stops at {@link MAX_AUTO_SETUP_ATTEMPTS}. */
  attempts: number
  startedMs: number
  /**
   * Null on the provisional record written before the first child starts: a pass that dies, or whose
   * final write fails, has still used its attempt and its cooldown — that is the bound on retries.
   */
  finishedMs: number | null
  runs: AutoSetupRun[]
}

/** A version whose runs keep failing is retried this many times, then left to `infra-kit setup`. */
export const MAX_AUTO_SETUP_ATTEMPTS = 3

/**
 * The minimum gap between two passes, whatever the version. It is what bounds the one case the version
 * trigger alone cannot: two `infra-kit` binaries answering on PATH at different times, each recording
 * its own version, so every check would read as "a new version landed".
 */
export const AUTO_SETUP_COOLDOWN_MS = 60 * 60 * 1000

export const autoSetupRecordPath = (): string => {
  return path.join(getCacheRoot(), AUTO_SETUP_RECORD_FILE)
}

export const autoSetupLogPath = (): string => {
  return path.join(getCacheRoot(), AUTO_SETUP_LOG_FILE)
}

export const autoSetupLockPath = (): string => {
  return path.join(getCacheRoot(), AUTO_SETUP_LOCK_FILE)
}

export const autoSetupNotifiedPath = (): string => {
  return path.join(getCacheRoot(), AUTO_SETUP_NOTIFIED_FILE)
}

const RUN_STATUSES: ReadonlySet<string> = new Set<AutoSetupRunStatus>(['ok', 'attention', 'failed'])

const isRun = (value: unknown): value is AutoSetupRun => {
  if (typeof value !== 'object' || value === null) return false

  const { root, status, notes } = value as Partial<AutoSetupRun>

  return (
    (root === null || typeof root === 'string') &&
    typeof status === 'string' &&
    RUN_STATUSES.has(status) &&
    Array.isArray(notes) &&
    notes.every((note) => {
      return typeof note === 'string'
    })
  )
}

const isRecord = (value: unknown): value is AutoSetupRecord => {
  if (typeof value !== 'object' || value === null) return false

  const { version, attempts, startedMs, finishedMs, runs } = value as Partial<AutoSetupRecord>

  return (
    typeof version === 'string' &&
    typeof attempts === 'number' &&
    Number.isInteger(attempts) &&
    typeof startedMs === 'number' &&
    Number.isFinite(startedMs) &&
    (finishedMs === null || (typeof finishedMs === 'number' && Number.isFinite(finishedMs))) &&
    Array.isArray(runs) &&
    runs.every(isRun)
  )
}

/**
 * @example
 * readAutoSetupRecord() // => { version: '0.19.0', attempts: 1, finishedMs: 1770000000000, runs: [...] } | null
 */
export const readAutoSetupRecord = (
  readFile: (p: string) => string = (p) => {
    return fs.readFileSync(p, 'utf8')
  },
): AutoSetupRecord | null => {
  try {
    const parsed: unknown = JSON.parse(readFile(autoSetupRecordPath()))

    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const writeAutoSetupRecord = (record: AutoSetupRecord): void => {
  const root = getCacheRoot()

  fs.mkdirSync(root, { recursive: true })
  atomicWriteFileSync(path.join(root, AUTO_SETUP_RECORD_FILE), JSON.stringify(record), 0o600)
}

/** A pass that still needs a retry: one that never finished, or a run that crashed or reported a failed row. */
export const recordHasFailure = (record: AutoSetupRecord): boolean => {
  return (
    record.finishedMs === null ||
    record.runs.some((run) => {
      return run.status === 'failed'
    })
  )
}

/** The `finishedMs` of the record the notice was last printed for, or null. Never throws. */
export const readNotifiedMarker = (
  readFile: (p: string) => string = (p) => {
    return fs.readFileSync(p, 'utf8')
  },
): number | null => {
  try {
    const value = Number(readFile(autoSetupNotifiedPath()).trim())

    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

export const writeNotifiedMarker = (finishedMs: number): void => {
  const root = getCacheRoot()

  fs.mkdirSync(root, { recursive: true })
  atomicWriteFileSync(path.join(root, AUTO_SETUP_NOTIFIED_FILE), String(finishedMs), 0o600)
}

/**
 * Is a pass owed for `version` at `nowMs`? Never inside the cooldown after the last one started; past
 * it, yes when the last record is for another version (an update landed, by the worker or by hand), or
 * for this one with a failed or unfinished pass and tries left.
 *
 * A `startedMs` in the future (clock skew, a restored backup) does not hold the cooldown.
 *
 * @example
 * autoSetupDue(null, '0.19.0', Date.now()) // => true
 */
export const autoSetupDue = (record: AutoSetupRecord | null, version: string, nowMs: number): boolean => {
  if (record === null) return true

  const sinceStartMs = nowMs - record.startedMs

  if (sinceStartMs >= 0 && sinceStartMs < AUTO_SETUP_COOLDOWN_MS) return false
  if (record.version !== version) return true

  return recordHasFailure(record) && record.attempts < MAX_AUTO_SETUP_ATTEMPTS
}
