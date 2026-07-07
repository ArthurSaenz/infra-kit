import { Buffer } from 'node:buffer'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import type { InfraKitDevProxy } from '../../package-config/package-config'
import { infraKitDev, resolveProxyConfig, slugifyRelease } from '../vite'

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** Fixture proxy config shared across the resolution cases. */
const FIXTURE_PROXY: InfraKitDevProxy = {
  templates: {
    local: 'http://<release>.<packageName>.localhost',
    cloud: 'https://<env>.hulyo.co.il',
  },
  routes: {
    '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' },
    '/media': { packageName: 'backend-api', from: ['cloud'] },
  },
}

/** A release getter that fails the test if called when it should not be. */
const unusedRelease = (): string => {
  throw new Error('getRelease should not be called when no local route needs <release>')
}

describe('slugifyRelease', () => {
  it('strips a release/ prefix and slugifies dots to dashes', () => {
    expect(slugifyRelease('release/2.4')).toBe('2-4')
  })

  it('strips a feature/ prefix and lowercases', () => {
    expect(slugifyRelease('feature/HUL-123')).toBe('hul-123')
  })

  it('slugifies a bare branch with no git-flow prefix', () => {
    expect(slugifyRelease('My_Cool.Branch')).toBe('my-cool-branch')
  })

  it('trims leading and trailing dashes', () => {
    expect(slugifyRelease('release/@2.4@')).toBe('2-4')
  })
})

