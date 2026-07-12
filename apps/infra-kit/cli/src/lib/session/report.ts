import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import type { EquivalentLine } from './equivalent'

/**
 * Session-private side channel from a spawned command child back to the session-shell parent. The
 * child writes a small JSON record at the path in `INFRA_KIT_SESSION_REPORT`; the parent reads it to
 * derive the transcript entry. The record is NOT `ToolsExecutionResult` and never touches the `--json`
 * / MCP machine contract — it exists only so the parent can show a rich `equivalent + report` block.
 *
 * The file's PRESENCE is load-bearing: a decline/cancel path exits before the write, so an absent file
 * (with exit 0) is how the parent tells "cancelled" from "ok". See `classifyOutcome`.
 */

export const SESSION_REPORT_ENV = 'INFRA_KIT_SESSION_REPORT'

export interface SessionReportRecord {
  /** The replayable equivalent line for this invocation (resolved flags folded in when interactive). */
  equivalent?: EquivalentLine
  /** Optional human summary lines a command opted to surface (e.g. "found 3 violations"). */
  summary?: string[]
}

// The child captures the report path ONCE at CLI entry and deletes the env var so no grandchild
// (gh / git / a hook / $EDITOR) inherits it and clobbers the file. `captured` guards a double-capture.
let capturedReportPath: string | null = null
let captured = false
const summaryLines: string[] = []

/**
 * Capture `INFRA_KIT_SESSION_REPORT` into a module local and delete it from the env so descendants do
 * not inherit it. Call once at CLI entry (in every process); a non-session process simply captures
 * `null`. Idempotent.
 *
 * @example
 * const env = { INFRA_KIT_SESSION_REPORT: '/tmp/r.json' }
 * captureSessionReportPath(env)
 * env.INFRA_KIT_SESSION_REPORT // => undefined (deleted so grandchildren don't inherit)
 */
export const captureSessionReportPath = (env: NodeJS.ProcessEnv = process.env): void => {
  if (captured) {
    return
  }

  capturedReportPath = env[SESSION_REPORT_ENV] ?? null
  captured = true
  delete env[SESSION_REPORT_ENV]
}

/** True when this process is running as a session-shell child (a report path was captured). */
export const isSessionChild = (): boolean => {
  return capturedReportPath != null
}

/**
 * Reset the captured path + accumulated summary. For tests only (the process-lifetime singleton is
 * captured exactly once at CLI entry in real use). Mirrors `commandEcho.reset()`.
 *
 * @example
 * resetSessionReport()
 * isSessionChild() // => false
 */
export const resetSessionReport = (): void => {
  capturedReportPath = null
  captured = false
  summaryLines.length = 0
}

/**
 * Accumulate optional human summary lines for this invocation's transcript entry. A no-op outside a
 * session; commands may call it to enrich the report without knowing whether a session is active.
 *
 * @example
 * addSessionSummary('found 3 violations')
 */
export const addSessionSummary = (...lines: string[]): void => {
  summaryLines.push(...lines)
}

/**
 * Write the session report to the captured path. No-op when not running under a session (path null).
 * Best-effort: a write failure never throws (the parent falls back to exit-code-derived status).
 *
 * @example
 * writeSessionReport({ equivalent: { line: 'infra-kit vendor check', reproducible: true } })
 */
export const writeSessionReport = (
  record: SessionReportRecord,
  deps?: { write?: (file: string, data: string) => void },
): void => {
  if (!capturedReportPath) {
    return
  }

  const summary = record.summary ?? (summaryLines.length > 0 ? [...summaryLines] : undefined)
  const payload: SessionReportRecord = { ...record, ...(summary ? { summary } : {}) }
  const write =
    deps?.write ??
    ((file: string, data: string) => {
      fs.writeFileSync(file, data)
    })

  try {
    write(capturedReportPath, JSON.stringify(payload))
  } catch {
    // Best-effort: an unwritable report degrades the transcript to exit-code-only, never a crash.
  }
}

// --- Parent side (session shell) -----------------------------------------

let reportCounter = 0

/**
 * A fresh, unique report path under the OS temp dir for one spawned command. Never uses
 * `getSessionCacheDir()` (which throws when `INFRA_KIT_SESSION` is unset) — this ephemeral IPC needs
 * no session scoping. Uniqueness comes from pid + a monotonic counter, so no `Math.random` is needed.
 *
 * @example
 * newReportPath() // => '/var/folders/…/infra-kit-session-4123-1.json'
 */
export const newReportPath = (deps?: { tmpdir?: () => string; pid?: number }): string => {
  const tmp = deps?.tmpdir?.() ?? os.tmpdir()
  const pid = deps?.pid ?? process.pid

  reportCounter += 1

  return path.join(tmp, `infra-kit-session-${pid}-${reportCounter}.json`)
}

/**
 * Read and delete a child's report file. Returns the parsed record, or `null` when the file is absent
 * (the child cancelled / crashed before writing) or unparseable.
 *
 * @example
 * const record = readAndUnlinkReport('/tmp/r.json')
 * record?.equivalent?.line
 */
export const readAndUnlinkReport = (
  reportPath: string,
  deps?: { read?: (file: string) => string; unlink?: (file: string) => void; exists?: (file: string) => boolean },
): SessionReportRecord | null => {
  const exists =
    deps?.exists ??
    ((file: string) => {
      return fs.existsSync(file)
    })

  if (!exists(reportPath)) {
    return null
  }

  const read =
    deps?.read ??
    ((file: string) => {
      return fs.readFileSync(file, 'utf-8')
    })
  const unlink =
    deps?.unlink ??
    ((file: string) => {
      return fs.unlinkSync(file)
    })

  let raw: string

  try {
    raw = read(reportPath)
  } catch {
    return null
  } finally {
    try {
      unlink(reportPath)
    } catch {
      // A leftover temp file is harmless; the next iteration uses a fresh counter-suffixed name.
    }
  }

  try {
    return JSON.parse(raw) as SessionReportRecord
  } catch {
    return null
  }
}
