import { execFile } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { discoverInfraKitProjects } from 'src/lib/project-discovery'
import type { DiscoveredProject } from 'src/lib/project-discovery'

import { reopen } from '../reopen'
import type { ReopenAllResult } from '../reopen'

/** Dispatcher returns a union; under `--all` the structuredContent is always the aggregate. */
const allResultOf = (structuredContent: unknown): ReopenAllResult => {
  return structuredContent as ReopenAllResult
}

vi.mock('src/lib/project-discovery', () => {
  return {
    discoverInfraKitProjects: vi.fn(),
  }
})

vi.mock('node:child_process', () => {
  return {
    execFile: vi.fn(),
  }
})

const PROJECTS: DiscoveredProject[] = [
  { name: 'alpha', repoRoot: '/repos/alpha' },
  { name: 'bravo', repoRoot: '/repos/bravo' },
  { name: 'charlie', repoRoot: '/repos/charlie' },
]

const cannedResult = (repo: string): Record<string, unknown> => {
  return {
    repo,
    dryRun: false,
    releaseOnly: false,
    worktreePaths: [`/repos/${repo}`],
    ideProviders: [],
    cmuxOpened: [`${repo} ws`],
    cmuxSkipped: [],
    cmuxClosed: [],
  }
}

const nameForCwd = (cwd: string): string => {
  const match = PROJECTS.find((project) => {
    return project.repoRoot === cwd
  })

  return match?.name ?? 'unknown'
}

/**
 * Install an execFile mock whose per-repo behaviour is decided by `behaviour`.
 * The callback is deferred to a microtask so we can observe whether the parent
 * awaits each child before spawning the next (serial) or fires them all up
 * front (parallel).
 */
const installExecFileMock = (
  behaviour: (repo: string) => { stdout?: string; error?: Error },
  events: string[],
): void => {
  vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], options: { cwd: string }, cb: unknown) => {
    const callback = cb as (error: Error | null, stdout: string, stderr: string) => void
    const repo = nameForCwd(options.cwd)

    events.push(`spawn:${repo}`)

    queueMicrotask(() => {
      events.push(`done:${repo}`)
      const outcome = behaviour(repo)

      if (outcome.error) callback(outcome.error, '', '')
      else callback(null, outcome.stdout ?? '', '')
    })

    return {} as never
  }) as never)
}

describe('reopen --all fan-out', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(discoverInfraKitProjects).mockResolvedValue(PROJECTS)
  })

  it('spawns exactly one child per discovered repo, each in its own cwd', async () => {
    const events: string[] = []

    installExecFileMock((repo) => {
      return { stdout: JSON.stringify(cannedResult(repo)) }
    }, events)

    const result = await reopen({ all: true })

    expect(execFile).toHaveBeenCalledTimes(PROJECTS.length)

    const cwds = vi.mocked(execFile).mock.calls.map((call) => {
      return (call[2] as { cwd: string }).cwd
    })

    expect(cwds).toEqual(['/repos/alpha', '/repos/bravo', '/repos/charlie'])

    expect(allResultOf(result.structuredContent).all).toBe(true)
    expect(allResultOf(result.structuredContent).results).toHaveLength(3)
  })

  it('passes --json and NEVER --all (and never --project/--root) to children', async () => {
    installExecFileMock((repo) => {
      return { stdout: JSON.stringify(cannedResult(repo)) }
    }, [])

    await reopen({ all: true, dryRun: true, releaseOnly: true, project: ['alpha'], root: ['/repos'] })

    // With --project alpha, only that child is spawned.
    expect(execFile).toHaveBeenCalledTimes(1)

    const childArgs = vi.mocked(execFile).mock.calls[0]?.[1] as string[]

    expect(childArgs).toContain('--json')
    expect(childArgs).toContain('--dry-run')
    expect(childArgs).toContain('--release-only')
    expect(childArgs).not.toContain('--all')
    expect(childArgs).not.toContain('--project')
    expect(childArgs).not.toContain('--root')
  })

  it('runs children SERIALLY — each child completes before the next spawns', async () => {
    const events: string[] = []

    installExecFileMock((repo) => {
      return { stdout: JSON.stringify(cannedResult(repo)) }
    }, events)

    await reopen({ all: true })

    // Serial interleaving: spawn/done pairs, not all spawns up front.
    expect(events).toEqual(['spawn:alpha', 'done:alpha', 'spawn:bravo', 'done:bravo', 'spawn:charlie', 'done:charlie'])
  })

  it('isolates a per-child failure — a failing child does not abort the sweep', async () => {
    const events: string[] = []

    installExecFileMock((repo) => {
      if (repo === 'bravo') return { error: new Error('reopen exited 1') }

      return { stdout: JSON.stringify(cannedResult(repo)) }
    }, events)

    const result = await reopen({ all: true })

    // All three children still ran, in order, despite bravo failing.
    expect(execFile).toHaveBeenCalledTimes(3)
    expect(events).toContain('spawn:charlie')

    const results = allResultOf(result.structuredContent).results

    expect(
      results.map((entry) => {
        return entry.ok
      }),
    ).toEqual([true, false, true])

    const bravo = results.find((entry) => {
      return entry.repo === 'bravo'
    })

    expect(bravo?.ok).toBe(false)
    expect(bravo && 'error' in bravo ? bravo.error : undefined).toMatch(/reopen exited 1/)
  })

  it('records a failure when a child emits unparseable stdout', async () => {
    installExecFileMock((repo) => {
      if (repo === 'bravo') return { stdout: 'not json at all' }

      return { stdout: JSON.stringify(cannedResult(repo)) }
    }, [])

    const result = await reopen({ all: true })

    const bravo = allResultOf(result.structuredContent).results.find((entry) => {
      return entry.repo === 'bravo'
    })

    expect(bravo?.ok).toBe(false)
  })
})
