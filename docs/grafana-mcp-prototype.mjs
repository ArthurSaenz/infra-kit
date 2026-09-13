#!/usr/bin/env node
// Grafana MCP for a Claude session whose credentials do not exist yet.
//
// Claude spawns this at session start and freezes a copy of its environment, but
// `ik env-load` runs later, inside the session, and its exports die with the Bash
// subshell that ran them. The one durable trace it leaves is the session env file
// — so that file, not the inherited environment, is the channel.
//
// Three measured facts shape the design:
//   1. mcp-grafana re-reads GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE per request, but
//      only over streamable-http; under stdio it builds one client and stops.
//      Hence the local http hop.
//   2. X-Grafana-URL is ignored, so a URL change means a new upstream process,
//      and any session bound to the old one must be re-established.
//   3. Claude Code has no reconnect, so nothing here may answer a handshake with
//      a hard failure — a session that starts toolless stays toolless.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

const SESSION = process.env.INFRA_KIT_SESSION || 'no-session'
const ENV_FILE =
  process.env.MCP_GRAFANA_ENV_FILE || path.join(os.homedir(), '.cache', 'infra-kit', SESSION, 'env-load.sh')

const CACHE_DIR = process.env.MCP_GRAFANA_CACHE_DIR || path.join(os.homedir(), '.infra-kit', 'mcp-grafana')
const TOOLS_CACHE = path.join(CACHE_DIR, 'tools.json')

const BINARY = process.env.MCP_GRAFANA_BIN || 'mcp-grafana'
const GO_BIN = process.env.GOBIN || path.join(process.env.GOPATH || path.join(os.homedir(), 'go'), 'bin')
const SEARCH_PATH = `${GO_BIN}${path.delimiter}${process.env.PATH || ''}`

const READY_TIMEOUT_MS = 15000
const READY_POLL_MS = 100
const CREDENTIAL_POLL_MS = 2000

const log = (message) => process.stderr.write(`mcp-grafana: ${message}\n`)
const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)

// env-load.sh is `set -a` followed by KEY='value', with embedded quotes written as
// the shell's '\'' escape. Only Grafana keys are read: the file also holds
// unrelated production credentials that have no business leaving this process.
const readCredentials = () => {
  const found = {}

  if (existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const match = /^([A-Z_][A-Z0-9_]*)='(.*)'$/.exec(line)
      if (!match) continue

      const [, key, rawValue] = match
      if (key.startsWith('GRAFANA_')) found[key] = rawValue.split("'\\''").join("'")
    }
  }

  const url = found.GRAFANA_URL || process.env.GRAFANA_URL || ''
  const token =
    found.GRAFANA_SERVICE_ACCOUNT_TOKEN ||
    found.GRAFANA_API_KEY ||
    process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN ||
    process.env.GRAFANA_API_KEY ||
    ''

  return url && token ? { url, token } : null
}

mkdirSync(CACHE_DIR, { recursive: true })

const tokenPath = path.join(CACHE_DIR, `token-${process.pid}`)
let lastToken = null

const publishToken = (token) => {
  if (token === lastToken) return

  writeFileSync(tokenPath, token, { mode: 0o600 })
  lastToken = token
}

let upstream = null
let upstreamUrl = null
let upstreamPort = null
let upstreamSid = null
let starting = null

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

const waitForPort = async (port) => {
  const deadline = Date.now() + READY_TIMEOUT_MS

  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.on('connect', () => socket.end(() => resolve(true)))
      socket.on('error', () => resolve(false))
    })

    if (open) return
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
  }

  throw new Error(`${BINARY} did not open port ${port}`)
}

