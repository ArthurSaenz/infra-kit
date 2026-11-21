import { ATLAS_TOKEN_HEADER } from '@slip-stream-kit/config/internal'
import type { AtlasEndpoint } from '@slip-stream-kit/config/internal'
import http from 'node:http'

export interface AtlasResponse {
  status: number
  headers: http.IncomingHttpHeaders
  rawHeaders: string[]
  body: string
}

/** `fetch` refuses to set `Host`, and the Host check is one of the things under test. */
export const atlasRequest = (
  endpoint: AtlasEndpoint,
  options: {
    path?: string
    method?: string
    headers?: Record<string, string>
    token?: string | null
    body?: string
  } = {},
): Promise<AtlasResponse> => {
  const url = new URL(endpoint.url)
  const token = options.token === undefined ? endpoint.token : options.token

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        method: options.method ?? 'GET',
        path: options.path ?? '/__atlas/state.json',
        headers: {
          host: url.host,
          ...(token === null ? {} : { [ATLAS_TOKEN_HEADER]: token }),
          ...options.headers,
        },
      },
      (res) => {
        let body = ''

        res.setEncoding('utf-8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, body })
        })
      },
    )

    req.on('error', reject)
    req.end(options.body)
  })
}
