#!/usr/bin/env node
// The hashbang must stay on line 1: this entry is published as the `ik-mcp` bin and is exec'd
// directly by the MCP client, not invoked as `node dist/mcp-proxy.js`.
import process from 'node:process'

import { bootPortlessLink } from 'src/dev/proxy/portless-link'
import { parseProxyArgv } from 'src/lib/mcp-proxy/argv'
import { proxyCacheDir, readBinaryVersion, readProfile, writeProfile } from 'src/lib/mcp-proxy/cache'
import type { UpstreamProfile } from 'src/lib/mcp-proxy/cache'
import { readListedVars, readUnlistedNames, resolveEnvFilePath } from 'src/lib/mcp-proxy/env-vars'
import type { ProxyVars } from 'src/lib/mcp-proxy/env-vars'
import { onEachLine } from 'src/lib/mcp-proxy/line-stream'
import { createUpstream } from 'src/lib/mcp-proxy/upstream'
import type { JsonRpcMessage, ProxySpec, Upstream } from 'src/lib/mcp-proxy/upstream'

const CREDENTIAL_POLL_MS = Number(process.env.IK_MCP_POLL_MS ?? 2000)

/**
 * Answered on a cold cache, when no upstream has ever been observed on this machine. Pinned rather
 * than echoed from the client: echoing back whatever a client asks for claims support for a
 * revision nothing here has ever spoken. Only `tools` is claimed — every MCP server has tools, not
 * every one has resources, and claiming `resources` for one that lacks them makes a client issue
 * `resources/list` and get "method not found".
 */
const FALLBACK_PROTOCOL_VERSION = '2025-06-18'
const FALLBACK_CAPABILITIES = { tools: { listChanged: true } }

const log = (message: string): void => {
  process.stderr.write(`ik-mcp: ${message}\n`)
}

const write = (payload: JsonRpcMessage): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

// This bin is the process Claude Code keeps alive, so it is where `~/.infra-kit/portless` converges on
// a machine that only ever runs the MCP surface. fs-only and synchronous — nothing is spawned before the
// handshake — and stdout is the transport, so only a failure earns a stderr line; the ordinary outcomes
// are `doctor`'s to show.
bootPortlessLink((result, message) => {
  if (result.outcome === 'failed')
    log(
      result.kind === 'link'
        ? `${message} failed: ${result.link} -> ${result.target}`
        : `${message} failed: ${result.node} <- ${result.source}`,
    )
})

const parsed = parseProxyArgv(process.argv.slice(2))

/**
 * Bad argv is the same state as "no credentials yet", not a crash: the handshake is answered, the
 * tool list is empty, and every other request says what is wrong and how to fix it. A proxy that
 * exits on a typo in `.mcp.json` is a dead server the client cannot recover.
 */
const degraded: string | null = parsed.ok
  ? null
  : `${parsed.problem} — run \`ik setup\` to regenerate this .mcp.json entry`
const spec: ProxySpec | null = parsed.ok ? parsed.spec : null

const upstream: Upstream | null =
  spec === null
    ? null
    : createUpstream(spec, {
        log,
        // Server-initiated notifications belong to the client and travel verbatim.
        onServerMessage: write,
        // Everything the launching shell picked up from the same env file, minus the listed names,
        // is deleted from the child's inherited environment.
        stripFromChildEnv: () => {
          return readUnlistedNames(spec.env)
        },
      })

const readVars = (): ProxyVars | null => {
  return spec === null ? null : readListedVars(spec.env)
}

// Both are resolved on first use, never at module load: `readBinaryVersion` spawns a process and
// can block for up to its timeout, and doing that before stdin is wired delays the handshake of
// every session — including ones that never touch the upstream.
let versionCache: string | null = null
let profileCache: UpstreamProfile | null | undefined

const binaryVersion = (): string => {
  versionCache ??=
    // No spec means no upstream to ask, and importing package.json for a version string would drag
    // the whole manifest — dependency names included — into a bundle the guard keeps flat.
    spec === null ? 'unknown' : readBinaryVersion(spec.command, ['--version'], process.env.PATH)

  return versionCache
}

const cacheDir = (): string | null => {
  return spec === null ? null : proxyCacheDir(spec.name)
}

const profile = (): UpstreamProfile | null => {
  if (profileCache === undefined) {
    const dir = cacheDir()

    profileCache = dir === null ? null : readProfile(binaryVersion(), dir)
  }

  return profileCache
}

/** Fold whatever the live upstream just told us into the on-disk profile. */
const rememberProfile = (patch: Partial<UpstreamProfile>): void => {
  const dir = cacheDir()

  if (dir === null) return

  const current = profile()

  const next: UpstreamProfile = {
    version: binaryVersion(),
    protocolVersion: patch.protocolVersion ?? current?.protocolVersion ?? FALLBACK_PROTOCOL_VERSION,
    capabilities: patch.capabilities ?? current?.capabilities ?? FALLBACK_CAPABILITIES,
    tools: patch.tools ?? current?.tools ?? [],
  }

  profileCache = next
  writeProfile(next, dir)
}

