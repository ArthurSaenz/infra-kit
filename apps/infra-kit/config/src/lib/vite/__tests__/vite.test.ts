import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import type { InfraKitDevProxy } from '../../package-config/package-config'
import type { InfraKitViteProxyEntry, LocalPackageInfo } from '../vite'
import { DEV_CONTEXT_WIRE_VERSION, infraKitDev, readLocalSet, resolveProxyConfig, slugifyRelease } from '../vite'

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

/** A single local-first `/api` route on `client-api`, over an optionally overridden local template. */
const localRouteProxy = (local: string = FIXTURE_PROXY.templates.local): InfraKitDevProxy => {
  return {
    templates: { local, cloud: FIXTURE_PROXY.templates.cloud },
    routes: { '/api': { packageName: 'client-api', from: ['local', 'cloud'], default: 'cloud' } },
  }
}

/**
 * `client-api` as an OLD CLI recorded it: aliased behind a proxy on `proxyPort`, with **no `origin`**.
 * Every consumer of this helper exercises the legacy (template-interpolating) path.
 */
const aliasedInfo = (proxyPort: number): Map<string, LocalPackageInfo> => {
  return new Map([['client-api', { port: 3110, release: '2-4', alias: '2-4.client-api.localhost', proxyPort }]])
}

/** `client-api` as the CURRENT CLI records it: the authoritative `origin` it registered. */
const originInfo = (origin: string): Map<string, LocalPackageInfo> => {
  return new Map([['client-api', { port: 3110, release: '2-4', alias: '2-4.client-api.localhost', origin }]])
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

    // /api is from: ['local', 'cloud'] and backend-api is local → local template. `secure: false` because
    // the target is `.localhost` (portless serves it from a private CA); no cookie rewrite.
    expect(proxy['/api']).toEqual({
      target: 'http://2-4.backend-api.localhost',
      changeOrigin: true,
      secure: false,
    })

    // /media is from: ['cloud'] only → still cloud even though backend-api is local.
    expect(proxy['/media']).toEqual({
      target: 'https://arthur.hulyo.co.il',
      changeOrigin: true,
      secure: false,
      cookieDomainRewrite: 'localhost',
    })
  })

  it('slugifies a scoped packageName into the local template, matching the alias the runner registers', () => {
    // Drift guard: the dev-server registers `<release>.<slugifyHostLabel(pkg)>` with portless
    // (see dev-server.test.ts "slugifies a scoped package name…"). If only one side slugifies, vite
    // emits a target host that no alias backs and every proxied request 502s.
    const scoped: InfraKitDevProxy = {
      templates: {
        local: 'http://<release>.<packageName>.localhost',
        // The cloud service name is NOT a DNS label derived from the package — it must stay raw.
        cloud: 'https://<packageName>/<env>',
      },
      routes: {
        '/api': { packageName: '@hulyo/client-ui', from: ['local', 'cloud'], default: 'cloud' },
        '/media': { packageName: '@hulyo/client-ui', from: ['cloud'] },
      },
    }

    const proxy = resolveProxyConfig({
      proxy: scoped,
      localSet: new Set(['@hulyo/client-ui']), // the local set keys on the raw npm name
      env: 'arthur',
      getRelease: () => {
        return 'feat-x'
      },
    })

    // Byte-for-byte the host the dev-server aliases: `feat-x.hulyo-client-ui`.
    expect(proxy['/api']?.target).toBe('http://feat-x.hulyo-client-ui.localhost')
    // Cloud keeps the raw npm name — slugifying it would point at a service that does not exist.
    expect(proxy['/media']?.target).toBe('https://@hulyo/client-ui/arthur')
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
      secure: false,
    })
  })

  it('emits each local route with its OWN per-package recorded release (not one global slug)', () => {
    // Two packages, each `from: ['local']`, with DIFFERENT recorded releases.
    const multiLocal: InfraKitDevProxy = {
      templates: FIXTURE_PROXY.templates,
      routes: {
        '/api': { packageName: 'client-api', from: ['local', 'cloud'], default: 'cloud' },
        '/media': { packageName: 'media', from: ['local', 'cloud'], default: 'cloud' },
      },
    }

    const proxy = resolveProxyConfig({
      proxy: multiLocal,
      localSet: new Set(['client-api', 'media']),
      env: 'arthur',
      // Global slug must NOT be used when a per-package release is recorded.
      getRelease: () => {
        throw new Error('per-package release should win over the global slug')
      },
      localInfo: new Map([
        ['client-api', { port: 3110, release: '2-4', alias: '2-4.client-api.localhost', proxyPort: 80 }],
        ['media', { port: 3111, release: 'feat-x', alias: 'feat-x.media.localhost', proxyPort: 80 }],
      ]),
    })

    expect(proxy['/api']).toEqual({ target: 'http://2-4.client-api.localhost', changeOrigin: true, secure: false })
    expect(proxy['/media']).toEqual({ target: 'http://feat-x.media.localhost', changeOrigin: true, secure: false })
  })

  it('falls back to the global release slug when a fragment records no release', () => {
    const localOnly: InfraKitDevProxy = {
      templates: FIXTURE_PROXY.templates,
      routes: { '/api': { packageName: 'client-api', from: ['local', 'cloud'], default: 'cloud' } },
    }

    const proxy = resolveProxyConfig({
      proxy: localOnly,
      localSet: new Set(['client-api']),
      env: 'arthur',
      getRelease: () => {
        return slugifyRelease('release/2.4')
      },
      // Package present but with no recorded release → global slug is used.
      localInfo: new Map([['client-api', { port: 3110, alias: '2-4.client-api.localhost', proxyPort: 80 }]]),
    })

    expect(proxy['/api']).toEqual({ target: 'http://2-4.client-api.localhost', changeOrigin: true, secure: false })
  })

  it('still targets the template host for a fragment with no alias, using the global release', () => {
    // The reader schema stays lenient, so a fragment can lack `alias`. There is no direct-port branch any
    // more: a `local` route always resolves to the interpolated template host. With no per-package release
    // recorded, the global `getRelease` fills `<release>`.
    const proxy = resolveProxyConfig({
      proxy: localRouteProxy(),
      localSet: new Set(['client-api']),
      env: 'arthur',
      getRelease: () => {
        return 'feat-x'
      },
      localInfo: new Map([['client-api', { port: 3110 }]]),
    })

    expect(proxy['/api']).toEqual({ target: 'http://feat-x.client-api.localhost', changeOrigin: true, secure: false })
  })

  it('carries the proxy port into the local target when the daemon is on an unprivileged port', () => {
    // The template is written port-free because the proxy defaults to :80. A zero-sudo override must
    // still be reachable, so the runner-recorded proxyPort is grafted onto the target.
    const proxy = resolveProxyConfig({
      proxy: localRouteProxy(),
      localSet: new Set(['client-api']),
      env: 'arthur',
      getRelease: unusedRelease,
      localInfo: aliasedInfo(1355),
    })

    expect(proxy['/api']).toEqual({
      target: 'http://2-4.client-api.localhost:1355',
      changeOrigin: true,
      secure: false,
    })
  })

  it('preserves a template path and its trailing slash when grafting a non-default proxy port', () => {
    // `new URL(...).toString()` synthesizes a `/` for an authority-only URL. Trimming that blindly
    // would also eat a trailing slash the template meant to carry.
    const proxy = resolveProxyConfig({
      proxy: localRouteProxy('http://<release>.<packageName>.localhost/base/'),
      localSet: new Set(['client-api']),
      env: 'arthur',
      getRelease: unusedRelease,
      localInfo: aliasedInfo(1355),
    })

    expect(proxy['/api']?.target).toBe('http://2-4.client-api.localhost:1355/base/')
  })

  it('leaves a template that already pins its own port untouched', () => {
    const proxy = resolveProxyConfig({
      proxy: localRouteProxy('http://<release>.<packageName>.localhost:9999'),
      localSet: new Set(['client-api']),
      env: 'arthur',
      getRelease: unusedRelease,
      localInfo: aliasedInfo(1355),
    })

    expect(proxy['/api']?.target).toBe('http://2-4.client-api.localhost:9999')
  })

  it('throws an actionable error when a non-default proxy port meets an unparseable local template', () => {
    expect(() => {
      return resolveProxyConfig({
        proxy: localRouteProxy('<release>.<packageName>.localhost'), // no scheme → not a URL
        localSet: new Set(['client-api']),
        env: 'arthur',
        getRelease: unusedRelease,
        localInfo: aliasedInfo(1355),
      })
    }).toThrow(/is not a valid URL, so the proxy port 1355 cannot be applied/)
  })

  it('leaves the default :80 proxy port implicit, so the target matches the template verbatim', () => {
    const proxy = resolveProxyConfig({
      proxy: localRouteProxy(),
      localSet: new Set(['client-api']),
      env: 'arthur',
      getRelease: unusedRelease,
      localInfo: aliasedInfo(80),
    })

    expect(proxy['/api']?.target).toBe('http://2-4.client-api.localhost')
  })
})

