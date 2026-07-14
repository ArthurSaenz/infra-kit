import { describe, expect, it } from 'vitest'

import type { ResolvedDevServer } from '../server-config'
import { hasPinnedPortConflict, mergeServerConfig } from '../server-config'

/** What `infraKitDev()` resolves for a UI the runner placed: an assigned port, `strictPort`, alias HMR. */
const MANAGED: ResolvedDevServer = {
  port: 5301,
  host: '127.0.0.1',
  strictPort: true,
  hmr: { protocol: 'wss', host: 'main.client-ui.localhost', clientPort: 443 },
  proxy: {
    '/api': { target: 'https://main.client-api.localhost', changeOrigin: true, secure: false },
    '/ws': { target: 'https://main.client-api.localhost', changeOrigin: true, secure: false },
  },
}

/** A bare `vite dev` (no runner): a free port, no strictPort, no alias to point HMR at. */
const UNMANAGED: ResolvedDevServer = { port: 61234, host: '127.0.0.1', proxy: {} }

describe('mergeServerConfig', () => {
  it('emits the whole resolved block when the consumer set nothing', () => {
    expect(mergeServerConfig(MANAGED, undefined)).toEqual({
      port: 5301,
      host: '127.0.0.1',
      strictPort: true,
      hmr: { protocol: 'wss', host: 'main.client-ui.localhost', clientPort: 443 },
      proxy: MANAGED.proxy,
    })
  })

  it('never overrules a hand-pinned port — and drops strictPort with it', () => {
    // Vite merges a config hook's result OVER the user config, so emitting `port` here would silently
    // win against the consumer's explicit one; emitting `strictPort` would turn that into a boot failure.
    const merged = mergeServerConfig(MANAGED, { port: 4000 })

    expect(merged.port).toBeUndefined()
    expect(merged.strictPort).toBeUndefined()
    expect(merged.proxy).toEqual(MANAGED.proxy)
  })

  it('honours a consumer strictPort while still placing the port', () => {
    const merged = mergeServerConfig(MANAGED, { strictPort: false })

    expect(merged.port).toBe(5301)
    expect(merged.strictPort).toBeUndefined()
  })

  it('leaves an explicit host and hmr alone', () => {
    const merged = mergeServerConfig(MANAGED, { host: '0.0.0.0', hmr: { protocol: 'ws' } })

    expect(merged.host).toBeUndefined()
    expect(merged.hmr).toBeUndefined()
    expect(merged.port).toBe(5301)
  })

  it('drops the routes the consumer declared themselves and keeps the rest', () => {
    const merged = mergeServerConfig(MANAGED, { proxy: { '/api': 'http://somewhere-else.test' } })

    expect(merged.proxy).toEqual({ '/ws': MANAGED.proxy['/ws'] })
  })

  it('omits proxy entirely when every route was the consumer’s own', () => {
    const merged = mergeServerConfig(MANAGED, {
      proxy: { '/api': 'http://a.test', '/ws': 'http://b.test' },
    })

    expect(merged.proxy).toBeUndefined()
  })

  it('omits an absent strictPort rather than emitting false', () => {
    expect(mergeServerConfig(UNMANAGED, undefined)).toEqual({ port: 61234, host: '127.0.0.1' })
  })
})

describe('hasPinnedPortConflict', () => {
  it('flags a pinned port against a runner-assigned one (the alias points at the runner’s)', () => {
    expect(hasPinnedPortConflict(MANAGED, { port: 4000 })).toBe(true)
  })

  it('does not flag a pin that happens to match the assigned port', () => {
    expect(hasPinnedPortConflict(MANAGED, { port: 5301 })).toBe(false)
  })

  it('does not flag a pin when no runner placed this UI', () => {
    expect(hasPinnedPortConflict(UNMANAGED, { port: 4000 })).toBe(false)
  })

  it('does not flag an unpinned config', () => {
    expect(hasPinnedPortConflict(MANAGED, undefined)).toBe(false)
  })
})
