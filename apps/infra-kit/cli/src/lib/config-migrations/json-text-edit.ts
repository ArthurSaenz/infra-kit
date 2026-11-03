/**
 * @fileoverview
 *
 * Edits to a committed `infra-kit.json` that keep every byte they do not mean to change. Re-serialising
 * the parsed object would re-wrap every inline array a formatter left on one line, so each consumer's
 * `--fix` (or retired-key migration) would come with a diff its prettier then reverts. These locate
 * object members in the raw text and splice only the members they add, remove or replace.
 */
import { isDeepStrictEqual } from 'node:util'

interface TopLevelMember {
  key: string
  /** Index of the key's opening quote. */
  keyStart: number
  /** Index of the value's first character. */
  valueStart: number
  /** Index one past the value's last character. */
  valueEnd: number
}

interface TopLevelScan {
  open: number
  close: number
  members: TopLevelMember[]
}

const WHITESPACE = /\s/u

const skipWhitespace = (raw: string, from: number): number => {
  let index = from

  while (index < raw.length && WHITESPACE.test(raw[index]!)) index += 1

  return index
}

/** Index one past the closing quote of the string that opens at `from`. */
const skipString = (raw: string, from: number): number => {
  let index = from + 1

  while (index < raw.length && raw[index] !== '"') index += raw[index] === '\\' ? 2 : 1

  return index + 1
}

/** Index one past the end of the JSON value that starts at `from`. */
const skipValue = (raw: string, from: number): number => {
  if (raw[from] === '"') return skipString(raw, from)

  if (raw[from] !== '{' && raw[from] !== '[') {
    let index = from

    while (index < raw.length && !/[\s,}\]]/u.test(raw[index]!)) index += 1

    return index
  }

  let depth = 0
  let index = from

  while (index < raw.length) {
    const char = raw[index]!

    if (char === '"') {
      index = skipString(raw, index)
      continue
    }

    if (char === '{' || char === '[') depth += 1
    if (char === '}' || char === ']') depth -= 1

    index += 1

    if (depth === 0) return index
  }

  return index
}

/** The braces and members of the object that opens at `open`, or null when there is none. */
const scanObjectAt = (raw: string, open: number): TopLevelScan | null => {
  if (raw[open] !== '{') return null

  const members: TopLevelMember[] = []
  let index = skipWhitespace(raw, open + 1)

  while (index < raw.length && raw[index] !== '}') {
    if (raw[index] !== '"') return null

    const keyEnd = skipString(raw, index)
    const key = JSON.parse(raw.slice(index, keyEnd)) as string
    const valueStart = skipWhitespace(raw, skipWhitespace(raw, keyEnd) + 1)
    const valueEnd = skipValue(raw, valueStart)

    members.push({ key, keyStart: index, valueStart, valueEnd })
    index = skipWhitespace(raw, valueEnd)
    if (raw[index] === ',') index = skipWhitespace(raw, index + 1)
  }

  return raw[index] === '}' ? { open, close: index, members } : null
}

/** The top-level object's braces and members, or null when `raw` is not a JSON object. */
const scanTopLevel = (raw: string): TopLevelScan | null => {
  return scanObjectAt(raw, skipWhitespace(raw, 0))
}

const lineBreakOf = (raw: string): string => {
  return raw.includes('\r\n') ? '\r\n' : '\n'
}

/** The member as it is written into a multi-line object, nested lines indented one level deeper. */
const renderMember = (key: string, value: unknown, indent: string, eol: string): string => {
  const rendered = JSON.stringify(value, null, indent).split('\n').join(`${eol}${indent}`)

  return `${indent}${JSON.stringify(key)}: ${rendered}`
}

const isMultiLine = (raw: string, scan: TopLevelScan): boolean => {
  return /[\r\n]/u.test(raw.slice(scan.open, scan.close))
}

/**
 * `raw` with `entries` inserted as its FIRST top-level members, every other byte unchanged.
 *
 * @example
 * prependTopLevelMembers('{\n  "a": [1, 2]\n}\n', [['v', 1]], '  ') // => '{\n  "v": 1,\n  "a": [1, 2]\n}\n'
 */
export const prependTopLevelMembers = (raw: string, entries: [string, unknown][], indent: string): string | null => {
  const scan = scanTopLevel(raw)

  if (scan === null || entries.length === 0) return scan === null ? null : raw

  const eol = lineBreakOf(raw)

  if (scan.members.length === 0) {
    const body = entries
      .map(([key, value]) => {
        return renderMember(key, value, indent, eol)
      })
      .join(`,${eol}`)

    return `${raw.slice(0, scan.open)}{${eol}${body}${eol}}${raw.slice(scan.close + 1)}`
  }

  const inserted = isMultiLine(raw, scan)
    ? entries
        .map(([key, value]) => {
          return `${eol}${renderMember(key, value, indent, eol)},`
        })
        .join('')
    : entries
        .map(([key, value]) => {
          return `${JSON.stringify(key)}: ${JSON.stringify(value)}, `
        })
        .join('')

  return `${raw.slice(0, scan.open + 1)}${inserted}${raw.slice(scan.open + 1)}`
}

