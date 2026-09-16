import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildPaneCommands, paneTargetsByApp, runOrcaDevServer } from 'src/dev/orca-dev'
import { fail, ok, orcaCli, routes } from 'src/integrations/orca/__tests__/orca-cli-mock'
import type { OrcaReply } from 'src/integrations/orca/__tests__/orca-cli-mock'

const ROOT = '/home/dev/repo-worktrees/release/v1.0.0'
const MAIN = '/home/dev/repo'

const mocks = vi.hoisted(() => {
  return {
    apps: [] as Array<{ name: string; packageName: string; path: string }>,
    onSignal: null as ((signal: NodeJS.Signals) => Promise<void>) | null,
    registerSignalShutdown: vi.fn(),
  }
})

vi.mock('zx', async () => {
  return (await import('src/integrations/orca/__tests__/orca-cli-mock')).zxModule
})

vi.mock('src/dev/discovery', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import('src/dev/discovery')>()),
    findMonorepoRoot: () => {
      return ROOT
    },
    discoverApiApps: () => {
      return mocks.apps
    },
  }
})

vi.mock('src/lib/git-utils', () => {
  return {
    getMainRepoRoot: async () => {
      return MAIN
    },
  }
})

vi.mock('src/dev/signal-shutdown', () => {
  return {
    registerSignalShutdown: (deps: { onSignal: (signal: NodeJS.Signals) => Promise<void> }) => {
      mocks.onSignal = deps.onSignal
      mocks.registerSignalShutdown(deps)

      return () => {}
    },
  }
})

/**
 * Pure per-pane command construction for `infra-kit dev --orca`. A pane with no explicit targets maps to
 * the single-app primitive `pnpm exec infra-kit dev --app=<name>`; a pane carrying targets maps to the
 * part-level `--target=<app>/<part>,…`. `--watch` is threaded through only when watch mode is on.
 */
describe('buildPaneCommands', () => {
  it('maps each app to the single-app dev primitive (no watch)', () => {
    expect(buildPaneCommands([{ app: 'client' }, { app: 'backoffice' }], false)).toEqual([
      'pnpm exec infra-kit dev --app=client',
      'pnpm exec infra-kit dev --app=backoffice',
    ])
  })

  it('appends --watch to each command when watch is on', () => {
    expect(buildPaneCommands([{ app: 'client' }], true)).toEqual(['pnpm exec infra-kit dev --app=client --watch'])
  })

  it('returns an empty list for no apps', () => {
    expect(buildPaneCommands([], false)).toEqual([])
  })

  it('emits --target for a pane with explicit parts, so an unticked part never starts', () => {
    // `--app=client` expands to EVERY part client has. A wizard selection of `client/api` alone must not
    // silently start `client/ui` in that pane — the whole reason `--target` exists.
    expect(buildPaneCommands([{ app: 'client', targets: ['client/api'] }], false)).toEqual([
      'pnpm exec infra-kit dev --target=client/api',
    ])
  })

  it('joins multiple parts of the same app into one --target', () => {
    expect(buildPaneCommands([{ app: 'client', targets: ['client/api', 'client/ui'] }], true)).toEqual([
      'pnpm exec infra-kit dev --target=client/api,client/ui --watch',
    ])
  })

  it('falls back to --app when the targets list is empty (not merely absent)', () => {
    expect(buildPaneCommands([{ app: 'client', targets: [] }], false)).toEqual(['pnpm exec infra-kit dev --app=client'])
  })
})

describe('paneTargetsByApp', () => {
  it('groups concrete target keys by their app', () => {
    const byApp = paneTargetsByApp({ apps: { 'client/api': {}, 'client/ui': {}, 'backoffice/api': {} } })

    expect(byApp.get('client')).toEqual(['client/api', 'client/ui'])
    expect(byApp.get('backoffice')).toEqual(['backoffice/api'])
  })

  it('skips a glob key, which names no single app and cannot address a pane', () => {
    const byApp = paneTargetsByApp({ apps: { '*/api': {}, 'client/ui': {} } })

    expect(byApp.has('*')).toBe(false)
    expect([...byApp.keys()]).toEqual(['client'])
  })

  it('returns an empty map for an absent preset (a plain --orca run)', () => {
    expect(paneTargetsByApp(undefined).size).toBe(0)
  })
})