describe('resolveProxyConfig (origin is authoritative)', () => {
  it('uses the fragment origin VERBATIM, ignoring a template that disagrees on scheme and host', () => {
    // The runner is the only party that knows what it actually registered. This template disagrees with the
    // origin on BOTH scheme and host; if any part of it leaks into the target, the helper is re-deriving a
    // contract it does not own.
    const proxy = resolveProxyConfig({
      proxy: localRouteProxy('http://wrong-host.example.com:9999'),
      localSet: new Set(['client-api']),
      env: 'arthur',
      getRelease: unusedRelease,
      localInfo: originInfo('https://2-4.client-api.localhost'),
    })

    expect(proxy['/api']?.target).toBe('https://2-4.client-api.localhost')
  })

  it('does not graft proxyPort onto an origin (the runner already published the port it serves on)', () => {
    const proxy = resolveProxyConfig({
      proxy: localRouteProxy(),
      localSet: new Set(['client-api']),
      env: 'arthur',
      getRelease: unusedRelease,
      // A fragment carrying BOTH (an old field alongside the new one) must still honour only the origin.
      localInfo: new Map([['client-api', { port: 3110, origin: 'https://2-4.client-api.localhost', proxyPort: 1355 }]]),
    })

    expect(proxy['/api']?.target).toBe('https://2-4.client-api.localhost')
  })
})

