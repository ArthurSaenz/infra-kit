import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

import type { LoopbackGuardMode } from '../loopback-guard'
import { createLoopbackGuard, isLoopbackNavigation } from '../loopback-guard'

const ALIAS = 'main.client-ui.app.localhost'

interface FakeResponse {
  statusCode: number
  headers: Record<string, string>
  body: string | undefined
  ended: boolean
}

const request = (url: string, headers: Record<string, string>, method = 'GET'): IncomingMessage => {
  return { url, method, headers } as unknown as IncomingMessage
}

const page = (host: string, url = '/', extra: Record<string, string> = {}): IncomingMessage => {
  return request(url, { host, accept: 'text/html,application/xhtml+xml', ...extra })
}

const run = (mode: LoopbackGuardMode, req: IncomingMessage): { res: FakeResponse; next: ReturnType<typeof vi.fn> } => {
  const res: FakeResponse = { statusCode: 200, headers: {}, body: undefined, ended: false }
  const fake = {
    get statusCode() {
      return res.statusCode
    },
    set statusCode(value: number) {
      res.statusCode = value
    },
    setHeader: (name: string, value: string) => {
      res.headers[name.toLowerCase()] = value
    },
    end: (body?: string) => {
      res.body = body
      res.ended = true
    },
  } as unknown as ServerResponse
  const next = vi.fn()

  createLoopbackGuard(mode)(req, fake, next)

  return { res, next }
}

describe('isLoopbackNavigation', () => {
  it.each(['127.0.0.1:5399', 'localhost:5399', '[::1]:5399', 'localhost'])('matches a page load on %s', (host) => {
    expect(isLoopbackNavigation(page(host))).toBe(true)
  })

  it('lets a request that came through the portless alias pass', () => {
    // portless forwards the browser's Host unchanged, so this is what vite sees behind the alias.
    expect(isLoopbackNavigation(page(ALIAS))).toBe(false)
  })

  it('lets a LAN address pass, for a consumer that binds every interface on purpose', () => {
    expect(isLoopbackNavigation(page('192.168.1.20:5399'))).toBe(false)
  })

  it('ignores assets, HMR and the runner health probe', () => {
    expect(isLoopbackNavigation(request('/src/main.tsx', { host: '127.0.0.1:5399', accept: '*/*' }))).toBe(false)
    expect(isLoopbackNavigation(request('/', { host: '127.0.0.1:5399', accept: 'text/x-vite-ping' }))).toBe(false)
  })

  it('ignores a non-GET request', () => {
    expect(isLoopbackNavigation(request('/', { host: '127.0.0.1:5399', accept: 'text/html' }, 'POST'))).toBe(false)
  })
})

describe('createLoopbackGuard', () => {
  it('redirects a loopback page load to the same path on the alias', () => {
    const { res, next } = run({ kind: 'redirect', alias: ALIAS }, page('127.0.0.1:5399', '/orders/7?tab=2'))

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`https://${ALIAS}/orders/7?tab=2`)
  })

  it('passes everything through the alias untouched', () => {
    const { res, next } = run({ kind: 'redirect', alias: ALIAS }, page(ALIAS, '/orders'))

    expect(next).toHaveBeenCalledOnce()
    expect(res.ended).toBe(false)
  })

  it('explains how to start the app when nothing placed this dev server', () => {
    const { res, next } = run({ kind: 'explain' }, page('localhost:5173'))

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(421)
    expect(res.body).toContain('ik dev &lt;app&gt;')
  })

  it('lets the browser through for good once it chose to continue', () => {
    const allow = run({ kind: 'explain' }, page('localhost:5173', '/orders?infra-kit-loopback=allow&tab=2'))

    expect(allow.res.statusCode).toBe(302)
    expect(allow.res.headers.location).toBe('/orders?tab=2')
    expect(allow.res.headers['set-cookie']).toContain('infra-kit-loopback=allow')

    const after = run(
      { kind: 'explain' },
      page('localhost:5173', '/orders', { cookie: 'a=1; infra-kit-loopback=allow' }),
    )

    expect(after.next).toHaveBeenCalledOnce()
  })
})