const app = (name: string) => {
  return { name, packageName: `sls-${name}`, path: `${ROOT}/apps/${name}/api` }
}

const READY = ok({ app: { running: true }, runtime: { reachable: true } })
const REGISTERED = ok({ repos: [{ path: MAIN }] })
const LISTED = ok({ worktrees: [{ path: MAIN }, { path: ROOT }] })

const STATUS_ARGV = ['status']
const REPO_LIST_ARGV = ['repo', 'list']
const WORKTREE_LIST_ARGV = ['worktree', 'list', '--repo', `path:${MAIN}`, '--limit', '500']

const CMD = (name: string) => {
  return `pnpm exec infra-kit dev --app=${name}`
}

const createArgv = (command: string) => {
  return ['terminal', 'create', '--worktree', `path:${ROOT}`, '--title', 'v1.0.0 dev', '--command', command]
}

const splitArgv = (from: string, direction: string, command: string) => {
  return ['terminal', 'split', '--terminal', from, '--direction', direction, '--command', command]
}

/** Orca answers as a ready, registered, listed setup; splits hand out h1, h2, … in call order. */
const happyRoutes = (overrides: Record<string, OrcaReply | ((argv: string[]) => OrcaReply)> = {}) => {
  let splits = 0

  return routes({
    status: READY,
    'repo list': REGISTERED,
    'worktree list': LISTED,
    'terminal create': ok({ terminal: { handle: 'h0', tabId: 'tab-1' } }),
    'terminal split': () => {
      splits += 1

      return ok({ split: { handle: `h${splits}`, tabId: 'tab-1' } })
    },
    ...overrides,
  })
}

/** Start the resident supervisor and wait until it has wired its signal handler — the happy path never resolves. */
const startResident = async (): Promise<void> => {
  void runOrcaDevServer({ include: null, watch: false })

  await vi.waitFor(() => {
    expect(mocks.registerSignalShutdown).toHaveBeenCalledTimes(1)
  })
}

