export interface HttpGetInit {
  headers: Record<string, string>
  cache: 'no-store'
}

/** The page's calls to `fetch`: same-origin, so the runner's CSP `default-src 'self'` is all it needs. */
export const httpGet = (url: string, init: HttpGetInit): Promise<Response> => {
  return fetch(url, init)
}

export const httpPostJson = (url: string, body: unknown): Promise<Response> => {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
