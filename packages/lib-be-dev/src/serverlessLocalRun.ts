import type { APIGatewayProxyEvent, APIGatewayProxyEventQueryStringParameters, Context } from 'aws-lambda'
import fastify from 'fastify'
import * as fs from 'fs'
import * as yaml from 'js-yaml'
import type { Server } from 'node:http'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ILogger } from './interfaces.js'
import { Logger } from './logger.js'

interface IServerConfig {
  controllersPath: string
  prefixUrl?: string
  port: number
}

type HandlerResult = Promise<{ body: string; headers: Record<string, string>; statusCode: number }>

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

  constructor(private readonly serverConfig: IServerConfig) {
    this.importCacheBust = `${Date.now()}`
    this.logger = new Logger({ serviceName: 'LocalServer', minLevel: 'DEBUG', maxExtraDataLength: 2000 })
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
    await Promise.all(this.loadRoutes())

    await this.server.listen({ port: this.serverConfig.port, host: '127.0.0.1' })

    this.logger.complete(`Server listening on http://127.0.0.1:${this.serverConfig.port}`, {
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

  private loadRoutes(): Promise<void>[] {
    const fileContents = fs.readFileSync('serverless.yml', 'utf8')
    const data = yaml.load(fileContents) as {
      functions: Record<string, { events?: Array<{ http?: { method: string; path: string } }>; handler?: string }>
    }
    const p: Promise<void>[] = []

    if (!data?.functions) return p

    for (const funcDef of Object.values(data.functions)) {
      if (!funcDef?.events?.length) continue
      for (const element of funcDef.events) {
        const http = element?.http
        if (!http) continue
        p.push(this.defineRoute(http.method, { http }, funcDef))
      }
    }
    return p
  }

  private async defineRoute(
    httpMethod: string,
    element: { http: { method: string; path: string } },
    funcDef: { handler?: string },
  ): Promise<void> {
    let url = element.http.path.toString()
    url = url.replaceAll('{', ':').replaceAll('}', '')

    let urlAction = path.posix.join(this.serverConfig.prefixUrl ?? '', url)
    urlAction = urlAction[0] === '/' ? urlAction : `/${urlAction}`

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

    this.controllers[urlAction] = { action, handler }

    const traceLogger = this.logger.createChild({ serviceName: 'RequestLogger' })

    const self = this

    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']

    const method = String(httpMethod).toUpperCase()

    if (!validMethods.includes(method)) {
      throw new Error(`Invalid HTTP method: "${httpMethod}" for URL: ${urlAction}`)
    }

    this.server.route({
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
      url: urlAction,
      handler: async function (
        request: { body?: unknown; query?: unknown; params?: unknown; headers?: unknown },
        reply: {
          headers: (h: Record<string, string>) => unknown
          code: (n: number) => { send: (body: unknown) => void }
        },
      ) {
        const controller = self.controllers[urlAction]
        if (!controller) throw new Error(`No controller for ${urlAction}`)
        const handlerFn = controller.action[controller.handler]
        if (!handlerFn) throw new Error(`No handler ${controller.handler} for ${urlAction}`)
        const retVal = await handlerFn(
          self.getEventObj(request.body, request.query, request.params, request.headers),
          self.getContext(),
          traceLogger,
        )
        const responseBody = JSON.parse(retVal.body)

        reply.headers(retVal.headers)

        return reply.code(retVal?.statusCode ?? 500).send(responseBody)
      },
    })
  }

  private getEventObj(
    requestBody?: unknown,
    queryParams?: unknown,
    pathParameters?: unknown,
    headers?: unknown,
  ): APIGatewayProxyEvent {
    const retVal = {
      body: requestBody ? JSON.stringify(requestBody) : null,
      headers: (headers ?? {}) as APIGatewayProxyEvent['headers'],
      multiValueHeaders: {},
      httpMethod: '',
      isBase64Encoded: false,
      path: '',
      pathParameters: pathParameters ?? null,
      queryStringParameters: (queryParams as APIGatewayProxyEventQueryStringParameters) ?? null,
      multiValueQueryStringParameters: null,
      stageVariables: null,
      requestContext: {
        accountId: '',
        apiId: '',
        authorizer: undefined,
        protocol: '',
        httpMethod: '',
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
        path: '',
        stage: '',
        requestId: '',
        requestTimeEpoch: 0,
        resourceId: '',
        resourcePath: '',
      },
      resource: '',
    }

    ;(retVal as APIGatewayProxyEvent & { source: string }).source = 'aws.events'

    return retVal as APIGatewayProxyEvent
  }

  private getContext(): Context {
    return {
      callbackWaitsForEmptyEventLoop: false,
      functionName: '',
      functionVersion: '',
      invokedFunctionArn: '',
      memoryLimitInMB: '',
      awsRequestId: '',
      logGroupName: '',
      logStreamName: '',
      getRemainingTimeInMillis: function (): number {
        throw new Error('Function not implemented.')
      },
      done: function (_error?: Error | undefined, _result?: unknown): void {
        throw new Error('Function not implemented.')
      },
      fail: function (_error: string | Error): void {
        throw new Error('Function not implemented.')
      },
      succeed: function (_messageOrObject: unknown): void {
        throw new Error('Function not implemented.')
      },
    }
  }
}