/**
 * Answer `initialize` without spawning anything.
 *
 * Spawning here would forfeit lazy start — a session that never touches the upstream would still
 * pay for a child. The cost is that a first-ever session reports the pinned fallback capabilities
 * and is corrected once a real handshake has been seen; MCP has no capability-change notification,
 * so that correction lands on the NEXT session.
 */
const answerInitialize = (message: JsonRpcMessage): void => {
  write({
    jsonrpc: '2.0',
    id: message.id,
    result: {
      protocolVersion: profile()?.protocolVersion ?? FALLBACK_PROTOCOL_VERSION,
      capabilities: profile()?.capabilities ?? FALLBACK_CAPABILITIES,
      serverInfo: { name: spec?.name ?? 'ik-mcp', version: binaryVersion() },
    },
  })
}

let announced = false

/**
 * Credentials arrive mid-session, and stdio keeps a server-to-client channel open the whole time —
 * so the moment they appear the client can be told to list again. Polls the env file ONLY: there is
 * no config to poll, so there is no mid-edit "invalid config" window and no path by which a watcher
 * could tear down a live upstream.
 */
const watchForCredentials = (): void => {
  const timer = setInterval(() => {
    if (announced || readVars() === null) return

    announced = true
    clearInterval(timer)
    log('credentials appeared — announcing tools/list_changed')
    write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }, CREDENTIAL_POLL_MS)

  timer.unref()
}

const forwardToolsList = async (message: JsonRpcMessage, vars: ProxyVars): Promise<void> => {
  const response = await upstream!.request(message, vars)
  const tools = (response.result as { tools?: unknown[] } | undefined)?.tools

  if (Array.isArray(tools)) {
    const handshake = upstream!.handshake()?.result as { protocolVersion?: string; capabilities?: unknown } | undefined

    rememberProfile({ tools, capabilities: handshake?.capabilities, protocolVersion: handshake?.protocolVersion })
  }

  write(response)
}

/** Before credentials exist, the tool list is answered from cache — never with an error. */
const answerToolsListFromCache = (message: JsonRpcMessage): void => {
  write({ jsonrpc: '2.0', id: message.id, result: { tools: profile()?.tools ?? [] } })
}

/** Answers the handshake and arms the watcher; deliberately spawns nothing. */
const handleInitialize = (message: JsonRpcMessage): void => {
  upstream?.setInitializeParams(message.params)
  answerInitialize(message)

  if (degraded !== null) {
    log(`degraded: ${degraded}`)

    return
  }

  // Always name the resolved path and the spec: when either is wrong (a stale XDG_CACHE_HOME, a
  // session id the client never inherited, a drifted .mcp.json) nothing else in the session says so.
  // Names only — the VALUES are credentials.
  log(
    `${spec!.name}: env file ${resolveEnvFilePath()}; reads ${spec!.env.join(', ')}; upstream ${spec!.command} ${binaryVersion()}; cache ${profile() ? 'warm' : 'cold'}`,
  )

  if (readVars() !== null) {
    announced = true

    return
  }

  log('no credentials yet — deferring')
  watchForCredentials()
}

/** The pre-`env-load` state (or bad argv), which is normal and must never look like a protocol failure. */
const answerWithoutCredentials = (message: JsonRpcMessage): void => {
  if (message.method === 'tools/list') {
    answerToolsListFromCache(message)

    return
  }

  if (message.id == null) return

  write({
    jsonrpc: '2.0',
    id: message.id,
    error: {
      code: -32000,
      message:
        degraded ?? `${spec!.name}: credentials are not loaded yet (${spec!.env.join(', ')}) — run 'ik env-load'`,
    },
  })
}

const handle = async (message: JsonRpcMessage): Promise<void> => {
  // An id with no method is a RESPONSE, not a request. A well-behaved client sends none — the
  // proxy refuses server-initiated requests, so there is nothing to answer — and treating one as a
  // request would spawn an upstream and reply `no method undefined`.
  if (message.method == null) return

  if (message.method === 'initialize') {
    handleInitialize(message)

    return
  }

  const vars = readVars()

  if (vars === null || upstream === null) {
    answerWithoutCredentials(message)

    return
  }

  if (message.id == null) {
    // Never spawns. `notifications/initialized` in particular is answered by not relaying it at
    // all: every child gets its own from the handshake replay, and forwarding the client's would
    // make the mandatory handshake defeat lazy start.
    if (message.method !== 'notifications/initialized') upstream.notifyIfActive(message)

    return
  }

  if (message.method === 'tools/list') {
    await forwardToolsList(message, vars)

    return
  }

  write(await upstream.request(message, vars))
}

const onLine = (line: string): void => {
  let message: JsonRpcMessage

  try {
    message = JSON.parse(line) as JsonRpcMessage
  } catch {
    log('ignoring non-JSON line from client')

    return
  }

  handle(message).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error)

    log(detail)

    if (message.id != null) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: detail } })
    }
  })
}

process.on('exit', () => {
  upstream?.dispose()
})
process.on('SIGTERM', () => {
  process.exit(0)
})
process.on('SIGINT', () => {
  process.exit(0)
})

onEachLine(process.stdin, onLine)

// The client closing its end is the ordinary way this server ends.
process.stdin.on('end', () => {
  process.exit(0)
})
