import { Logger } from '@aws-lambda-powertools/logger'
import type { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters, Context } from 'aws-lambda'
import fastify from 'fastify'
import * as fs from 'node:fs'
import type { Server } from 'node:http'
import * as path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

import type { ILogger } from './interfaces.js'
import { enterAttribution, runAttributed } from './log-attribution.js'

export interface IServerConfig {
  controllersPath: string
  prefixUrl?: string
  /**
   * PREFERRED bind port. A number is tried first and, on `EADDRINUSE`, the runner falls
   * back to an ephemeral `listen(0)` port. `undefined` (no explicit config) binds an
   * ephemeral port straight away. After {@link ServerlessLocalRun.start} the field is
   * mutated in place to the ACTUAL bound port so `/__health` reports the real port.
   */
  port?: number
  /** App folder name, surfaced by the `/__health` endpoint. Optional. */
  appName?: string
  /**
   * Structured per-request sink. When provided, every response emits `{ method, path, status, ms }`
   * (path already trimmed of any query string) so the caller can tag + timestamp it — the dev-server
   * routes this into its renderer's live tail. Independent of the env-gated raw stdout line below.
   */
  onRequestLog?: (event: { method: string; path: string; status: number; ms: number }) => void
  /**
   * The service tag (`<app>/api`) every line this app emits is filed under — a handler's `console.log`,
   * a Powertools line, a dependency's banner. The backend is IN-PROCESS and multi-app, so nothing in a
   * raw stdout write says which app wrote it; entering an `AsyncLocalStorage` context per request is
   * what makes the attribution possible at all. Omit → those lines land in the runner's fallback bucket.
   */
  serviceTag?: string
}

/** True when a listen error is a port-already-in-use (`EADDRINUSE`) failure. */
const isAddressInUse = (error: unknown): boolean => {
  return (error as { code?: string } | null)?.code === 'EADDRINUSE'
}

type HandlerResult = Promise<{ body: string; headers: Record<string, string>; statusCode: number }>

/** Default simulated Lambda timeout; overridable via `DEV_SERVER_TIMEOUT_MS`. */
const DEFAULT_LAMBDA_TIMEOUT_MS = 30_000

/** Resolve the simulated Lambda timeout (ms), honoring `DEV_SERVER_TIMEOUT_MS` when it parses. */
const resolveLambdaTimeoutMs = (): number => {
  const raw = Number.parseInt(process.env.DEV_SERVER_TIMEOUT_MS ?? '', 10)

  return Number.isNaN(raw) ? DEFAULT_LAMBDA_TIMEOUT_MS : raw
}

/**
 * Whether to emit a one-line `<method> <url> → <status> <ms>ms` log per request.
 * Off by default; opt in with `DEV_SERVER_REQUEST_LOG=1` (kept out of the Powertools
 * JSON logger so the line stays terminal-readable). Mirrors the env-reader precedent
 * of {@link resolveLambdaTimeoutMs}.
 */
const isRequestLogEnabled = (): boolean => {
  return process.env.DEV_SERVER_REQUEST_LOG === '1'
}

export class ServerlessLocalRun {
  /** Busts Node ESM `import()` cache on each new server instance (watch restart). */
  private readonly importCacheBust: string
  private readonly logger: Logger
  private readonly server: ReturnType<typeof fastify>
  private readonly controllers: Record<
    string,
    {
      action: Record<string, (event: APIGatewayProxyEvent, ctx: Context, log: ILogger) => HandlerResult>
      handler: string
    }
  > = {}

  /** `method urlAction` keys reserved synchronously, so duplicates are caught before any async import. */
  private readonly registeredRouteKeys = new Set<string>()

  constructor(private readonly serverConfig: IServerConfig) {
    this.importCacheBust = `${Date.now()}`
    this.logger = new Logger({ serviceName: 'LocalServer', logLevel: 'DEBUG' })
    this.serverConfig.prefixUrl = this.serverConfig.prefixUrl ?? ''
    this.server = fastify({ logger: false })

    // Add CORS support for local development
    this.server.addHook(
      'onRequest',
      async (
        request: { method: string },
        reply: { header: (k: string, v: string) => unknown; status: (n: number) => { send: () => void } },
      ) => {
        // Claim every line the rest of this request emits for this app. `enterWith` (not `run`) because
        // fastify owns the call into the handler — we cannot wrap it. Entering here makes the WHOLE
        // remaining hook chain a continuation of this context: the handler, `onResponse` (where the raw
        // request line is written), and the error handler all attribute to the same app.
        const serviceTag = this.serverConfig.serviceTag

        if (serviceTag != null) enterAttribution(serviceTag)

        reply.header('Access-Control-Allow-Origin', '*')
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')

        // Handle preflight OPTIONS requests
        if (request.method === 'OPTIONS') {
          reply.status(204).send()
        }
      },
    )

    // Per-request visibility for live dev traffic. Two independent sinks: a structured
    // `onRequestLog` callback (the dev-server tags + timestamps it in its tail) and/or the
    // legacy env-gated raw stdout line (standalone use). Registered only when at least one is on.
    const onRequestLog = this.serverConfig.onRequestLog

    if (isRequestLogEnabled() || onRequestLog) {
      this.server.addHook(
        'onResponse',
        async (request: { method: string; url: string }, reply: { statusCode: number; elapsedTime: number }) => {
          const ms = Math.round(reply.elapsedTime)
          // Trim the query string so the tail shows a clean route, not `?a=b` noise.
          const requestPath = request.url.split('?')[0] ?? request.url

          onRequestLog?.({ method: request.method, path: requestPath, status: reply.statusCode, ms })
          if (isRequestLogEnabled()) {
            process.stdout.write(`${request.method} ${request.url} → ${reply.statusCode} ${ms}ms\n`)
          }
        },
      )
    }
  }