const upstreamPost = (payload, sid) =>
  fetch(`http://localhost:${upstreamPort}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sid ? { 'Mcp-Session-Id': sid } : {}),
    },
    body: JSON.stringify(payload),
  })

let clientInitParams = null

// Started only when a Grafana call is actually made, so a session that never
// touches Grafana costs nothing beyond this script.
const ensureUpstream = async ({ url, token }) => {
  publishToken(token)

  if (upstream && upstreamUrl === url) return
  if (starting) return starting

  if (upstream) {
    log(`GRAFANA_URL changed to ${url} — replacing upstream`)
    upstream.kill()
    upstream = null
    upstreamSid = null
  }

  starting = (async () => {
    const port = await freePort()

    const child = spawn(
      BINARY,
      [
        '-t',
        'streamable-http',
        '-address',
        `localhost:${port}`,
        '-endpoint-path',
        '/mcp',
        // Reaping a session a long-idle Claude still holds would be unrecoverable
        // on the client side, so it is switched off.
        '-session-idle-timeout-minutes',
        '0',
      ],
      {
        env: {
          ...process.env,
          PATH: SEARCH_PATH,
          GRAFANA_URL: url,
          GRAFANA_SERVICE_ACCOUNT_TOKEN: '',
          GRAFANA_API_KEY: '',
          GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE: tokenPath,
        },
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    )

    child.on('exit', (code) => {
      if (upstream !== child) return

      log(`${BINARY} exited with code ${code}`)
      upstream = null
      upstreamSid = null
    })

    upstream = child
    upstreamUrl = url
    upstreamPort = port

    await waitForPort(port)

    // Replay the client's handshake so its session exists on this process.
    const handshake = await upstreamPost(
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: clientInitParams },
      null,
    )
    upstreamSid = handshake.headers.get('mcp-session-id')
    if (handshake.body) await handshake.arrayBuffer()

    await upstreamPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, upstreamSid)

    log(`serving ${url}`)
  })()

  try {
    await starting
  } finally {
    starting = null
  }
}

// A streamable-http response is either one JSON body or an SSE stream; both carry
// JSON-RPC messages that go to stdout verbatim.
const relay = async (response) => {
  if (response.status === 202 || !response.body) return

  if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
    process.stdout.write(`${await response.text()}\n`)
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })

    let boundary = buffer.indexOf('\n\n')

    while (boundary !== -1) {
      const event = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue

        const data = line.slice(5).trim()
        if (data) process.stdout.write(`${data}\n`)
      }

      boundary = buffer.indexOf('\n\n')
    }
  }
}

const cachedTools = () => {
  try {
    return JSON.parse(readFileSync(TOOLS_CACHE, 'utf8'))
  } catch {
    return null
  }
}

const forward = async (message, credentials) => {
  await ensureUpstream(credentials)

  const response = await upstreamPost(message, upstreamSid)

  // The tool list is stable per mcp-grafana version, so caching it lets a future
  // session answer tools/list before any credentials exist.
  if (message.method === 'tools/list') {
    const clone = response.clone()

    relay(response).catch((error) => log(error.message))

    try {
      const text = await clone.text()
      const payload = JSON.parse(text.includes('data:') ? text.split('data:')[1].trim() : text)
      if (payload.result?.tools) writeFileSync(TOOLS_CACHE, JSON.stringify(payload.result))
    } catch {
      // Caching is opportunistic; a miss costs nothing.
    }

    return
  }

  await relay(response)
}

let announcedTools = false

// Credentials arrive mid-session. stdio keeps a server-to-client channel open the
// whole time, so the moment they show up the client can be told to list again —
// which is what rescues a session that started with nothing.
const watchForCredentials = () => {
  const timer = setInterval(() => {
    if (announcedTools || !readCredentials()) return

    announcedTools = true
    clearInterval(timer)
    log('credentials appeared — announcing tools/list_changed')
    write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }, CREDENTIAL_POLL_MS)

  timer.unref()
}

const handle = async (message) => {
  const credentials = readCredentials()

  if (message.method === 'initialize') {
    clientInitParams = message.params

    if (credentials) {
      announcedTools = true
      await forward(message, credentials)
      return
    }

    // Answering ourselves keeps the session alive until `ik env-load` runs. The
    // capabilities mirror what mcp-grafana reports, listChanged included.
    log(`no Grafana credentials in ${ENV_FILE} yet — deferring`)
    watchForCredentials()

    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { resources: {}, tools: { listChanged: true } },
        serverInfo: { name: 'mcp-grafana', version: 'pending-credentials' },
      },
    })
    return
  }

  if (!credentials) {
    if (message.method === 'tools/list') {
      const cached = cachedTools()
      write({ jsonrpc: '2.0', id: message.id, result: cached || { tools: [] } })
      return
    }

    if (message.id !== undefined) {
      write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: `Grafana credentials are not loaded yet — run 'ik env-load'` },
      })
    }
    return
  }

  await forward(message, credentials)
}

process.on('exit', () => {
  if (upstream && !upstream.killed) upstream.kill()
})
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

createInterface({ input: process.stdin })
  .on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    let message

    try {
      message = JSON.parse(trimmed)
    } catch {
      log('ignoring non-JSON line from client')
      return
    }

    handle(message).catch((error) => {
      log(error.message)

      if (message.id !== undefined) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } })
      }
    })
  })
  .on('close', () => process.exit(0))
