import { ServerError } from './errors/server-error'

declare global {
  interface Window {
    AwsWafIntegration?: {
      fetch: (args: unknown) => Promise<Response>
    }
  }
}

interface FetchOptions {
  method?: string
  token?: string
  headers?: Record<string, string>
  body?: Record<string, unknown> | string | FormData
}

interface HttpClientConfig {
  delay?: number
  retries?: number
  isAwsFetchWrap?: boolean
}

export class HttpClient<R extends string = string> {
  baseUrl: string
  fetchInstance: typeof fetch

  constructor(baseUrl: string, fetchInstance: typeof fetch) {
    this.baseUrl = baseUrl
    this.fetchInstance = fetchInstance
  }

  async fetch<T = unknown>(
    uri: string,
    options: FetchOptions = {},
    config?: HttpClientConfig,
  ): Promise<{ body: T; status: number; headers?: Record<string, string>; ok: boolean }> {
    const requestOptions: Record<string, string | undefined | Headers | Record<string, unknown> | FormData> = {
      method: options.method || 'GET',
      ...additionalConfig(),
    }

    const headers = new Headers(options.headers || {})

    contentDefault(headers, 'application/json')

    if (
      (typeof window !== 'undefined' && options.body && options.body instanceof FormData) ||
      options.method === 'HEAD'
    ) {
      headers.delete('content-type')
    }

    if (options.token) {
      // headers.set('Authorization', `Bearer ${options.token}`)
      headers.set('Authorization', options.token)
      headers.set('mv-auth', options.token)
    }

    requestOptions.headers = headers

    if (options.body) {
      requestOptions.body =
        headers.get('content-type') === 'application/json' ? JSON.stringify(options.body) : options.body
      requestOptions.method = requestOptions.method || 'POST'
    }

    const url = `${this.baseUrl}${uri}`

    try {
      const response = await fetchWrap({
        url,
        options: requestOptions,
        config,
        fetchInstance: this.fetchInstance,
      }).catch((error) => {
        const options = { cause: error as Error }

        throw new Error(`Network error: ${error.message}`, options)
      })

      const isNeedParse =
        response.status !== 206 && contentTypeIs(response.headers, 'application/json') && options.method !== 'HEAD'
      const answer = isNeedParse ? await response.json() : await response.text()

      const responder = {
        ok: response.ok,
        body: answer,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      }

      if (response.ok || response.status === 304) {
        return responder
      }

      if (response.status === 570) {
        throw new ServerError<R>({
          type: responder.body?.type || 'SERVER_ERROR',
          message: responder.body?.message || 'Server error message',
          extraData: answer.extraData || {},
          metaData: {
            res: responder,
            req: { ...requestOptions, body: options.body },
          },
        })
      }

      // console.log('API Layer', url, responder)

      throw new Error(`API Layer: ${responder.status} - ${url}`, { cause: responder })
    } catch (error) {
      if (import.meta.env.DEBUG_API_REQUEST) {
        console.error(error)
      }

      // throw new Error(`API Layer ${url}`, { cause: error as Error })
      throw error
    }
  }
}

/**
 * Check if content-type JSON
 */
function contentTypeIs(headers: Headers, type: string): boolean {
  return headers.get('content-type')?.includes(type) || false
}

function contentDefault(headers: Headers, type: string): Headers {
  if (!headers.has('content-type')) {
    headers.set('content-type', type)
  }

  return headers
}

function additionalConfig() {
  if (typeof window !== 'undefined') {
    return {
      credentials: 'same-origin',
    }
  }

  return {}
}

export interface FetchWrapArgs {
  url: string
  options: RequestInit
  config?: HttpClientConfig
  fetchInstance: typeof fetch
}

const fetchWrap = async (args: FetchWrapArgs) => {
  const { url, options, config, fetchInstance } = args

  let _fetch = fetchInstance

  if (config?.isAwsFetchWrap && window.AwsWafIntegration?.fetch) {
    _fetch = window.AwsWafIntegration.fetch
  }

  if (!config?.retries && !config?.delay) return _fetch(url, options)

  let error

  for (const index of new Array(config.retries).fill(undefined)) {
    try {
      if (index > 0 && config.delay) {
        await new Promise((r) => {
          return setTimeout(r, config.delay)
        })
      }

      const result = await _fetch(url, options)

      return result
    } catch (_error) {
      error = _error
    }
  }
  throw error
}
