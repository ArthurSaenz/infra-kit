#!/usr/bin/env node
// A stand-in for `mcp-grafana -t stdio`: newline-delimited JSON-RPC on stdin/stdout.
//
// Behaviour is driven entirely by env vars so one fixture covers every case the
// lifecycle tests need, including the ones that must NOT answer.
//
//   FAKE_NEVER_ANSWER_INIT=1  swallow `initialize` forever (N2's deadline)
//   FAKE_INIT_DELAY_MS=<n>    answer `initialize` after n ms (M1's cold-start race)
//   FAKE_TAG=<s>              echoed back in serverInfo.name so tests can tell
//                             one generation of child from the next
//
// It reports the credentials it was given so a test can prove which upstream a call
// actually reached, and appends its own pid to FAKE_SPAWN_LOG so spawn COUNTS are
// observable rather than inferred.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const url = process.env.GRAFANA_URL || ''
const token = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN || ''
const tag = process.env.FAKE_TAG || ''

if (process.env.FAKE_SPAWN_LOG) {
  const tokenFile = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE || ''

  // `leaked` reports whether a named non-Grafana secret survived into this child's
  // environment — the inheritance path the GRAFANA_ filter alone does not close.
  const leaked = process.env[process.env.FAKE_LEAK_PROBE || 'NOPE'] || ''

  appendFileSync(
    process.env.FAKE_SPAWN_LOG,
    `${JSON.stringify({ pid: process.pid, url, token, tag, tokenFile, leaked })}\n`,
  )
}

// Every inbound method WITH the id it arrived under. This is what makes the shim's id
// namespace observable: a test can prove the replayed handshake and a client request
// numbered 0 never share an id.
const logMethod = (message) => {
  if (!process.env.FAKE_METHOD_LOG) return

  appendFileSync(process.env.FAKE_METHOD_LOG, `${JSON.stringify({ method: message.method, id: message.id })}\n`)
}

const write = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

const tools = [{ name: 'search_dashboards', description: `from ${url}` }]

const handle = (message) => {
  const { id, method } = message

  logMethod(message)

  if (method === 'initialize') {
    if (process.env.FAKE_NEVER_ANSWER_INIT === '1') return

    const reply = () => {
      write({
        jsonrpc: '2.0',
        id,
        result: {
          // Overridable so a test can tell a CACHED handshake from the shim's pinned
          // cold-start fallback — identical values would make that assertion vacuous.
          protocolVersion: process.env.FAKE_PROTOCOL_VERSION || '2025-06-18',
          capabilities: {
            tools: { listChanged: true },
            resources: {},
            experimental: { fakeUpstream: tag || 'yes' },
          },
          serverInfo: { name: 'fake-mcp-grafana', version: tag || '1.3.0' },
        },
      })
    }

    const delay = Number(process.env.FAKE_INIT_DELAY_MS || 0)

    if (delay > 0) setTimeout(reply, delay)
    else reply()

    return
  }

  if (method === 'notifications/initialized') return

  // Answer the handshake, then go silent — the shape that used to hang every later
  // request for the rest of the session, because only `initialize` had a deadline.
  if ((process.env.FAKE_SILENT_METHODS || '').split(',').includes(method)) return

  if (method === 'emit/request') {
    // A server-initiated REQUEST. Relaying it would hand the client an id from the
    // upstream's own namespace.
    write({ jsonrpc: '2.0', id: 991, method: 'sampling/createMessage', params: {} })
    write({ jsonrpc: '2.0', id, result: { ok: true } })

    return
  }

  if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id, result: { tools } })

    return
  }

  if (method === 'tools/call') {
    // The whole point of the swap tests: prove WHICH upstream served the call.
    write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${url}|${token}|${tag}` }] } })

    return
  }

  if (method === 'emit/notification') {
    // Server-initiated traffic, to prove the shim relays it (Option A dropped it).
    write({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: tag } })
    write({ jsonrpc: '2.0', id, result: { ok: true } })

    return
  }

  if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim()

  if (!trimmed) return

  try {
    handle(JSON.parse(trimmed))
  } catch {
    // A malformed line is the client's problem, not ours.
  }
})