describe('runOrcaDevServer', () => {
  beforeEach(() => {
    orcaCli.reset()
    mocks.apps = [app('client')]
    mocks.onSignal = null
    mocks.registerSignalShutdown.mockReset()

    // The resident heartbeat is a ref'd interval that would hold the test worker open; the timer object
    // only needs `refresh` to exist.
    vi.spyOn(globalThis, 'setInterval').mockReturnValue({ refresh: () => {} } as unknown as NodeJS.Timeout)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('falls back with no Orca call at all when no API app has a pane to open', async () => {
    mocks.apps = []

    await expect(runOrcaDevServer({ include: null, watch: false })).resolves.toEqual({
      fallback: 'no API apps to open a pane for (panes are backend-only)',
    })
    expect(orcaCli.calls).toEqual([])
  })

  it('falls back when the orca binary is absent', async () => {
    orcaCli.respond = () => {
      return { exitCode: 127, stdout: '', stderr: 'orca: command not found' }
    }

    await expect(runOrcaDevServer({ include: null, watch: false })).resolves.toEqual({
      fallback: 'Orca is not installed',
    })
    expect(orcaCli.calls).toEqual([STATUS_ARGV])
  })

  it('falls back when the app is installed but not running', async () => {
    orcaCli.respond = routes({ status: ok({ app: { running: false }, runtime: { reachable: false } }) })

    await expect(runOrcaDevServer({ include: null, watch: false })).resolves.toEqual({
      fallback: 'Orca is not running',
    })
    expect(orcaCli.calls).toEqual([STATUS_ARGV])
  })

  it('falls back — never `repo add` — when the main repo is not registered', async () => {
    orcaCli.respond = happyRoutes({ 'repo list': ok({ repos: [{ path: '/home/dev/other' }] }) })

    await expect(runOrcaDevServer({ include: null, watch: false })).resolves.toEqual({
      fallback: 'repo is not registered in Orca — run `infra-kit worktrees add` once, it offers to register it',
    })
    expect(orcaCli.calls).toEqual([STATUS_ARGV, REPO_LIST_ARGV])
  })

  it('falls back with the UI steps when the sidebar hides this worktree (no --focus can reveal it)', async () => {
    orcaCli.respond = happyRoutes({ 'worktree list': ok({ worktrees: [{ path: MAIN }] }) })

    await expect(runOrcaDevServer({ include: null, watch: false })).resolves.toEqual({
      fallback: `this worktree is hidden in Orca's sidebar — open Orca → repo → "hidden worktrees" → Show`,
    })
    expect(orcaCli.calls).toEqual([STATUS_ARGV, REPO_LIST_ARGV, WORKTREE_LIST_ARGV])
  })

  it('one app: a single create (no --focus, no split) then stays resident', async () => {
    orcaCli.respond = happyRoutes()

    await startResident()

    expect(orcaCli.calls).toEqual([STATUS_ARGV, REPO_LIST_ARGV, WORKTREE_LIST_ARGV, createArgv(CMD('client'))])
  })

  it('three apps: create, then the split plan anchored on the recorded handles', async () => {
    mocks.apps = [app('client'), app('backoffice'), app('multivendor')]
    orcaCli.respond = happyRoutes()

    await startResident()

    expect(orcaCli.calls.slice(3)).toEqual([
      createArgv(CMD('client')),
      splitArgv('h0', 'horizontal', CMD('multivendor')),
      splitArgv('h0', 'vertical', CMD('backoffice')),
    ])
  })

  it('honours --app include and the wizard presetDef when building pane commands', async () => {
    mocks.apps = [app('client'), app('backoffice')]
    orcaCli.respond = happyRoutes()

    void runOrcaDevServer({ include: ['client'], watch: true, presetDef: { apps: { 'client/api': {} } } })

    await vi.waitFor(() => {
      expect(mocks.registerSignalShutdown).toHaveBeenCalledTimes(1)
    })

    expect(orcaCli.calls.slice(3)).toEqual([createArgv('pnpm exec infra-kit dev --target=client/api --watch')])
  })

  it('shutdown closes the whole tab through the first handle', async () => {
    mocks.apps = [app('client'), app('backoffice')]
    orcaCli.respond = happyRoutes()

    await startResident()
    await mocks.onSignal!('SIGINT')

    expect(orcaCli.calls.slice(5)).toEqual([['terminal', 'close', '--terminal', 'h0', '--tab']])
  })

  it('shutdown falls back to closing each recorded handle when the --tab close refuses', async () => {
    mocks.apps = [app('client'), app('backoffice'), app('multivendor')]
    orcaCli.respond = happyRoutes({
      'terminal close': (argv) => {
        return argv.includes('--tab') ? fail('runtime_error', 'tab close refused') : ok({ close: {} })
      },
    })

    await startResident()
    await mocks.onSignal!('SIGTERM')

    expect(orcaCli.calls.slice(6)).toEqual([
      ['terminal', 'close', '--terminal', 'h0', '--tab'],
      ['terminal', 'close', '--terminal', 'h0'],
      ['terminal', 'close', '--terminal', 'h1'],
      ['terminal', 'close', '--terminal', 'h2'],
    ])
  })

  it('a failed split tears the half-built tab down before the error propagates', async () => {
    mocks.apps = [app('client'), app('backoffice')]
    orcaCli.respond = happyRoutes({ 'terminal split': fail('runtime_error', 'split failed') })

    await expect(runOrcaDevServer({ include: null, watch: false })).rejects.toThrow('split failed')

    expect(orcaCli.calls.slice(3)).toEqual([
      createArgv(CMD('client')),
      splitArgv('h0', 'horizontal', CMD('backoffice')),
      ['terminal', 'close', '--terminal', 'h0', '--tab'],
    ])
    expect(mocks.registerSignalShutdown).not.toHaveBeenCalled()
  })
})