describe('resolveProxyConfig', () => {
  it('resolves every route to cloud when the local set is empty (frontend-only)', () => {
    const proxy = resolveProxyConfig({
      proxy: FIXTURE_PROXY,
      localSet: new Set(),
      env: 'arthur',
      getRelease: unusedRelease,
    })

    expect(proxy).toEqual({
      '/api': {
        target: 'https://arthur.hulyo.co.il',
        changeOrigin: true,
        secure: false,
        cookieDomainRewrite: 'localhost',
      },
      '/media': {
        target: 'https://arthur.hulyo.co.il',
        changeOrigin: true,
        secure: false,
        cookieDomainRewrite: 'localhost',
      },
    })
  })

  it('resolves a local-first route to the local template when its packageName is in the local set', () => {
    const proxy = resolveProxyConfig({
      proxy: FIXTURE_PROXY,
      localSet: new Set(['backend-api']),
      env: 'arthur',
      getRelease: () => {
        return slugifyRelease('release/2.4')
      },
    })

    // /api is from: ['local', 'cloud'] and backend-api is local → local template,
    // no cookie/secure opts.
    expect(proxy['/api']).toEqual({
      target: 'http://2-4.backend-api.localhost',
      changeOrigin: true,
    })

    // /media is from: ['cloud'] only → still cloud even though backend-api is local.
    expect(proxy['/media']).toEqual({
      target: 'https://arthur.hulyo.co.il',
      changeOrigin: true,
      secure: false,
      cookieDomainRewrite: 'localhost',
    })
  })

  it('throws an actionable error when a cloud route is needed but INFRA_KIT_ENV is unset', () => {
    expect(() => {
      return resolveProxyConfig({
        proxy: FIXTURE_PROXY,
        localSet: new Set(),
        env: undefined,
        getRelease: unusedRelease,
      })
    }).toThrow(/INFRA_KIT_ENV is not set/)
  })

  it('falls back to a `local` default (using <release>) when the packageName is not in the local set', () => {
    const localDefault: InfraKitDevProxy = {
      templates: FIXTURE_PROXY.templates,
      routes: { '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'local' } },
    }

    // backend-api is NOT local, but default is 'local' → resolves local via <release>.
    // env is undefined but that must NOT fail-fast because the resolved source is local.
    const proxy = resolveProxyConfig({
      proxy: localDefault,
      localSet: new Set(),
      env: undefined,
      getRelease: () => {
        return slugifyRelease('release/2.4')
      },
    })

    expect(proxy['/api']).toEqual({
      target: 'http://2-4.backend-api.localhost',
      changeOrigin: true,
    })
  })
})

describe('infraKitDev (config loading)', () => {
  const originalEnv = process.env.INFRA_KIT_ENV
  const originalUser = process.env.E2E__BASIC_AUTH_USERNAME
  const originalPass = process.env.E2E__BASIC_AUTH_PASSWORD

  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  afterEach(() => {
    restore('INFRA_KIT_ENV', originalEnv)
    restore('E2E__BASIC_AUTH_USERNAME', originalUser)
    restore('E2E__BASIC_AUTH_PASSWORD', originalPass)
  })

  it('returns an empty proxy when the config has no dev.proxy', async () => {
    const result = await infraKitDev({ cwd: path.join(FIXTURES_DIR, 'no-proxy') })

    expect(result).toEqual({ proxy: {} })
  })

  it('returns an empty proxy when there is no infra-kit.config.ts', async () => {
    const result = await infraKitDev({ cwd: path.join(FIXTURES_DIR, 'no-config') })

    expect(result).toEqual({ proxy: {} })
  })

  it('loads dev.proxy from a .ts config and resolves the frontend-only cloud case', async () => {
    process.env.INFRA_KIT_ENV = 'arthur'
    delete process.env.E2E__BASIC_AUTH_USERNAME
    delete process.env.E2E__BASIC_AUTH_PASSWORD

    const { proxy } = await infraKitDev({ cwd: path.join(FIXTURES_DIR, 'with-proxy') })

    expect(proxy['/api']).toEqual({
      target: 'https://arthur.hulyo.co.il',
      changeOrigin: true,
      secure: false,
      cookieDomainRewrite: 'localhost',
    })

    // Neither cred set → no `headers` key on any route.
    for (const entry of Object.values(proxy)) {
      expect(entry).not.toHaveProperty('headers')
    }
  })

  it('injects an Authorization header into every route when both E2E__BASIC_AUTH_* are set', async () => {
    process.env.INFRA_KIT_ENV = 'arthur'
    process.env.E2E__BASIC_AUTH_USERNAME = 'user'
    process.env.E2E__BASIC_AUTH_PASSWORD = 'pass'

    const { proxy } = await infraKitDev({ cwd: path.join(FIXTURES_DIR, 'with-proxy') })

    const expectedHeader = `Basic ${Buffer.from('user:pass').toString('base64')}`

    expect(proxy['/api']).toEqual({
      target: 'https://arthur.hulyo.co.il',
      changeOrigin: true,
      secure: false,
      cookieDomainRewrite: 'localhost',
      headers: { Authorization: expectedHeader },
    })

    for (const entry of Object.values(proxy)) {
      expect(entry.headers).toEqual({ Authorization: expectedHeader })
    }
  })

  it('adds no headers when only one of the two E2E__BASIC_AUTH_* creds is set', async () => {
    process.env.INFRA_KIT_ENV = 'arthur'
    process.env.E2E__BASIC_AUTH_USERNAME = 'user'
    delete process.env.E2E__BASIC_AUTH_PASSWORD

    const { proxy } = await infraKitDev({ cwd: path.join(FIXTURES_DIR, 'with-proxy') })

    for (const entry of Object.values(proxy)) {
      expect(entry).not.toHaveProperty('headers')
    }
  })

  it('lets an explicit basicAuth option override the env vars', async () => {
    process.env.INFRA_KIT_ENV = 'arthur'
    process.env.E2E__BASIC_AUTH_USERNAME = 'envuser'
    process.env.E2E__BASIC_AUTH_PASSWORD = 'envpass'

    const { proxy } = await infraKitDev({
      cwd: path.join(FIXTURES_DIR, 'with-proxy'),
      basicAuth: { username: 'override', password: 'secret' },
    })

    const expectedHeader = `Basic ${Buffer.from('override:secret').toString('base64')}`

    for (const entry of Object.values(proxy)) {
      expect(entry.headers).toEqual({ Authorization: expectedHeader })
    }
  })
})