describe('resolveProxyConfig (wire version)', () => {
  it('refuses a fragment that declares a wire version but carries no origin', () => {
    // `v` exists to disambiguate the ONE overloaded signal in this contract. Before it, a missing `origin`
    // meant BOTH "an old CLI wrote this, legacy is correct" AND "a current CLI wrote a broken fragment,
    // legacy is catastrophic" — and the helper guessed legacy, rebuilt the target from a `templates.local`
    // that says http://, and proxied plain HTTP into portless's TLS listener. Silently: :80 answers with a
    // 302 rather than refusing. A writer that announced v2 and then omitted `origin` must fail loudly.
    expect(() => {
      return resolveProxyConfig({
        proxy: localRouteProxy('http://<release>.<packageName>.localhost'),
        localSet: new Set(['client-api']),
        env: 'arthur',
        getRelease: unusedRelease,
        localInfo: new Map([['client-api', { port: 3110, wire: DEV_CONTEXT_WIRE_VERSION }]]),
      })
    }).toThrow(/declares wire v2 but carries no `origin`/)
  })

  it('still honours a fragment with NO wire version — the rollback path to legacy mode is intact', () => {
    // The counterpart the guard above must not break. A genuinely OLD CLI writes no `v` and no `origin`;
    // rejecting it would drop a running package to `cloud` instead of falling into legacy mode.
    const proxy = resolveProxyConfig({
      proxy: localRouteProxy('http://<release>.<packageName>.localhost'),
      localSet: new Set(['client-api']),
      env: 'arthur',
      getRelease: unusedRelease,
      localInfo: new Map([['client-api', { port: 3110, release: '2-4' }]]),
    })

    expect(proxy['/api']?.target).toBe('http://2-4.client-api.localhost')
  })
})

