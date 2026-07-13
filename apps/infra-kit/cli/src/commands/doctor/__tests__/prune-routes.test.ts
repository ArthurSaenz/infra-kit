import { describe, expect, it } from 'vitest'

import { pruneStalePortlessRoutes } from '../doctor'
import { decidePrune, isDevSessionRunning, looksLikeDevRunner } from '../prune-routes'

describe('decidePrune', () => {
  const dead = { name: 'feat-x.client-api', port: 3010, live: false }
  const live = { name: 'main.client-ui', port: 3020, live: true }

  it('prunes a route with no listener when no dev session is running', () => {
    expect(decidePrune([dead, live], false)).toEqual({ prunable: ['feat-x.client-api'], withheld: [] })
  })

  /**
   * The whole reason this module exists. `assignUiPort` registers a UI alias and then RELEASES the port
   * (`getFreePort` probes and lets go); vite binds it seconds later. For that window a healthy UI route has
   * no listener AND no dev-context fragment — it is byte-for-byte indistinguishable from a dead one. The
   * only thing that separates them is whether a dev session is running.
   */
  it('withholds every dead-looking route while a dev session runs — a booting UI has no listener yet', () => {
    expect(decidePrune([dead, live], true)).toEqual({ prunable: [], withheld: ['feat-x.client-api'] })
  })

  it('touches nothing when every route is live', () => {
    expect(decidePrune([live], false)).toEqual({ prunable: [], withheld: [] })
  })
})

describe('looksLikeDevRunner', () => {
  it.each([
    'node /Users/x/infra-kit/dist/cli.js dev --watch',
    '/usr/local/bin/infra-kit dev',
    'node /x/.tools/pnpm/bin/pnpm exec infra-kit dev',
    'node /x/dist/dev-server.js',
  ])('detects a live runner in %j', (command) => {
    expect(looksLikeDevRunner(command)).toBe(true)
  })

  /**
   * The correction that running this found. A crashed session leaves `turbo run dev` alive; if those count
   * as "a dev session", the leftovers of a dead run permanently block the cleanup of that same run's routes
   * and `--fix` is inert on exactly the machine that needs it. Observed in the wild: three orphaned
   * `turbo run dev` processes withholding six dead routes.
   *
   * They are safe to ignore: an orphan registers no new alias, and one still HOLDING a route's port is seen
   * as live by the wire probe, so it is never a prune candidate anyway.
   */
  it.each([
    'node ./node_modules/.bin/../turbo/bin/turbo run dev --filter=website-ui --concurrency=12',
    'node /x/node_modules/.bin/turbo watch build',
    'node /x/node_modules/vite/bin/vite.js',
  ])('does NOT treat the orphan %j as a live runner', (command) => {
    expect(looksLikeDevRunner(command)).toBe(false)
  })

  it.each(['node /x/dist/cli.js doctor --fix', 'node /x/node_modules/.bin/vitest run', '/sbin/launchd'])(
    'does not mistake %j for a runner',
    (command) => {
      expect(looksLikeDevRunner(command)).toBe(false)
    },
  )
})

describe('isDevSessionRunning', () => {
  it('fails CLOSED — an unreadable process table is "maybe running", never "safe to prune"', () => {
    expect(
      isDevSessionRunning(() => {
        throw new Error('ps: permission denied')
      }),
    ).toBe(true)
  })

  it('is false only when nothing dev-shaped is running', () => {
    const quiet = (): string[] => {
      return ['/sbin/launchd', 'node /x/dist/cli.js doctor']
    }

    expect(isDevSessionRunning(quiet)).toBe(false)
  })
})

describe('pruneStalePortlessRoutes', () => {
  const routes = [
    { name: 'feat-x.client-api', port: 3010 },
    { name: 'main.client-ui', port: 3020 },
  ]
  /** Only :3020 answers — :3010 is the route a SIGKILLed runner left behind. */
  const isListening = async (port: number): Promise<boolean> => {
    return port === 3020
  }

  it('removes the dead route when no dev session is running', async () => {
    const removed: string[] = []

    const result = await pruneStalePortlessRoutes({
      routes: () => {
        return routes
      },
      isListening,
      devSessionRunning: () => {
        return false
      },
      removeAlias: async (name) => {
        removed.push(name)
      },
    })

    expect(removed).toEqual(['feat-x.client-api'])
    expect(result.status).toBe('pass')
    expect(result.message).toContain('Removed 1 stale portless route(s)')
  })

  it('removes NOTHING while a dev session runs, and says why', async () => {
    const removed: string[] = []

    const result = await pruneStalePortlessRoutes({
      routes: () => {
        return routes
      },
      isListening,
      devSessionRunning: () => {
        return true
      },
      removeAlias: async (name) => {
        removed.push(name)
      },
    })

    expect(removed).toEqual([])
    expect(result.status).toBe('fail')
    expect(result.message).toContain('a dev session is running')
  })

  it('is a no-op when no routes are registered', async () => {
    const removed: string[] = []

    const result = await pruneStalePortlessRoutes({
      routes: () => {
        return []
      },
      isListening,
      devSessionRunning: () => {
        return false
      },
      removeAlias: async (name) => {
        removed.push(name)
      },
    })

    expect(removed).toEqual([])
    expect(result.status).toBe('pass')
  })
})
