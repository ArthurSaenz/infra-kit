import { readFileSync } from 'node:fs'

/**
 * @fileoverview
 *
 * A transparent stdio tee-proxy for the MCP protocol tests, plus the reader for the log it writes.
 *
 * WHY A PROXY AT ALL. The SDK v2 client hides the wire. Asserting that the server actually encodes
 * a result the modern way — rather than that the client's decoder happened to accept it — needs the
 * bytes as they crossed the pipe. Phase 6 already used this mechanism against real hosts
 * (`docs/mcp-stateless-migration-plan.md:612-613`); writing it once means the test lane and the
 * host measurements observe the wire the same way.
 *
 * WHY EVERY LINE CARRIES A PID. A negotiated stdio connection spawns a DISPOSABLE SIBLING (the
 * `server/discover` probe) and then the served process, and both run through this proxy into the
 * same log file. Untagged, the sibling's exchange is indistinguishable from the served
 * connection's. One shared log is still safe because the sibling is reaped before the served child
 * starts, so the two never interleave lines.
 *
 * THE PROXY MUST NOT REFRAME. It splits on `\n` to tag lines and does nothing else: no parsing, no
 * reordering, no buffering beyond a carry for the partial trailing line. A proxy that reframes is a
 * proxy that lies about the wire.
 *
 * Not a `*.test.ts` file, so vitest's default `include` never collects it as an empty suite. The
 * pure half (`parseTeeLines`, `servedConnection`) is exported separately from the filesystem half
 * (`readTee`) so `helpers/__tests__/stdio-tee.test.ts` can cover the selector with no spawn, no
 * build and no temp files.
 */

/** A parsed JSON-RPC frame. Deliberately untyped beyond "a JSON object" — the point is the wire. */
export type Frame = Record<string, unknown>

/** Everything one child process sent and received, in wire order. */
export interface TeeConnection {
  pid: number
  inbound: Frame[]
  outbound: Frame[]
}

export interface TeeLog {
  /** Every pid seen in the log, in first-appearance order. */
  byPid: Map<number, { inbound: Frame[]; outbound: Frame[] }>
  /** Lines that were not a well-formed `<direction><pid>\t<json-object>` record. */
  malformed: number
  /**
   * The one connection that is NOT the disposable negotiation sibling.
   *
   * EXACT RULE, NOT A HEURISTIC: the sibling is any pid whose INBOUND frames contain a request with
   * `method === 'server/discover'`; every other pid is a served candidate. Throws on zero or more
   * than one candidate.
   *
   * A "pid with the most frames" heuristic ties two-to-two in the modern lane — the sibling carries
   * a `server/discover` request plus its result, and the served connection carries only the test's
   * own `tools/list` request plus its result. Worse, the tie fails SILENTLY in the direction that
   * matters: `server/discover` is itself modern-encoded and cacheable, so the modern-encoding
   * assertions would all pass against the sibling.
   */
  servedConnection: () => TeeConnection
}

/**
 * The tee proxy, as source text. The caller writes it to a temp file and runs it as
 *
 *     node <proxy>.cjs <command> <argument> <logPath>
 *
 * COMMONJS, `.cjs` EXTENSION, MANDATORY. This package is `"type": "module"`, so a `.js` temp file
 * inside it is parsed as ESM and `require` throws. `.cjs` pins the parse goal regardless of which
 * `package.json` the temp directory happens to sit under.
 *
 * It spawns `argv[2] argv[3]` with `stdio: ['pipe', 'pipe', 'inherit']`, pipes stdin → child.stdin
 * and child.stdout → stdout UNCHANGED, and appends each newline-delimited frame to `argv[4]` as
 * `>{pid}\t{line}` (parent → child) or `<{pid}\t{line}` (child → parent). It forwards SIGTERM and
 * SIGINT to the child and exits with the child's own exit code.
 */
