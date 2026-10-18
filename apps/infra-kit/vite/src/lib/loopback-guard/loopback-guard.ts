import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * What the guard does with a page opened on a loopback address: send it to the portless alias the runner
 * registered, or explain that this dev server was started outside `infra-kit dev` and has no alias at all.
 */
export type LoopbackGuardMode = { kind: 'redirect'; alias: string } | { kind: 'explain' }

type Next = (err?: unknown) => void

// `[::1]` keeps its brackets: it is compared against `URL.hostname`, which brackets an IPv6 literal.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const ALLOW_PARAM = 'infra-kit-loopback'
const ALLOW_COOKIE = `${ALLOW_PARAM}=allow`

const loopbackHostname = (host: string | undefined): string | null => {
  if (!host) return null

  try {
    const { hostname } = new URL(`http://${host}`)

    return LOOPBACK_HOSTS.has(hostname) ? hostname : null
  } catch {
    return null
  }
}

/**
 * A browser opening a page on `127.0.0.1` / `localhost` / `[::1]`. Assets, HMR, and the runner's health
 * probe (`Accept: text/x-vite-ping`) are not navigations and pass untouched. portless keeps the browser's
 * `Host` (the `*.localhost` alias) when it forwards, so a request that came through the alias never matches.
 */
export const isLoopbackNavigation = (req: IncomingMessage): boolean => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (!req.headers.accept?.includes('text/html')) return false

  return loopbackHostname(req.headers.host) !== null
}

const hasAllowCookie = (req: IncomingMessage): boolean => {
  return (req.headers.cookie ?? '').split(';').some((part) => {
    return part.trim() === ALLOW_COOKIE
  })
}

const redirect = (res: ServerResponse, location: string): void => {
  res.statusCode = 302
  res.setHeader('Location', location)
  res.end()
}

const EXPLAIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open this app through infra-kit dev</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #1f2328; }
  code { background: #eff1f3; padding: 0.1em 0.35em; border-radius: 4px; }
  a { color: #0969da; }
</style>
</head>
<body>
<h1>This dev server was started outside <code>infra-kit dev</code></h1>
<p>It has no portless alias, so it runs on a random loopback port: the proxy does not follow your local
backends, cookies and CORS behave differently than on <code>https://&lt;app&gt;.localhost</code>, and the
page is not what e2e tests see.</p>
<p>Stop it and start the app from the repository root with <code>ik dev &lt;app&gt;</code>, then open the
<code>https://…localhost</code> URL it prints.</p>
<p><a href="?${ALLOW_PARAM}=allow">Continue on this address anyway</a></p>
</body>
</html>
`

/**
 * Connect middleware that keeps people off the raw loopback address of a dev server. In `redirect` mode a
 * loopback page load is sent to the same path on the alias. In `explain` mode it gets a page saying how to
 * start the app properly, with a link that sets a cookie and lets this browser through from then on.
 */
export const createLoopbackGuard = (mode: LoopbackGuardMode) => {
  return (req: IncomingMessage, res: ServerResponse, next: Next): void => {
    if (!isLoopbackNavigation(req)) {
      next()

      return
    }

    const url = new URL(req.url ?? '/', 'https://loopback')

    if (mode.kind === 'redirect') {
      redirect(res, `https://${mode.alias}${url.pathname}${url.search}`)

      return
    }

    if (url.searchParams.get(ALLOW_PARAM) === 'allow') {
      url.searchParams.delete(ALLOW_PARAM)
      res.setHeader('Set-Cookie', `${ALLOW_COOKIE}; Path=/; SameSite=Lax`)
      redirect(res, `${url.pathname}${url.search}`)

      return
    }

    if (hasAllowCookie(req)) {
      next()

      return
    }

    // 421 Misdirected Request: the server is fine, the address used to reach it is the problem.
    res.statusCode = 421
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(req.method === 'HEAD' ? undefined : EXPLAIN_PAGE)
  }
}
