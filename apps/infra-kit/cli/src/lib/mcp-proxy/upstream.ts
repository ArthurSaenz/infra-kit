import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import type { ProxyVars } from './env-vars'
import { onEachLine } from './line-stream'
import { PROTECTED_CHILD_ENV_NAMES } from './protected-env'

export interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * What one configured server is: the argv-borne half of an `mcp.<name>` entry.
 *
 * `env` names are injected inline from {@link ProxyVars}; `unset` names are forced empty so a stale
 * file-based credential can never outrank the inline one (measured for mcp-grafana: an inline token
 * takes precedence over `..._TOKEN_FILE`, but only if the file variable is not also set).
 */
export interface ProxySpec {
  name: string
  command: string
  args: readonly string[]
  env: readonly string[]
  unset: readonly string[]
}

export interface UpstreamOptions {
  extraEnv?: NodeJS.ProcessEnv
  readyTimeoutMs?: number
  /**
   * Per-request ceiling. A child that answers the handshake and then goes silent must
   *  not hang every later request for the rest of the session.
   */
  requestTimeoutMs?: number
  /**
   * Names to DELETE from the child's inherited environment — the unlisted secrets the
   * launching shell picked up from the same env file.
   */
  stripFromChildEnv?: () => readonly string[]
  log?: (message: string) => void
  /** Notifications and server-initiated requests, which travel to the client verbatim. */
  onServerMessage?: (message: JsonRpcMessage) => void
}

/** `go install` lands the binary in GOBIN, which a GUI-launched process never has on PATH. */
const goBinDir = (): string => {
  const explicit = process.env.GOBIN

  if (explicit != null && explicit.length > 0) return explicit

  const goPath = process.env.GOPATH

  return path.join(goPath != null && goPath.length > 0 ? goPath : path.join(os.homedir(), 'go'), 'bin')
}

const DEFAULT_READY_TIMEOUT_MS = 15_000
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

const NEVER_STRIP = PROTECTED_CHILD_ENV_NAMES

interface Deferred {
  /** Absent for the shim's OWN requests, whose answers must never reach the client. */
  clientId?: string | number
  resolve: (message: JsonRpcMessage) => void
  reject: (error: Error) => void
}

interface Session {
  child: ChildProcessWithoutNullStreams
  /** JSON of the ordered vars record — the respawn key. */
  key: string
  generation: number
  pending: Map<number, Deferred>
  nextId: number
  handshake: JsonRpcMessage | null
  closed: boolean
}

export interface Upstream {
  setInitializeParams: (params: unknown) => void
  request: (message: JsonRpcMessage, vars: ProxyVars) => Promise<JsonRpcMessage>
  /** Forwards only when an upstream already exists; never spawns one. */
  notifyIfActive: (message: JsonRpcMessage) => boolean
  /** The upstream's own `initialize` result, once one has been observed. */
  handshake: () => JsonRpcMessage | null
  dispose: () => void
}

