/**
 * @fileoverview
 *
 * Edits to a committed `infra-kit.json` that keep every byte they do not mean to change. Re-serialising
 * the parsed object would re-wrap every inline array a formatter left on one line, so each consumer's
 * `--fix` would come with a diff its prettier then reverts. These locate top-level members in the raw
 * text and splice only the members they add or the scalar values they replace.
 */

interface TopLevelMember {
  key: string
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

/** The top-level object's braces and members, or null when `raw` is not a JSON object. */
const scanTopLevel = (raw: string): TopLevelScan | null => {
  const open = skipWhitespace(raw, 0)

  if (raw[open] !== '{') return null

  const members: TopLevelMember[] = []
  let index = skipWhitespace(raw, open + 1)

  while (index < raw.length && raw[index] !== '}') {
    if (raw[index] !== '"') return null

    const keyEnd = skipString(raw, index)
    const key = JSON.parse(raw.slice(index, keyEnd)) as string
    const valueStart = skipWhitespace(raw, skipWhitespace(raw, keyEnd) + 1)
    const valueEnd = skipValue(raw, valueStart)

    members.push({ key, valueStart, valueEnd })
    index = skipWhitespace(raw, valueEnd)
    if (raw[index] === ',') index = skipWhitespace(raw, index + 1)
  }

  return raw[index] === '}' ? { open, close: index, members } : null
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
