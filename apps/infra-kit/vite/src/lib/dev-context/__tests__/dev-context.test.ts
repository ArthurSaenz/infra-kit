import { infraKitDev } from '@slip-stream-kit/config/vite'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanupRepos, createRepo } from '../../__tests__/fixtures'
import type { RestartableServer } from '../dev-context'
import { proxySignature, resolveWatchTargets, watchDevContext } from '../dev-context'

afterEach(() => {
  cleanupRepos()
  vi.restoreAllMocks()
})

/** A fake vite dev server: records what was watched, and how many times a restart was asked for. */
const fakeServer = (): RestartableServer & {
  watched: string[]
  restarts: () => number
  emit: (event: 'add' | 'change' | 'unlink' | 'addDir', file: string) => void
  warnings: string[]
} => {
  const watched: string[] = []
  const warnings: string[] = []
  const listeners: ((file: string) => void)[] = []
  let restarts = 0

  return {
    watched,
    warnings,
    watcher: {
      add: (target) => {
        watched.push(target)
      },
      on: (_event, listener) => {
        listeners.push(listener)
      },
    },
    restart: async () => {
      restarts += 1

      return Promise.resolve()
    },
    warn: (message) => {
      warnings.push(message)
    },
    restarts: () => {
      return restarts
    },
    emit: (_event, file) => {
      for (const listener of listeners) listener(file)
    },
  }
}

/** The proxy map vite is currently serving, as the plugin's `config` hook computed it. */
const currentSignature = async (cwd: string): Promise<string> => {
  return proxySignature((await infraKitDev({ cwd, command: 'serve', port: 1 })).proxy)
}

const LOCAL_ORIGIN = 'https://main.client-api.localhost'

describe('proxySignature', () => {
  it('is independent of route and field insertion order', () => {
    const a = proxySignature({
      '/api': { target: 'https://a.test', changeOrigin: true, secure: false },
      '/ws': { target: 'https://b.test', changeOrigin: true },
    })
    const b = proxySignature({
      '/ws': { changeOrigin: true, target: 'https://b.test' },
      '/api': { secure: false, changeOrigin: true, target: 'https://a.test' },
    })

    expect(a).toBe(b)
  })

  it('changes when a target changes', () => {
    const before = proxySignature({ '/api': { target: 'https://a.test', changeOrigin: true } })
    const after = proxySignature({ '/api': { target: 'https://b.test', changeOrigin: true } })

    expect(before).not.toBe(after)
  })
})

describe('resolveWatchTargets', () => {
  it('finds an existing dev-context dir by searching upward from a nested package', () => {
    const repo = createRepo()
    const nested = path.join(repo.dir, 'apps', 'client', 'ui')

    fs.mkdirSync(nested, { recursive: true })

    const targets = resolveWatchTargets(nested)

    expect(targets.fragmentDir).toBe(repo.fragmentDir)
    expect(targets.configFile).toBe(path.join(nested, 'infra-kit.config.ts'))
  })

  it('still points at the dev-context dir when the runner has not created it yet', () => {
    const repo = createRepo()

    fs.rmSync(repo.fragmentDir, { recursive: true })

    const targets = resolveWatchTargets(repo.dir)

    // This is the case the live re-resolve exists for — a frontend up before any backend. Watching
    // nothing here would freeze it on `cloud` forever.
    expect(targets.fragmentDir).toBe(path.join(repo.dir, '.infra-kit', 'dev-context'))
    expect(targets.stateDir).toBe(path.join(repo.dir, '.infra-kit'))
  })
})

describe('watchDevContext', () => {
  it('restarts vite when a backend comes up and flips a route from cloud to local', async () => {
    const repo = createRepo()
    const server = fakeServer()

    process.env.INFRA_KIT_ENV = 'dev'

    const current = await currentSignature(repo.dir)
    const watch = watchDevContext({ server, cwd: repo.dir, options: { cwd: repo.dir }, current })
    const fragment = repo.writeFragment('client-api', LOCAL_ORIGIN)

    server.emit('add', fragment)

    await vi.waitFor(() => {
      expect(server.restarts()).toBe(1)
    })

    watch.dispose()
  })

  it('does not restart when a fragment is rewritten without changing the proxy', async () => {
    const repo = createRepo()
    const server = fakeServer()

    process.env.INFRA_KIT_ENV = 'dev'
    repo.writeFragment('client-api', LOCAL_ORIGIN)

    const current = await currentSignature(repo.dir)
    const watch = watchDevContext({ server, cwd: repo.dir, options: { cwd: repo.dir }, current })

    // The runner rewrites its fragments on every restart of its own (fresh pid/writtenAt), and writes one
    // for THIS UI too. If those writes restarted vite, the restart would rewrite them again — a loop.
    const fragment = repo.writeFragment('client-api', LOCAL_ORIGIN)

    server.emit('change', fragment)
    await new Promise((resolve) => {
      return setTimeout(resolve, 500)
    })

    expect(server.restarts()).toBe(0)

    watch.dispose()
  })

  it('restarts when the backend goes away and the route demotes back to cloud', async () => {
    const repo = createRepo()
    const server = fakeServer()

    process.env.INFRA_KIT_ENV = 'dev'
    repo.writeFragment('client-api', LOCAL_ORIGIN)

    const current = await currentSignature(repo.dir)
    const watch = watchDevContext({ server, cwd: repo.dir, options: { cwd: repo.dir }, current })

    repo.removeFragment('client-api')
    server.emit('unlink', path.join(repo.fragmentDir, 'client-api.json'))

    await vi.waitFor(() => {
      expect(server.restarts()).toBe(1)
    })

    watch.dispose()
  })

  it('ignores a write that is not the dev-context or this package’s config', async () => {
    const repo = createRepo()
    const server = fakeServer()

    process.env.INFRA_KIT_ENV = 'dev'

    const current = await currentSignature(repo.dir)
    const watch = watchDevContext({ server, cwd: repo.dir, options: { cwd: repo.dir }, current })

    repo.writeFragment('client-api', LOCAL_ORIGIN)
    server.emit('change', path.join(repo.dir, 'src', 'main.tsx'))

    await new Promise((resolve) => {
      return setTimeout(resolve, 500)
    })

    expect(server.restarts()).toBe(0)

    watch.dispose()
  })

  it('warns and keeps serving when the proxy cannot be re-resolved', async () => {
    const repo = createRepo()
    const server = fakeServer()

    process.env.INFRA_KIT_ENV = 'dev'

    const current = await currentSignature(repo.dir)
    const watch = watchDevContext({ server, cwd: repo.dir, options: { cwd: repo.dir }, current })

    // A cloud route with no sourced env is the helper's fail-fast. Mid-edit it is transient; tearing the
    // dev server down over it would be worse than keeping the proxy we already resolved.
    delete process.env.INFRA_KIT_ENV
    server.emit('change', path.join(repo.dir, 'infra-kit.config.ts'))

    await vi.waitFor(() => {
      expect(server.warnings).toHaveLength(1)
    })

    expect(server.restarts()).toBe(0)
    expect(server.warnings[0]).toContain('could not be re-resolved')

    watch.dispose()
  })
})
