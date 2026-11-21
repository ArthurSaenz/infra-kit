import type { AtlasLog, AtlasSnapshot } from '../lib/atlas-contract'

const log = (service: string, exists = true): AtlasLog => {
  const path = `/runs/42/${service}.log`

  return { service, path, href: `vscode://file${path}`, exists }
}

/**
 * Two sites (shop is the viewer), three backends — one owned by another runner, one down — and one
 * cloud. `shop` has a route whose live proxy differs and one a hand-written proxy overrides.
 */
export const makeSnapshot = (overrides: Partial<AtlasSnapshot> = {}): AtlasSnapshot => {
  return {
    v: 1,
    revision: 'rev-1',
    generatedAt: '2026-11-12T10:00:00.000Z',
    run: { pid: 4242, logDir: '/runs/42', logDirHref: 'vscode://file/runs/42' },
    viewer: { siteId: 'shop/ui' },
    sites: [
      {
        id: 'shop/ui',
        app: 'shop',
        packageName: '@pkg/shop-ui',
        host: 'shop.localhost',
        health: 'ok',
        log: log('shop-ui'),
        routes: [
          {
            path: '/api',
            packageName: '@pkg/shop-api',
            source: 'local',
            target: { kind: 'backend', id: 'shop/api' },
            reason: 'local',
            served: 'match',
          },
          {
            path: '/auth',
            packageName: '@pkg/auth-api',
            source: 'local',
            target: { kind: 'backend', id: 'auth/api' },
            reason: 'local',
            served: 'differs',
          },
          {
            path: '/pay',
            packageName: '@pkg/pay-api',
            source: 'cloud',
            target: { kind: 'cloud', id: 'pay' },
            reason: 'cloud-only',
            served: 'user-proxy',
          },
        ],
      },
      {
        id: 'admin/ui',
        app: 'admin',
        packageName: '@pkg/admin-ui',
        host: 'admin.localhost',
        health: 'starting',
        log: log('admin-ui', false),
        routes: [
          {
            path: '/api',
            packageName: '@pkg/admin-api',
            source: 'local',
            target: { kind: 'backend', id: 'admin/api' },
            reason: 'launched-failed',
            served: 'unknown',
          },
          {
            path: '/search',
            packageName: '@pkg/search-api',
            source: 'cloud',
            target: null,
            reason: 'cloud-unset',
            served: 'unknown',
          },
        ],
      },
    ],
    backends: [
      {
        id: 'shop/api',
        app: 'shop',
        host: 'api.shop.localhost',
        health: 'ok',
        owner: 'this-run',
        log: log('shop-api'),
      },
      { id: 'auth/api', app: 'auth', host: 'api.auth.localhost', health: 'ok', owner: 'other-runner', log: null },
      { id: 'admin/api', app: 'admin', host: null, health: 'down', owner: 'this-run', log: log('admin-api') },
    ],
    clouds: [{ id: 'pay', host: 'https://pay.staging.example.com/v2' }],
    logs: [log('runner'), log('turbo'), log('watch', false)],
    ...overrides,
  }
}