describe('resolveProxyConfig (legacy mode — origin absent, i.e. a fragment from an OLD CLI)', () => {
  it('forces the scheme to http for an unprivileged proxyPort, which only infra-kit --no-tls could own', () => {
    // The old CLI's `spawnDaemon` always passed `--no-tls`, so an unprivileged daemon IT created served
    // plain HTTP. An `https://` template pointed there would fail; downgrade it.
    const proxy = resolveProxyConfig({
      proxy: localRouteProxy('https://<release>.<packageName>.localhost'),
      localSet: new Set(['client-api']),
      env: 'arthur',
      getRelease: unusedRelease,
      localInfo: aliasedInfo(1355),
    })

    expect(proxy['/api']?.target).toBe('http://2-4.client-api.localhost:1355')
  })

  it('never force-downgrades an https template on a privileged proxyPort, so no plain HTTP hits a TLS port', () => {
    // The load-bearing legacy case. A privileged daemon is installed out-of-band, where portless defaults
    // to TLS ON. Force-`http`ing here would emit `http://<alias>:443` — plain HTTP into a TLS listener,
    // the exact silent failure this design exists to remove. The old CLI never knew the TLS state and
    // neither do we, so the template's scheme stands. (`:443` is https's default port, so `withProxyPort`
    // grafts it and `URL` normalizes it straight back out — the target lands port-free.)
    const target = resolveProxyConfig({
      proxy: localRouteProxy('https://<release>.<packageName>.localhost'),
      localSet: new Set(['client-api']),
      env: 'arthur',
      getRelease: unusedRelease,
      localInfo: aliasedInfo(443),
    })['/api']?.target

    expect(target).toBe('https://2-4.client-api.localhost')
    expect(target).not.toContain('http://')
  })

  it('leaves a legacy http template on :443 exactly as the old helper emitted it (pre-existing breakage)', () => {
    // The ONE input where "never rewrite the scheme" and "never emit http://<alias>:443" cannot BOTH hold:
    // an `http://` template plus an old CLI's `proxyPort: 443`. The old helper emitted `http://<alias>:443`
    // and it was ALREADY broken against a TLS daemon. The helper does not CREATE that URL by rewriting a
    // scheme — it declines to invent a different wrong answer for a config it does not own. The real fix is
    // the consumer's `https://` template, which the CLI bump ships anyway.
    const target = resolveProxyConfig({
      proxy: localRouteProxy(),
      localSet: new Set(['client-api']),
      env: 'arthur',
      getRelease: unusedRelease,
      localInfo: aliasedInfo(443),
    })['/api']?.target

    expect(target).toBe('http://2-4.client-api.localhost:443')
  })

  it('reproduces the old helper verbatim for a fragment with no proxyPort at all', () => {
    // No proxyPort, no origin: the template is interpolated and nothing is grafted or rewritten. This is
    // the CLI-only-rollback path — it must never reject the fragment or reshape the target.
    const proxy = resolveProxyConfig({
      proxy: localRouteProxy('https://<release>.<packageName>.localhost/base/'),
      localSet: new Set(['client-api']),
      env: 'arthur',
      getRelease: () => {
        return 'feat-x'
      },
      localInfo: new Map([['client-api', { port: 3110 }]]),
    })

    expect(proxy['/api']?.target).toBe('https://feat-x.client-api.localhost/base/')
  })
})