/** `raw` with `entries` inserted as its LAST top-level members, every other byte unchanged. */
export const appendTopLevelMembers = (raw: string, entries: [string, unknown][], indent: string): string | null => {
  const scan = scanTopLevel(raw)

  if (scan === null || entries.length === 0) return scan === null ? null : raw

  const last = scan.members.at(-1)

  if (last === undefined) return prependTopLevelMembers(raw, entries, indent)

  const eol = lineBreakOf(raw)

  const inserted = isMultiLine(raw, scan)
    ? entries
        .map(([key, value]) => {
          return `,${eol}${renderMember(key, value, indent, eol)}`
        })
        .join('')
    : entries
        .map(([key, value]) => {
          return `, ${JSON.stringify(key)}: ${JSON.stringify(value)}`
        })
        .join('')

  return `${raw.slice(0, last.valueEnd)}${inserted}${raw.slice(last.valueEnd)}`
}

/** `raw` with the value of top-level `key` replaced by `value`, or null when there is no such member. */
export const replaceTopLevelValue = (raw: string, key: string, value: unknown): string | null => {
  const member = scanTopLevel(raw)?.members.find((candidate) => {
    return candidate.key === key
  })

  if (member === undefined) return null

  return `${raw.slice(0, member.valueStart)}${JSON.stringify(value)}${raw.slice(member.valueEnd)}`
}

interface Splice {
  start: number
  end: number
  text: string
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The whitespace that opens the line holding `index`. */
const lineIndentAt = (raw: string, index: number): string => {
  const lineStart = raw.lastIndexOf('\n', index - 1) + 1

  return /^[ \t]*/u.exec(raw.slice(lineStart))![0]
}

/**
 * The spans that delete the members at `doomed` (indices into `members`), each with the comma that
 * separated it: a run before a kept member goes up to that member's key; a trailing run takes the comma
 * after the last kept member instead; an object losing every member keeps only its braces.
 */
const deletionSplices = (scan: TopLevelScan, doomed: ReadonlySet<number>): Splice[] => {
  const { members } = scan
  const splices: Splice[] = []
  let index = 0

  while (index < members.length) {
    if (!doomed.has(index)) {
      index += 1
      continue
    }

    let last = index

    while (doomed.has(last + 1)) last += 1

    const next = members[last + 1]

    if (next !== undefined) splices.push({ start: members[index]!.keyStart, end: next.keyStart, text: '' })
    else if (index > 0) splices.push({ start: members[index - 1]!.valueEnd, end: members[last]!.valueEnd, text: '' })
    else splices.push({ start: scan.open + 1, end: scan.close, text: '' })

    index = last + 1
  }

  return splices
}

/**
 * The splices that turn the object at `scan` (parsed as `current`) into `target`: removed members are
 * deleted, nested objects recursed into, any other changed value replaced. Null when `target` adds a
 * key to a nested object — the one edit this does not make.
 */
const splicesToMatch = (
  raw: string,
  scan: TopLevelScan,
  current: Record<string, unknown>,
  target: Record<string, unknown>,
  indentUnit: string,
): Splice[] | null => {
  const doomed = new Set<number>()
  const splices: Splice[] = []

  for (const [index, member] of scan.members.entries()) {
    if (!(member.key in target)) {
      doomed.add(index)
      continue
    }

    const before = current[member.key]
    const after = target[member.key]

    if (isDeepStrictEqual(before, after)) continue

    const inner = isPlainObject(before) && isPlainObject(after) ? scanObjectAt(raw, member.valueStart) : null

    if (inner !== null) {
      const nested = splicesToMatch(
        raw,
        inner,
        before as Record<string, unknown>,
        after as Record<string, unknown>,
        indentUnit,
      )

      if (nested === null) return null
      splices.push(...nested)
      continue
    }

    const rendered = JSON.stringify(after, null, indentUnit)
      .split('\n')
      .join(`${lineBreakOf(raw)}${lineIndentAt(raw, member.keyStart)}`)

    splices.push({ start: member.valueStart, end: member.valueEnd, text: rendered })
  }

  return splices.concat(deletionSplices(scan, doomed))
}

/**
 * `raw` edited until it parses to `target`, every byte outside the changed members unchanged: removed
 * keys are cut with their comma (at any depth), changed values replaced, new top-level keys appended.
 * Null when the edit cannot be made textually, or does not parse back to `target` — the caller writes
 * nothing then, rather than re-serialising the file.
 *
 * @example
 * editToMatch('{\n  "ide": {},\n  "a": [1, 2]\n}\n', { a: [1, 2] }, '  ') // => '{\n  "a": [1, 2]\n}\n'
 */
export const editToMatch = (raw: string, target: Record<string, unknown>, indentUnit: string): string | null => {
  const scan = scanTopLevel(raw)
  const current: unknown = scan === null ? null : JSON.parse(raw)

  if (scan === null || !isPlainObject(current)) return null

  const splices = splicesToMatch(raw, scan, current, target, indentUnit)

  if (splices === null) return null

  const edited = [...splices]
    .sort((a, b) => {
      return b.start - a.start
    })
    .reduce((text, splice) => {
      return `${text.slice(0, splice.start)}${splice.text}${text.slice(splice.end)}`
    }, raw)

  const added = Object.entries(target).filter(([key]) => {
    return !(key in current)
  })

  const result = appendTopLevelMembers(edited, added, indentUnit)

  if (result === null) return null

  try {
    return isDeepStrictEqual(JSON.parse(result), target) ? result : null
  } catch {
    return null
  }
}