export const createUpstream = (spec: ProxySpec, options: UpstreamOptions = {}): Upstream => {
  const binary = spec.command
  const args = spec.args
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const log = options.log ?? ((): void => {})
  const onServerMessage = options.onServerMessage ?? ((): void => {})

  const searchPath = `${goBinDir()}${path.delimiter}${process.env.PATH ?? ''}`

  let initializeParams: unknown = {}
  let active: Session | null = null
  let starting: { key: string; generation: number; promise: Promise<Session> } | null = null
  let generation = 0

  const failPending = (session: Session, reason: string): void => {
    for (const deferred of session.pending.values()) deferred.reject(new Error(reason))
    session.pending.clear()
  }

  const closeSession = (session: Session, reason: string): void => {
    if (session.closed) return

    session.closed = true
    // In-flight work is ERRORED, never silently dropped: a caller waiting on a killed
    // upstream would otherwise hang for the rest of the session.
    failPending(session, `${spec.name} upstream ${reason}`)
    session.child.kill()
  }

  // A response carries an id and no method; anything with a method is server-initiated
  // and belongs to the client. Routing on `method` first is what keeps the shim's own
  // ids from ever being confused with the client's.
  const handleLine = (session: Session, line: string): void => {
    let message: JsonRpcMessage

    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      log(`ignoring non-JSON line from ${binary}`)

      return
    }

    if (message.method != null) {
      if (message.id == null) {
        onServerMessage(message)

        return
      }

      // A server-initiated REQUEST carries the upstream's own id. Relaying it would send
      // the client an id from a namespace it does not own, and the client's answer would
      // re-enter as a fresh request with no method. mcp-grafana initiates none today, so
      // refusing is honest and cannot mis-route.
      log(`refusing server-initiated request ${message.method}`)
      send(session, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'client requests are not supported by this shim' },
      })

      return
    }

    if (message.id == null) return

    const deferred = session.pending.get(Number(message.id))

    if (!deferred) return

    session.pending.delete(Number(message.id))

    // Map back: the client only ever sees the id IT chose. Resolving with the wire id
    // would hand the client an answer labelled with the shim's private numbering.
    deferred.resolve(deferred.clientId === undefined ? message : { ...message, id: deferred.clientId })
  }

  const send = (session: Session, message: JsonRpcMessage): void => {
    if (session.closed) return

    session.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /**
   * Send on the shim's OWN id namespace and await the answer.
   *
   * `clientId` is what makes the namespace real: present, the answer is re-labelled and
   * relayed; absent, it is consumed here. The replayed handshake takes the absent form,
   * so a client request numbered `0` can never collide with it.
   */
  const sendRequest = (
    session: Session,
    message: JsonRpcMessage,
    clientId?: string | number,
  ): Promise<JsonRpcMessage> => {
    // A session can be closed between `ensure` resolving and the write landing — a
    // dispose, a crash, a swap. Registering here anyway would leave the caller pending
    // forever, because the rejection sweep has already run.
    if (session.closed) return Promise.reject(new Error(`${spec.name} upstream is closed`))

    const upstreamId = session.nextId

    session.nextId += 1

    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(upstreamId)
        reject(new Error(`${binary} did not answer ${message.method ?? 'request'} within ${requestTimeoutMs}ms`))
      }, requestTimeoutMs)

      session.pending.set(upstreamId, {
        clientId,
        resolve: (answer: JsonRpcMessage): void => {
          clearTimeout(timer)
          resolve(answer)
        },
        reject: (error: Error): void => {
          clearTimeout(timer)
          reject(error)
        },
      })
      send(session, { ...message, jsonrpc: '2.0', id: upstreamId })
    })
  }

  const withDeadline = async (promise: Promise<JsonRpcMessage>): Promise<JsonRpcMessage> => {
    let timer: NodeJS.Timeout | undefined

    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${binary} did not answer initialize within ${readyTimeoutMs}ms`))
      }, readyTimeoutMs)
    })

    try {
      return await Promise.race([promise, deadline])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const spawnChild = (vars: ProxyVars): ChildProcessWithoutNullStreams => {
    // Listed variables go INLINE — no credential is written to disk by this proxy at all.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...options.extraEnv, PATH: searchPath, ...vars }

    // Forced empty rather than deleted: a deleted name would be re-inherited by anything the
    // child spawns from ITS parent's environment; an empty string is an explicit "no".
    for (const name of spec.unset) childEnv[name] = ''

    // Applied LAST, over the fully merged environment, so no earlier layer can put a
    // secret back. The proxy is normally launched from a shell that sourced the very env
    // file these names came from, and inheritance — not the listed-names read filter — is
    // the path by which a production secret would otherwise reach the child.
    for (const name of options.stripFromChildEnv?.() ?? []) {
      if (!NEVER_STRIP.has(name)) delete childEnv[name]
    }

    return spawn(binary, [...args], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
  }

  const startSession = async (vars: ProxyVars, gen: number): Promise<Session> => {
    const child = spawnChild(vars)

    const session: Session = {
      child,
      key: JSON.stringify(vars),
      generation: gen,
      pending: new Map(),
      nextId: 1,
      handshake: null,
      closed: false,
    }

    onEachLine(child.stdout, (line) => {
      handleLine(session, line)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      // Per LINE, not per chunk: mcp-grafana emits several log lines in one write, and
      // prefixing only the first leaves the rest looking like they came from elsewhere —
      // which matters, because this is the only window into the upstream a user gets.
      for (const line of chunk.toString().trimEnd().split('\n')) {
        if (line.length > 0) log(`${binary}: ${line}`)
      }
    })

    child.on('error', (error: Error) => {
      closeSession(session, `failed to start: ${error.message}`)
    })

    child.on('exit', (code) => {
      closeSession(session, `exited with code ${String(code)}`)
    })

    try {
      // A child that spawns and never answers must not hang every later request, so the
      // handshake — not the spawn — is what readiness means, and it is bounded.
      session.handshake = await withDeadline(sendRequest(session, { method: 'initialize', params: initializeParams }))
    } catch (error) {
      closeSession(session, 'handshake failed')
      throw error
    }

    send(session, { jsonrpc: '2.0', method: 'notifications/initialized' })
    log(`serving ${spec.name} (${binary})`)

    return session
  }

  const ensure = async (vars: ProxyVars): Promise<Session> => {
    const key = JSON.stringify(vars)

    if (active && !active.closed && active.key === key) return active
    if (starting && starting.key === key) return starting.promise

    generation += 1

    const gen = generation

    // Which variable changed is deliberately not logged: the values are credentials.
    if (active) log(`${spec.name}: a listed variable changed — replacing upstream`)

    const promise = (async (): Promise<Session> => {
      const session = await startSession(vars, gen)

      // A newer target superseded this start while it was in flight. Binding to it now
      // would serve the OLD credentials for the rest of the session.
      if (gen !== generation) {
        closeSession(session, 'superseded by a newer target')
        throw new Error(`${spec.name} upstream superseded by a newer target`)
      }

      if (active) closeSession(active, 'replaced')
      active = session

      return session
    })()

    starting = { key, generation: gen, promise }

    try {
      return await promise
    } finally {
      if (starting?.generation === gen) starting = null
    }
  }

  return {
    setInitializeParams: (params: unknown): void => {
      initializeParams = params
    },
    request: async (message: JsonRpcMessage, vars: ProxyVars): Promise<JsonRpcMessage> => {
      const session = await ensure(vars)

      return sendRequest(session, { method: message.method, params: message.params }, message.id)
    },
    notifyIfActive: (message: JsonRpcMessage): boolean => {
      // Deliberately does NOT call `ensure`. A client notification arriving before any
      // request would otherwise spawn an upstream for a session that has asked the
      // server nothing — which is exactly what lazy start exists to avoid.
      if (!active || active.closed) return false

      send(active, { jsonrpc: '2.0', method: message.method, params: message.params })

      return true
    },
    handshake: (): JsonRpcMessage | null => {
      return active?.handshake ?? null
    },
    dispose: (): void => {
      if (active) closeSession(active, 'disposed')
      active = null
    },
  }
}
