/**
 * The one line shape of every `infra-kit dev` log file: `time LEVEL service message [extras-json]`.
 *
 * A pure layer the runner's {@link DevLogSink} applies after its cap check (`createDevLogSink`), so the
 * cap, `latest`, GC and the panel counters keep their own code paths and never see this file. A record
 * spanning several physical lines writes every line with the same full prefix: a stack trace stays
 * readable in an editor, and every line still greps by service and level.
 */
import type { LogLevel } from './render.js'
import { TASK_PREFIX, lastRedraw, turboLineLevel } from './turbo-line.js'

/**
 * The turbo child's RAW line tee — turbo's own run chrome plus every framework line, ANSI intact and
 * un-de-multiplexed. Kept as its own file rather than smeared across the per-app UI logs: a raw line
 * arrives before `parseTurboDevLine` has attributed it to a package, so there is no honest app to file
 * it under. The per-app `<app>/ui` files get the parsed, attributed lines.
 */
export const TURBO_SERVICE = 'turbo'

/** Turns one `sink.write` into the bytes that land in the file; the sink appends a final newline when absent. */
export type LogLineFormatter = (service: string, text: string, level: LogLevel | undefined) => string

/** One record as {@link formatLogRecord} reads it; `time` is the fallback when the record carries none. */
export interface LogRecord {
  time: string
  service: string
  text: string
  level?: LogLevel
}

/* eslint-disable no-control-regex, sonarjs/no-control-regex, regexp/no-obscure-range -- terminal escapes and control chars are, by definition, control chars; ECMA-48 defines CSI by these byte ranges. */
/** An OSC sequence: ESC `]` ... terminated by BEL or ST. Frameworks emit these for terminal hyperlinks. */
const OSC_ESCAPE = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g
/** A CSI escape: ESC `[`, parameter bytes, intermediate bytes, final byte. Covers every SGR colour. */
const CSI_ESCAPE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g
/**
 * Every remaining C0 control char except TAB and LF. CR is the dangerous one: written straight to a TTY
 * it snaps the cursor to column 0, smearing the row and the pinned footer below it. LF is left for the
 * caller, which splits on it.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g
/** The hot-path gate: one non-global test (a `/g` regex's `test` carries `lastIndex` between calls). */
const HAS_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/
/* eslint-enable no-control-regex, sonarjs/no-control-regex, regexp/no-obscure-range -- closes the block disabled above */

/**
 * Drop terminal escapes and stray control chars, leaving plain text. Order matters: OSC is matched
 * before the bare-control sweep can eat its leading ESC.
 */
export const stripAnsi = (text: string): string => {
  return text.replace(OSC_ESCAPE, '').replace(CSI_ESCAPE, '').replace(CONTROL_CHARS, '')
}

/** A line redrawn with bare CR (a progress bar) keeps only what the terminal finally showed. */
const collapseCarriageReturns = (line: string): string => {
  // A line with no real redraw is kept whole: its stray CRs are control chars the strip removes anyway.
  return lastRedraw(line) ?? line
}

/**
 * Make text file-safe. CR handling runs BEFORE the strip, which would otherwise delete every CR and
 * glue each redraw of a progress line onto the previous one.
 */
export const sanitizeLine = (text: string): string => {
  return stripAnsi(text.replaceAll('\r\n', '\n').split('\n').map(collapseCarriageReturns).join('\n'))
}

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
}

const RECORD_LEVELS: Record<string, LogLevel> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  critical: 'error',
  fatal: 'error',
}

/** Keys the prefix already carries, so repeating them in the extras would only add noise. */
const PREFIX_KEYS = new Set(['level', 'timestamp', 'time', 'message', 'msg'])

const clean = (text: string): string => {
  return HAS_CONTROL.test(text) ? sanitizeLine(text) : text
}

/**
 * A turbo task line repainted with bare CR keeps its `<pkg>:dev:` prefix in front of the last redraw;
 * the generic collapse would keep the redraw alone and leave the line unattributable.
 */
const keepTaskPrefix = (line: string): string => {
  const redraw = lastRedraw(line)
  const match = redraw == null ? null : TASK_PREFIX.exec(stripAnsi(line))

  return match == null ? line : `${match[0]}${redraw}`
}