describe('resolveProxyConfig (secure: false is scoped to loopback hostnames)', () => {
  const localTarget = (local: string, info?: Map<string, LocalPackageInfo>): InfraKitViteProxyEntry | undefined => {
    return resolveProxyConfig({
      proxy: localRouteProxy(local),
      localSet: new Set(['client-api']),
      env: 'arthur',
      getRelease: () => {
        return '2-4'
      },
      localInfo: info,
    })['/api']
  }

  it('disables cert validation for a .localhost target, whose cert comes from the private portless CA', () => {
    expect(localTarget('https://<release>.<packageName>.localhost')?.secure).toBe(false)
  })

  it('disables cert validation for a loopback literal target', () => {
    expect(localTarget('https://127.0.0.1:8443')?.secure).toBe(false)
    expect(localTarget('https://[::1]:8443')?.secure).toBe(false)
    expect(localTarget('http://localhost:8443')?.secure).toBe(false)
  })

  it('does NOT disable cert validation for a non-loopback local template', () => {
    // `templates.local` is an unconstrained string in a consumer-authored config. An unconditional
    // `secure: false` in a PUBLISHED helper would silently switch off validation for a real public host.
    const entry = localTarget('https://api.example.com')

    expect(entry?.target).toBe('https://api.example.com')
    expect(entry).not.toHaveProperty('secure')
  })

  it('does NOT disable cert validation for a non-loopback ORIGIN either (the scope is the hostname)', () => {
    expect(
      localTarget('http://<release>.<packageName>.localhost', originInfo('https://api.example.com')),
    ).not.toHaveProperty('secure')
  })

  it('leaves secure unset when the target is not a parseable URL (fail closed)', () => {
    // The unparseable case only survives to here when no port needs grafting (withProxyPort throws otherwise).
    expect(localTarget('<release>.<packageName>.localhost')).not.toHaveProperty('secure')
  })
})

/** Create an isolated temp repo root; caller writes fragments under it. */
const makeTempRoot = (): string => {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ik-vite-'))
}