export const TEE_PROXY_SOURCE = `'use strict'

const { spawn } = require('node:child_process')
const { appendFileSync } = require('node:fs')
const { StringDecoder } = require('node:string_decoder')

const command = process.argv[2]
const argument = process.argv[3]
const logPath = process.argv[4]

const child = spawn(command, [argument], { stdio: ['pipe', 'pipe', 'inherit'] })
const pid = child.pid

// A StringDecoder per direction, not chunk.toString(): a chunk boundary can fall inside a multibyte
// character, and a lone replacement char would corrupt the logged frame. The forwarded BYTES are
// untouched either way — the pipe below is what carries them.
const decoders = { inbound: new StringDecoder('utf8'), outbound: new StringDecoder('utf8') }
const carries = { inbound: '', outbound: '' }
const markers = { inbound: '>', outbound: '<' }

const record = (direction, chunk) => {
  const merged = carries[direction] + decoders[direction].write(chunk)
  const lines = merged.split('\\n')

  carries[direction] = lines.pop()

  let batch = ''

  for (const line of lines) {
    if (line.length === 0) continue
    batch += markers[direction] + pid + '\\t' + line + '\\n'
  }

  if (batch.length > 0) appendFileSync(logPath, batch)
}

const flush = (direction) => {
  const carry = carries[direction] + decoders[direction].end()

  carries[direction] = ''

  if (carry.length === 0) return

  appendFileSync(logPath, markers[direction] + pid + '\\t' + carry + '\\n')
}

// EPIPE is expected on both ends once the child is gone; swallowing it keeps the proxy's own exit
// code equal to the child's instead of an unhandled-error 1.
child.stdin.on('error', () => {})
process.stdout.on('error', () => {})

process.stdin.on('data', (chunk) => record('inbound', chunk))
process.stdin.pipe(child.stdin)

child.stdout.on('data', (chunk) => record('outbound', chunk))
child.stdout.pipe(process.stdout)

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    child.kill(signal)
  })
}

child.on('error', (error) => {
  process.stderr.write('tee-proxy: spawn failed: ' + error.message + '\\n')
  process.exit(1)
})

// 'close', not 'exit': 'exit' can fire while child.stdout still has buffered data, and flushing the
// carry there would split a frame across two log lines.
child.on('close', (code) => {
  flush('inbound')
  flush('outbound')

  process.exitCode = code === null ? 1 : code
  process.stdin.destroy()
})
`

const SERVER_DISCOVER = 'server/discover'

const isFrame = (value: unknown): value is Frame => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const parseTeeLine = (line: string): { direction: 'inbound' | 'outbound'; pid: number; frame: Frame } | undefined => {
  const marker = line.slice(0, 1)
  const isInbound = marker === '>'
  const isOutbound = marker === '<'

  if (!isInbound && !isOutbound) return undefined

  const separator = line.indexOf('\t')

  if (separator < 0) return undefined

  const pidText = line.slice(1, separator)

  if (!/^\d+$/.test(pidText)) return undefined

  let parsed: unknown

  try {
    parsed = JSON.parse(line.slice(separator + 1))
  } catch {
    return undefined
  }

  if (!isFrame(parsed)) return undefined

  return { direction: isInbound ? 'inbound' : 'outbound', pid: Number(pidText), frame: parsed }
}

const isDiscoverSibling = (connection: { inbound: Frame[] }): boolean => {
  return connection.inbound.some((frame) => {
    return frame.method === SERVER_DISCOVER
  })
}

const selectServed = (byPid: Map<number, { inbound: Frame[]; outbound: Frame[] }>): TeeConnection => {
  const siblingPids: number[] = []
  const served: TeeConnection[] = []

  for (const [pid, connection] of byPid) {
    if (isDiscoverSibling(connection)) {
      siblingPids.push(pid)
      continue
    }

    served.push({ pid, inbound: connection.inbound, outbound: connection.outbound })
  }

  const only = served[0]

  if (served.length !== 1 || only === undefined) {
    const servedPids = served.map((connection) => {
      return connection.pid
    })

    throw new Error(
      `stdio-tee: expected exactly one served connection, found ${served.length}. ` +
        `Sibling pids (issued a '${SERVER_DISCOVER}' request): [${siblingPids.join(', ')}]; ` +
        `served pids: [${servedPids.join(', ')}]. ` +
        'A negotiated stdio connection tees exactly one disposable sibling and one served child; ' +
        'anything else means the client handshake changed and the selector must be revisited.',
    )
  }

  return only
}

/**
 * The pure half of `readTee`. Unrecognised lines are skipped and counted in `malformed` rather than
 * throwing, so a stray line of child stderr cannot fail an otherwise valid log.
 */
export const parseTeeLines = (lines: string[]): TeeLog => {
  const byPid = new Map<number, { inbound: Frame[]; outbound: Frame[] }>()
  let malformed = 0

  for (const line of lines) {
    if (line.length === 0) continue

    const record = parseTeeLine(line)

    if (record === undefined) {
      malformed += 1
      continue
    }

    let connection = byPid.get(record.pid)

    if (connection === undefined) {
      connection = { inbound: [], outbound: [] }
      byPid.set(record.pid, connection)
    }

    connection[record.direction].push(record.frame)
  }

  return {
    byPid,
    malformed,
    servedConnection: () => {
      return selectServed(byPid)
    },
  }
}

/** Reads a log written by `TEE_PROXY_SOURCE`. */
export const readTee = (logPath: string): TeeLog => {
  return parseTeeLines(readFileSync(logPath, 'utf8').split('\n'))
}
