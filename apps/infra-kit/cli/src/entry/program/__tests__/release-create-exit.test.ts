import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { releaseCreate } from 'src/commands/release-create'
import { commandEcho } from 'src/lib/command-echo'
import { jsonOutput } from 'src/lib/json-output'

import { buildProgram } from '../program'

// The preAction hook's seed writes to $HOME; not under test here.
vi.mock('src/lib/config-bootstrap', () => {
  return { ensureUserProjectConfig: vi.fn(async () => {}) }
})

// Partial: the command catalog imports `releaseCreateMcpTool` from the same module.
vi.mock('src/commands/release-create', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/commands/release-create')>()

  return { ...actual, releaseCreate: vi.fn() }
})

type Result = Awaited<ReturnType<typeof releaseCreate>>

const stub = (failureCount: number): void => {
  vi.mocked(releaseCreate).mockResolvedValue({
    content: [],
    structuredContent: { createdBranches: [], successCount: 1, failureCount, releases: [], failedReleases: [] },
  } as unknown as Result)
}

const run = async (): Promise<void> => {
  await buildProgram().parseAsync(['node', 'infra-kit', 'release', 'create', '-r', '1.2.5', '--yes'])
}

beforeEach(() => {
  process.exitCode = undefined
})

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
  commandEcho.reset()
  jsonOutput.enabled = false
})

describe('release create action — exit code', () => {
  // Regression: a batch with a failed entry exited 0.
  it('reds the run when an entry failed', async () => {
    stub(1)

    await run()

    expect(process.exitCode).toBe(1)
  })

  it('marks the --json document partial_failure beside the payload, like every batch command', async () => {
    stub(1)
    jsonOutput.enabled = false

    const written: string[] = []

    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
      written.push(String(chunk))

      return true
    }) as never)

    await buildProgram().parseAsync(['node', 'infra-kit', 'release', 'create', '-r', '1.2.5', '--yes', '--json'])
    write.mockRestore()

    expect(JSON.parse(written.join(''))).toMatchObject({ status: 'partial_failure', failureCount: 1, successCount: 1 })
  })

  it('leaves the exit code alone when every entry was created', async () => {
    stub(0)

    await run()

    expect(process.exitCode).toBeUndefined()
  })
})