describe('readLocalSet (dev-context fragment directory merge)', () => {
  const roots: string[] = []

  afterEach(() => {
    while (roots.length > 0) {
      fs.rmSync(roots.pop()!, { recursive: true, force: true })
    }
  })

  const writeFragment = (dir: string, name: string, contents: string): void => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), contents)
  }

  /**
   * `pid` is the staleness guard — `readFragmentDir` drops a fragment whose writer has exited. These
   * merge/precedence tests are about neither staleness nor liveness, so they stamp THIS live process and
   * stay focused on what they claim to assert. A fragment written with an arbitrary pid would be dropped
   * for reasons the test never mentions.
   */
  const livePid = process.pid

  it('f6a: merges TWO valid fragments into a localSet containing BOTH packages', () => {
    const root = makeTempRoot()

    roots.push(root)
    const dir = path.join(root, '.infra-kit', 'dev-context')

    writeFragment(
      dir,
      'client-api.json',
      JSON.stringify({ package: 'client-api', port: 3110, pid: livePid, writtenAt: 1 }),
    )
    writeFragment(dir, 'media.json', JSON.stringify({ package: 'media', port: 3111, pid: livePid, writtenAt: 2 }))

    const localSet = readLocalSet(root)

    expect(localSet.has('client-api')).toBe(true)
    expect(localSet.has('media')).toBe(true)
    expect(localSet.size).toBe(2)
  })

  it('f6c: a corrupt fragment is SKIPPED while the valid one is still selected', () => {
    const root = makeTempRoot()

    roots.push(root)
    const dir = path.join(root, '.infra-kit', 'dev-context')

    writeFragment(
      dir,
      'client-api.json',
      JSON.stringify({ package: 'client-api', port: 3110, pid: livePid, writtenAt: 1 }),
    )
    // Truncated / invalid JSON — must not collapse the whole set.
    writeFragment(dir, 'media.json', '{ "package": "media", "port":')

    const localSet = readLocalSet(root)

    expect(localSet.has('client-api')).toBe(true)
    expect(localSet.has('media')).toBe(false)
    expect(localSet.size).toBe(1)
  })

  it('f6c: dev-context directory absent (ENOENT) → empty set (distinct back-compat branch)', () => {
    const root = makeTempRoot()

    roots.push(root)

    // No `.infra-kit/dev-context/` anywhere up-tree from this isolated temp root.
    const localSet = readLocalSet(root)

    expect(localSet.size).toBe(0)
  })

  it('back-compat: reads a legacy single dev-context.json when the directory is absent', () => {
    const root = makeTempRoot()

    roots.push(root)
    fs.mkdirSync(path.join(root, '.infra-kit'), { recursive: true })
    fs.writeFileSync(path.join(root, '.infra-kit', 'dev-context.json'), JSON.stringify({ packages: ['client-api'] }))

    const localSet = readLocalSet(root)

    expect(localSet.has('client-api')).toBe(true)
    expect(localSet.size).toBe(1)
  })

  it('the fragment directory wins over a legacy file when both exist', () => {
    const root = makeTempRoot()

    roots.push(root)
    const dir = path.join(root, '.infra-kit', 'dev-context')

    writeFragment(dir, 'media.json', JSON.stringify({ package: 'media', port: 3111, pid: livePid, writtenAt: 2 }))
    fs.writeFileSync(path.join(root, '.infra-kit', 'dev-context.json'), JSON.stringify({ packages: ['client-api'] }))

    const localSet = readLocalSet(root)

    // Directory is preferred: legacy `client-api` is NOT merged in.
    expect(localSet.has('media')).toBe(true)
    expect(localSet.has('client-api')).toBe(false)
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

  const originalUiPorts = process.env.INFRA_KIT_UI_PORTS

  afterEach(() => {
    restore('INFRA_KIT_ENV', originalEnv)
    restore('E2E__BASIC_AUTH_USERNAME', originalUser)
    restore('E2E__BASIC_AUTH_PASSWORD', originalPass)
    restore('INFRA_KIT_UI_PORTS', originalUiPorts)
  })

  /** A temp package dir with a `package.json` naming the package (for the INFRA_KIT_UI_PORTS lookup). */
  const makePkgDir = (name: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-vite-ui-'))

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }))

    return dir
  }

  it('layer B: binds the runner-assigned port with strictPort when this package is in INFRA_KIT_UI_PORTS', async () => {
    const dir = makePkgDir('my-ui')

    process.env.INFRA_KIT_UI_PORTS = JSON.stringify({ 'my-ui': 5200, 'other-ui': 5201 })
    const result = await infraKitDev({ cwd: dir })

    expect(result.port).toBe(5200)
    expect(result.strictPort).toBe(true)
  })

  it('points HMR at the alias over wss when the runner published a widened record', async () => {
    // The page is served from `https://<alias>`, so its HMR socket must be `wss://` on the same origin
    // (:443, the proxy's implicit port) — not `ws://127.0.0.1:<vite port>`, which the browser blocks as
    // mixed content.
    const dir = makePkgDir('my-ui')

    // Exactly the shape the runner writes (`dev-server.ts` → `uiPortMap`), no more: if this record grows a
    // key the runner does not emit, the test starts describing a contract that does not exist — which is
    // how `hmr` came to be tested against a value no runner ever produced, while being wired to nothing.
    process.env.INFRA_KIT_UI_PORTS = JSON.stringify({
      'my-ui': { port: 5200, alias: '2-4.my-ui.localhost' },
    })
    const result = await infraKitDev({ cwd: dir })

    expect(result.port).toBe(5200)
    expect(result.strictPort).toBe(true)
    expect(result.hmr).toEqual({ protocol: 'wss', host: '2-4.my-ui.localhost', clientPort: 443 })
  })

  it('emits NO hmr for a bare vite dev (no runner, so no registered alias)', async () => {
    // Computability is not registration: this UI's alias would be derivable, but nothing registered it, so
    // pointing HMR there would break hot reload on a path that works today.
    const dir = makePkgDir('my-ui')

    delete process.env.INFRA_KIT_UI_PORTS
    const result = await infraKitDev({ cwd: dir })

    expect(result.hmr).toBeUndefined()
  })

  it('emits NO hmr for the legacy bare-number record (an old runner registered no alias)', async () => {
    const dir = makePkgDir('my-ui')

    process.env.INFRA_KIT_UI_PORTS = JSON.stringify({ 'my-ui': 5200 })
    const result = await infraKitDev({ cwd: dir })

    // Back-compat: the port is still bound with strictPort — only the alias-dependent HMR override is off.
    expect(result.port).toBe(5200)
    expect(result.strictPort).toBe(true)
    expect(result.hmr).toBeUndefined()
  })

  it('emits NO hmr when a widened record carries a port but no alias (assigned, never registered)', async () => {
    const dir = makePkgDir('my-ui')

    process.env.INFRA_KIT_UI_PORTS = JSON.stringify({ 'my-ui': { port: 5200 } })
    const result = await infraKitDev({ cwd: dir })

    expect(result.port).toBe(5200)
    expect(result.hmr).toBeUndefined()
  })

  it('ignores a malformed widened record (no numeric port) and falls back to a free port', async () => {
    const dir = makePkgDir('my-ui')

    process.env.INFRA_KIT_UI_PORTS = JSON.stringify({ 'my-ui': { alias: '2-4.my-ui.localhost' } })
    const result = await infraKitDev({ cwd: dir })

    expect(result.strictPort).toBeUndefined()
    expect(result.hmr).toBeUndefined()
    expect(result.port).toBeGreaterThan(0)
  })

  it('pins the dev server to IPv4 loopback so the portless alias can reach it', async () => {
    // Regression (502 on every UI request): vite's default `host: 'localhost'` + its
    // `dns.setDefaultResultOrder('verbatim')` binds [::1] ONLY, while portless dials routes on
    // 127.0.0.1 — the alias resolved, the proxy connected, and the upstream refused.
    const dir = makePkgDir('my-ui')

    delete process.env.INFRA_KIT_UI_PORTS
    const result = await infraKitDev({ cwd: dir })

    expect(result.host).toBe('127.0.0.1')
  })

  it('honors an explicit host override, for a container or LAN dev server', async () => {
    const dir = makePkgDir('my-ui')

    delete process.env.INFRA_KIT_UI_PORTS
    const result = await infraKitDev({ cwd: dir, host: '0.0.0.0' })

    expect(result.host).toBe('0.0.0.0')
  })

  it('a build emits no host (server is irrelevant to a build)', async () => {
    const dir = makePkgDir('my-ui')
    const result = await infraKitDev({ cwd: dir, command: 'build' })

    expect(result.host).toBeUndefined()
    expect(result.port).toBeUndefined()
  })

  it('layer B regression: env absent → a free port with strictPort unset (byte-identical to today)', async () => {
    const dir = makePkgDir('my-ui')

    delete process.env.INFRA_KIT_UI_PORTS
    const result = await infraKitDev({ cwd: dir })

    expect(typeof result.port).toBe('number')
    expect(result.port).toBeGreaterThan(0)
    expect(result.strictPort).toBeUndefined()
  })

  it('layer B: this package NOT in the map → a free port, strictPort unset', async () => {
    const dir = makePkgDir('my-ui')

    process.env.INFRA_KIT_UI_PORTS = JSON.stringify({ 'a-different-ui': 5200 })
    const result = await infraKitDev({ cwd: dir })

    expect(result.port).not.toBe(5200)
    expect(result.strictPort).toBeUndefined()
  })

  it('layer B: an explicit options.port wins over the map and does not force strictPort', async () => {
    const dir = makePkgDir('my-ui')

    process.env.INFRA_KIT_UI_PORTS = JSON.stringify({ 'my-ui': 5200 })
    const result = await infraKitDev({ cwd: dir, port: 4321 })

    expect(result.port).toBe(4321)
    expect(result.strictPort).toBeUndefined()
  })

  it('returns an empty proxy plus a dynamic dev-server port when the config has no dev.proxy', async () => {
    const result = await infraKitDev({ cwd: path.join(FIXTURES_DIR, 'no-proxy') })

    expect(result.proxy).toEqual({})
    expect(typeof result.port).toBe('number')
    expect(result.port).toBeGreaterThan(0)
  })

  it('returns an empty proxy plus a dynamic dev-server port when there is no infra-kit.config.ts', async () => {
    const result = await infraKitDev({ cwd: path.join(FIXTURES_DIR, 'no-config') })

    expect(result.proxy).toEqual({})
    expect(typeof result.port).toBe('number')
  })

  it('is a no-op for a build: empty proxy, no port (server is irrelevant + no cloud-env fail-fast)', async () => {
    const result = await infraKitDev({ cwd: path.join(FIXTURES_DIR, 'with-proxy'), command: 'build' })

    expect(result).toEqual({ proxy: {} })
    expect(result.port).toBeUndefined()
  })

  it('honors an explicit port override instead of picking a dynamic one', async () => {
    const result = await infraKitDev({ cwd: path.join(FIXTURES_DIR, 'no-config'), port: 4321 })

    expect(result.port).toBe(4321)
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

  it('resolves a route to local using the fragment-recorded release when the package is started', async () => {
    process.env.INFRA_KIT_ENV = 'arthur'
    delete process.env.E2E__BASIC_AUTH_USERNAME
    delete process.env.E2E__BASIC_AUTH_PASSWORD

    // Isolated package dir: its own config + a started `backend-api` fragment.
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-vite-e2e-'))

    try {
      fs.writeFileSync(
        path.join(pkg, 'infra-kit.config.ts'),
        [
          'export default {',
          '  dev: {',
          '    proxy: {',
          '      templates: {',
          "        local: 'http://<release>.<packageName>.localhost',",
          "        cloud: 'https://<env>.hulyo.co.il',",
          '      },',
          '      routes: {',
          "        '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' },",
          '      },',
          '    },',
          '  },',
          '}',
          '',
        ].join('\n'),
      )

      const dir = path.join(pkg, '.infra-kit', 'dev-context')

      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'backend-api.json'),
        JSON.stringify({
          package: 'backend-api',
          port: 3110,
          pid: 1,
          writtenAt: 1,
          release: 'feat-x',
          alias: 'feat-x.backend-api.localhost',
          proxyPort: 80,
        }),
      )

      const { proxy } = await infraKitDev({ cwd: pkg })

      // Uses the fragment's recorded `feat-x` release — no git derivation. The :80 proxy port is
      // implicit, so the target is the template verbatim.
      expect(proxy['/api']).toEqual({
        target: 'http://feat-x.backend-api.localhost',
        changeOrigin: true,
        secure: false,
      })
    } finally {
      fs.rmSync(pkg, { recursive: true, force: true })
    }
  })

  it('resolves a started-but-unaliased package to the template host, end to end', async () => {
    const pkg = makeTempRoot()

    try {
      fs.writeFileSync(
        path.join(pkg, 'infra-kit.config.ts'),
        [
          'export default {',
          '  dev: {',
          '    proxy: {',
          '      templates: {',
          "        local: 'http://<release>.<packageName>.localhost',",
          "        cloud: 'https://<env>.hulyo.co.il',",
          '      },',
          '      routes: {',
          "        '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' },",
          '      },',
          '    },',
          '  },',
          '}',
          '',
        ].join('\n'),
      )

      const dir = path.join(pkg, '.infra-kit', 'dev-context')

      fs.mkdirSync(dir, { recursive: true })
      // A lenient fragment can omit `alias`; there is no longer a direct-port branch, so a `local` route
      // still resolves to the template host using the fragment's recorded release.
      fs.writeFileSync(
        path.join(dir, 'backend-api.json'),
        JSON.stringify({ package: 'backend-api', port: 3110, pid: 1, writtenAt: 1, release: 'feat-x' }),
      )

      const { proxy } = await infraKitDev({ cwd: pkg })

      expect(proxy['/api']).toEqual({
        target: 'http://feat-x.backend-api.localhost',
        changeOrigin: true,
        secure: false,
      })
    } finally {
      fs.rmSync(pkg, { recursive: true, force: true })
    }
  })
})
