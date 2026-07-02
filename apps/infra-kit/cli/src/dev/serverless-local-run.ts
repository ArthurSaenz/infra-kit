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

export interface IServerConfig {
  controllersPath: string
  prefixUrl?: string
  port: number
  /** App folder name, surfaced by the `/__health` endpoint. Optional. */
  appName?: string
}

type HandlerResult = Promise<{ body: string; headers: Record<string, string>; statusCode: number }>

/** Default simulated Lambda timeout; overridable via `DEV_SERVER_TIMEOUT_MS`. */
const DEFAULT_LAMBDA_TIMEOUT_MS = 30_000

/** Resolve the simulated Lambda timeout (ms), honoring `DEV_SERVER_TIMEOUT_MS` when it parses. */
const resolveLambdaTimeoutMs = (): number => {
  const raw = Number.parseInt(process.env.DEV_SERVER_TIMEOUT_MS ?? '', 10)

  return Number.isNaN(raw) ? DEFAULT_LAMBDA_TIMEOUT_MS : raw
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
        reply.header('Access-Control-Allow-Origin', '*')
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')

        // Handle preflight OPTIONS requests
        if (request.method === 'OPTIONS') {
          reply.status(204).send()
        }
      },
    )
  }

  public async start(): Promise<void> {
    this.registerHealthRoute()

    await Promise.all(this.loadRoutes())

    await this.server.listen({ port: this.serverConfig.port, host: '127.0.0.1' })

    this.logger.info(`Server listening on http://127.0.0.1:${this.serverConfig.port}`, {
      address: `http://127.0.0.1:${this.serverConfig.port}`,
    })
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

    for (const [funcName, funcDef] of Object.entries(data.functions)) {
      if (!funcDef?.events?.length) continue
      for (const element of funcDef.events) {
        const http = element?.http

        if (!http) continue
        this.logger.debug(`Registering route: ${http.method} /${http.path} -> ${funcName}`)
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
    const action = (await import(fileUrl.href)) as Record<
      string,
      (event: APIGatewayProxyEvent, ctx: Context, log: ILogger) => HandlerResult
    >

    this.controllers[routeKey] = { action, handler }

    const traceLogger = this.logger.createChild({ serviceName: 'RequestLogger' })

    this.logger.debug(`Adding fastify route: ${method} ${urlAction}`)

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

    this.logger.debug(`Route added successfully: ${method} ${urlAction}`)
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