  /**
   * The registered `METHOD /path` route keys (sorted). Excludes the internal
   * `/__health` liveness route, which is registered outside {@link defineRoute} and
   * never added to {@link registeredRouteKeys}. Used by the runner's startup route dump.
   */
  public getRegisteredRoutes(): string[] {
    return [...this.registeredRouteKeys].sort()
  }

  /**
   * Boot the server and RETURN the actual bound port. Under dynamic allocation the port is
   * a runtime fact known only after `listen`, so the caller must consume this return value
   * (never the static config port). {@link serverConfig.port} is mutated in place to the
   * bound port so `/__health` reports the real value.
   */
  public async start(): Promise<number> {
    this.registerHealthRoute()

    await Promise.all(this.loadRoutes())

    const boundPort = await this.listenWithFallback()

    this.serverConfig.port = boundPort

    this.logger.info(`Server listening on http://127.0.0.1:${boundPort}`, {
      address: `http://127.0.0.1:${boundPort}`,
    })

    return boundPort
  }

  /**
   * Bind the server and return the ACTUAL bound port. With an explicitly-configured
   * preferred port, try it first and fall back to an ephemeral `listen(0)` on `EADDRINUSE`
   * so extra worktrees never collide; with no preferred port (`undefined`), bind ephemeral
   * straight away. Non-`EADDRINUSE` errors propagate.
   */
  private async listenWithFallback(): Promise<number> {
    const preferred = this.serverConfig.port

    if (preferred != null) {
      try {
        await this.server.listen({ port: preferred, host: '127.0.0.1' })

        return this.readBoundPort()
      } catch (error) {
        if (!isAddressInUse(error)) {
          throw error
        }
      }
    }

    await this.server.listen({ port: 0, host: '127.0.0.1' })

    return this.readBoundPort()
  }

  /** Read the concrete bound port from the underlying HTTP server after `listen`. */
  private readBoundPort(): number {
    const address = (this.server.server as Server).address()

    if (address == null || typeof address === 'string') {
      throw new Error('Server address unavailable after listen()')
    }

    return address.port
  }

  /** Close the server (for watch/restart). */
  public async close(): Promise<void> {
    const raw = this.server.server as Server

    if (typeof raw.closeAllConnections === 'function') {
      raw.closeAllConnections()
    }
    await this.server.close()
  }

  /**
   * Register a fixed `GET /__health` liveness route returning 200. The path is
   * unprefixed (serverless.yml routes carry the `prefixUrl`, e.g. `/api/v1/...`),
   * so it never collides with a handler route.
   */
  private registerHealthRoute(): void {
    this.server.route({
      method: 'GET',
      url: '/__health',
      handler: (_request: unknown, reply: { code: (n: number) => { send: (body: unknown) => void } }) => {
        return reply.code(200).send({
          status: 'ok',
          app: this.serverConfig.appName ?? null,
          port: this.serverConfig.port,
        })
      },
    })
  }

  private loadRoutes(): Promise<void>[] {
    const serverlessYmlPath = path.join(this.serverConfig.controllersPath, 'serverless.yml')
    const fileContents = fs.readFileSync(serverlessYmlPath, 'utf8')
    const data = parseYaml(fileContents) as {
      functions: Record<string, { events?: Array<{ http?: { method: string; path: string } }>; handler?: string }>
    }
    const p: Promise<void>[] = []

    if (!data?.functions) return p

    for (const funcDef of Object.values(data.functions)) {
      if (!funcDef?.events?.length) continue
      for (const element of funcDef.events) {
        const http = element?.http

        if (!http) continue
        p.push(this.defineRoute(http, funcDef))
      }
    }

    return p
  }