const cleanTurbo = (text: string): string => {
  if (!HAS_CONTROL.test(text)) return text
  if (!text.includes('\r')) return sanitizeLine(text)

  return sanitizeLine(text.replaceAll('\r\n', '\n').split('\n').map(keepTaskPrefix).join('\n'))
}

const recordTime = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback

  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

const recordLevel = (value: unknown): LogLevel | undefined => {
  return typeof value === 'string' ? RECORD_LEVELS[value.toLowerCase()] : undefined
}

/** Split a JSON record's `error.stack` out of its extras, so it can be written as continuation lines. */
const takeStack = (extras: Record<string, unknown>): string[] => {
  const error = extras.error

  if (error === null || typeof error !== 'object') return []

  const { stack, ...rest } = error as Record<string, unknown>

  if (typeof stack !== 'string') return []

  extras.error = rest

  return clean(stack).split('\n')
}

/** A trimmed `{` line that parses to an object carrying a string `message`/`msg`, else `null`. */
const parseRecord = (line: string): Record<string, unknown> | null => {
  let parsed: unknown

  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const record = parsed as Record<string, unknown>

  return typeof record.message === 'string' || typeof record.msg === 'string' ? record : null
}

const prefixed = (prefix: string, lines: string[]): string => {
  let out = ''

  for (const line of lines) out += `${prefix}${line}\n`

  return out
}

/** A backend JSON line (dev-logger / Powertools shape) unfolded into the shared prefix. */
const formatJsonRecord = (record: Record<string, unknown>, input: LogRecord): string => {
  const extras: Record<string, unknown> = {}
  let hasExtras = false

  for (const key of Object.keys(record)) {
    if (PREFIX_KEYS.has(key) || (key === 'service' && record.service === input.service)) continue
    extras[key] = record[key]
    hasExtras = true
  }

  const stack = hasExtras ? takeStack(extras) : []
  const level = recordLevel(record.level) ?? input.level ?? 'info'
  const time = recordTime(record.time ?? record.timestamp, input.time)
  const message = clean(String(record.message ?? record.msg)).split('\n')

  if (hasExtras) message[0] = `${message[0]} ${clean(JSON.stringify(extras))}`

  return prefixed(`${time} ${LEVEL_LABEL[level]} ${input.service} `, [...message, ...stack])
}

/** Severity of a plain line: declared first; turbo's own `<pkg>:dev:` format next; `info` otherwise. */
const plainLevel = (line: string, input: LogRecord): LogLevel => {
  if (input.level != null) return input.level
  if (input.service !== TURBO_SERVICE) return 'info'

  const match = TASK_PREFIX.exec(line)

  return match == null ? 'info' : turboLineLevel(line.slice(match[0].length))
}

const formatLine = (line: string, input: LogRecord): string => {
  if (line.trimStart().startsWith('{')) {
    const record = parseRecord(line)

    if (record != null) return formatJsonRecord(record, input)
  }

  return `${input.time} ${LEVEL_LABEL[plainLevel(line, input)]} ${input.service} ${line}\n`
}

/**
 * One `sink.write` → its file bytes: one prefixed line per physical line, every line newline-terminated.
 *
 * @example
 * formatLogRecord({ time: '2026-11-12T10:00:00.000Z', service: 'client/ui', text: 'ready', level: 'info' })
 * // => '2026-11-12T10:00:00.000Z INFO  client/ui ready\n'
 */
export const formatLogRecord = (input: LogRecord): string => {
  const text = input.service === TURBO_SERVICE ? cleanTurbo(input.text) : clean(input.text)
  const body = text.endsWith('\n') ? text.slice(0, -1) : text

  if (!body.includes('\n')) return formatLine(body, input)

  let out = ''

  for (const line of body.split('\n')) out += formatLine(line, input)

  return out
}

/**
 * The runner's formatter, stamping records from `now`. The ISO string is reused within one millisecond:
 * a burst of lines shares a stamp anyway, and `toISOString` is the costliest step of a plain line.
 */
export const createLogLineFormatter = (
  now: () => Date = (): Date => {
    return new Date()
  },
): LogLineFormatter => {
  let stampedMs = Number.NaN
  let stamp = ''

  return (service, text, level) => {
    const date = now()
    const ms = date.getTime()

    if (ms !== stampedMs) {
      stampedMs = ms
      stamp = date.toISOString()
    }

    return formatLogRecord({ time: stamp, service, text, level })
  }
}
