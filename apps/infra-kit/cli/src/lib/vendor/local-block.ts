import { Buffer } from 'node:buffer'

/**
 * A mirrored file's repo-owned lines sit between a start and an end marker line. The marker is the token
 * alone on its line behind one comment leader (`#`, `//`, `;`, `--` or `<!-- … -->`), so one rule covers
 * ignore files, YAML, shell, JS and Markdown without a per-file list.
 */
const MARKER_LINE = /^\s*(?:#|\/\/|;|--|<!--)\s*infra-kit:local-(start|end)\s*(?:-->\s*)?$/
const MARKER_TOKEN = Buffer.from('infra-kit:local-')

interface BlockSpan {
  /** Index of the start marker line. */
  start: number
  /** Index of the end marker line, inclusive. */
  end: number
}

const findBlock = (lines: readonly string[]): BlockSpan | null => {
  const start = lines.findIndex((line) => {
    return MARKER_LINE.exec(line)?.[1] === 'start'
  })

  if (start === -1) return null

  const offset = lines.slice(start + 1).findIndex((line) => {
    return MARKER_LINE.exec(line)?.[1] === 'end'
  })

  // An unterminated block is not a block: guessing where it ends could swallow mirrored lines.
  return offset === -1 ? null : { start, end: start + 1 + offset }
}

/** Lines split on `\n`, or `null` for content that never mentions the marker (binary files included). */
const markedLines = (content: Buffer): string[] | null => {
  return content.includes(MARKER_TOKEN) ? content.toString('utf8').split('\n') : null
}

/** The repo-owned block, markers included and without a trailing newline, or `null` when there is none. */
export const localBlockOf = (content: Buffer): string | null => {
  const lines = markedLines(content)
  const span = lines && findBlock(lines)

  return lines && span ? lines.slice(span.start, span.end + 1).join('\n') : null
}

/** `content` without its repo-owned block, so mirrored and repo-owned halves hash independently. */
export const stripLocalBlock = (content: Buffer): Buffer => {
  const lines = markedLines(content)
  const span = lines && findBlock(lines)

  if (!lines || !span) return content

  return Buffer.from([...lines.slice(0, span.start), ...lines.slice(span.end + 1)].join('\n'))
}

/**
 * The mirrored `source` carrying the target's `block`: in place of the source's own block when it has one,
 * else appended after its last line.
 */
export const withLocalBlock = (source: Buffer, block: string): Buffer => {
  const lines = source.toString('utf8').split('\n')
  const span = findBlock(lines)

  if (span) return Buffer.from([...lines.slice(0, span.start), block, ...lines.slice(span.end + 1)].join('\n'))

  const text = lines.join('\n')

  return Buffer.from(`${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${block}\n`)
}