  private async defineRoute(http: { method: string; path: string }, funcDef: { handler?: string }): Promise<void> {
    let url = http.path.toString()

    url = url.replaceAll('{', ':').replaceAll('}', '')

    let urlAction = path.posix.join(this.serverConfig.prefixUrl ?? '', url)

    urlAction = urlAction[0] === '/' ? urlAction : `/${urlAction}`

    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
    const method = String(http.method).toUpperCase()

    if (!validMethods.includes(method)) {
      throw new Error(`Invalid HTTP method: "${http.method}" for URL: ${urlAction}`)
    }

    // Key on method + path: two events can share a path but differ by method (e.g. GET/POST /users),
    // so keying on the path alone would let one handler overwrite the other. Reserve the key
    // synchronously (before the first `await`) so concurrent route loads detect a true duplicate.
    const routeKey = `${method} ${urlAction}`

    if (this.registeredRouteKeys.has(routeKey)) {
      throw new Error(`Duplicate route: ${routeKey}`)
    }
    this.registeredRouteKeys.add(routeKey)

    const handlerStr = funcDef.handler ?? ''
    const parts = handlerStr.split('.')
    const filepath = parts[0] ?? ''
    const handler = parts[1] ?? ''

    const controllerPath = path.join(this.serverConfig.controllersPath, `${filepath}.js`)
    const fileUrl = pathToFileURL(controllerPath)

    // Search params bust Node's ESM import cache so watch rebuilds load new `dist` output.
    fileUrl.searchParams.set('v', this.importCacheBust)

    // Attribute the handler module's IMPORT-TIME output — a banner from one of its deps, a top-level
    // log — to this app rather than the runner's fallback bucket. Honest limit: a library shared by two
    // apps is ONE module instance, so anything it registers at import keeps whichever app loaded it
    // first. That is inference, not declaration; the fallback bucket is named precisely so the wrong
    // guess is never made silently.
    const serviceTag = this.serverConfig.serviceTag
    const importHandler = async (): Promise<
      Record<string, (event: APIGatewayProxyEvent, ctx: Context, log: ILogger) => HandlerResult>
    > => {
      return (await import(fileUrl.href)) as Record<
        string,
        (event: APIGatewayProxyEvent, ctx: Context, log: ILogger) => HandlerResult
      >
    }
    const action = serviceTag == null ? await importHandler() : await runAttributed(serviceTag, importHandler)

    this.controllers[routeKey] = { action, handler }

    const traceLogger = this.logger.createChild({ serviceName: 'RequestLogger' })

    this.server.route({
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
      url: urlAction,
      handler: async (
        request: { body?: unknown; query?: unknown; params?: unknown; headers?: unknown },
        reply: {
          headers: (h: Record<string, string>) => unknown
          code: (n: number) => { send: (body: unknown) => void }
        },
      ) => {
        const controller = this.controllers[routeKey]

        if (!controller) throw new Error(`No controller for ${routeKey}`)
        const handlerFn = controller.action[controller.handler]

        if (!handlerFn) throw new Error(`No handler ${controller.handler} for ${urlAction}`)
        const retVal = await handlerFn(
          this.getEventObj(request.body, request.query, request.params, request.headers, method, urlAction),
          this.getContext(),
          traceLogger,
        )
        const responseBody = JSON.parse(retVal.body)

        reply.headers(retVal.headers ?? {})

        return reply.code(retVal?.statusCode ?? 500).send(responseBody)
      },
    })
  }

  private getEventObj(
    requestBody?: unknown,
    queryParams?: unknown,
    pathParameters?: unknown,
    headers?: unknown,
    httpMethod = '',
    path = '',
  ): APIGatewayProxyEvent {
    const retVal = {
      body: requestBody ? JSON.stringify(requestBody) : null,
      headers: (headers ?? {}) as APIGatewayProxyEvent['headers'],
      multiValueHeaders: {},
      httpMethod,
      isBase64Encoded: false,
      path,
      pathParameters: pathParameters ?? null,
      queryStringParameters: (queryParams as APIGatewayProxyEventQueryStringParameters) ?? null,
      multiValueQueryStringParameters: null,
      stageVariables: null,
      requestContext: {
        accountId: '',
        apiId: '',
        authorizer: undefined,
        protocol: '',
        httpMethod,
        identity: {
          accessKey: null,
          accountId: null,
          apiKey: null,
          apiKeyId: null,
          caller: null,
          clientCert: null,
          cognitoAuthenticationProvider: null,
          cognitoAuthenticationType: null,
          cognitoIdentityId: null,
          cognitoIdentityPoolId: null,
          principalOrgId: null,
          sourceIp: 'devIp',
          user: null,
          userAgent: null,
          userArn: null,
        },
        path,
        stage: '',
        requestId: '',
        requestTimeEpoch: 0,
        resourceId: '',
        resourcePath: path,
      },
      resource: path,
    }

    ;(retVal as APIGatewayProxyEvent & { source: string }).source = 'aws.events'

    return retVal as APIGatewayProxyEvent
  }

  private getContext(): Context {
    const startTime = Date.now()
    const timeoutMs = resolveLambdaTimeoutMs()
    const datePart = new Date().toISOString().split('T')[0] ?? ''

    return {
      callbackWaitsForEmptyEventLoop: false,
      functionName: 'local-dev',
      functionVersion: '1.0.0',
      invokedFunctionArn: 'arn:aws:lambda:local:000000000000:function:local-dev',
      memoryLimitInMB: '1024',
      awsRequestId: `local-${Date.now()}`,
      logGroupName: '/aws/lambda/local-dev',
      logStreamName: `${datePart}/local`,
      getRemainingTimeInMillis: (): number => {
        return Math.max(0, timeoutMs - (Date.now() - startTime))
      },
      done: (_error?: Error, _result?: unknown): void => {},
      fail: (_error: string | Error): void => {},
      succeed: (_messageOrObject: unknown): void => {},
    }
  }
}
