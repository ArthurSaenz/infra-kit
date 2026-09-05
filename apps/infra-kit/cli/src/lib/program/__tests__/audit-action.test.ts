import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { audit } from 'src/commands/audit'
import { commandEcho } from 'src/lib/command-echo'
import { logger } from 'src/lib/logger'

import { buildProgram } from '../program'

// The preAction hook's other two legs touch the outside world: the layer-3 seed writes to $HOME and
// the auto-load shells out to Doppler. Neither is under test here.
vi.mock('src/lib/config-bootstrap', () => {
  return { ensureUserProjectConfig: vi.fn(async () => {}) }
})

vi.mock('src/lib/env-autoload', () => {
  return { runEnvAutoLoad: vi.fn(async () => {}), surfaceStickyAuthFailure: vi.fn() }
})

// The command under test is the ACTION, not `audit()`: the exit code is set here and nowhere else,
// so the audit itself is replaced by a stub returning the exact result shape each case needs.
// Partial, because `command-catalog.ts` imports `auditMcpTool` from the same module and
// `buildProgram` reaches the catalog — a whole-module mock takes the catalog down with it.
vi.mock('src/commands/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/commands/audit')>()

  return { ...actual, audit: vi.fn() }
})

const auditMock = vi.mocked(audit)

type AuditResult = Awaited<ReturnType<typeof audit>>

/** Stub one `audit()` return. `fixed` is omitted entirely unless a case supplies it. */
const stubAudit = (structuredContent: AuditResult['structuredContent']): void => {
  auditMock.mockResolvedValue({ content: [], structuredContent } as unknown as AuditResult)
}

/** A passing single-package result — the baseline every case varies from. */
const passingContent = (): AuditResult['structuredContent'] => {
  return { allPassed: true, packages: [{ name: '@ws/a', passed: true, checks: [] }] }
}

const runAudit = async (...argv: string[]): Promise<void> => {
  await buildProgram().parseAsync(['node', 'infra-kit', 'audit', ...argv])
}

beforeEach(() => {
  process.exitCode = undefined
  auditMock.mockReset()
})

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
  commandEcho.reset()
})

describe('audit action — exit code', () => {
  it('reds the run when the post-fix audit failed', async () => {
    stubAudit({ allPassed: false, packages: [{ name: '@ws/a', passed: false, checks: [] }] })

    await runAudit()

    expect(process.exitCode).toBe(1)
  })

  /**
   * The clause that exists for exactly one reason: before adoption a `missing` block PASSES, so a
   * fix run whose only write failed reports a green audit. Without this the failure exits 0.
   */
  it('reds the run when a fix write failed even though the audit passed', async () => {
    stubAudit({
      ...passingContent(),
      fixed: [{ path: '/repo/apps/demo/api/CLAUDE.md', action: 'failed', type: 'backend' }],
    })

    await runAudit('--fix')

    expect(process.exitCode).toBe(1)
  })

  it('leaves the exit code untouched when the audit passed and every write landed', async () => {
    stubAudit({
      ...passingContent(),
      fixed: [{ path: '/repo/apps/demo/api/CLAUDE.md', action: 'created', type: 'backend' }],
    })

    await runAudit('--fix')

    expect(process.exitCode).toBeUndefined()
  })

  it('leaves the exit code untouched on a passing run that carries no fixed field', async () => {
    stubAudit(passingContent())

    await runAudit()

    expect(process.exitCode).toBeUndefined()
  })
})

describe('audit action — --design requires --fix', () => {
  it('errors, reds the exit code, and never runs the audit', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})

    await runAudit('--design')

    expect(auditMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      '--design requires --fix (it scaffolds DESIGN.md; there is nothing to scaffold without a fix run)',
    )
  })

  it('accepts --design alongside --fix and forwards both', async () => {
    stubAudit(passingContent())

    await runAudit('--fix', '--design', '--all')

    expect(auditMock).toHaveBeenCalledWith({ all: true, root: undefined, fix: true, design: true })
    expect(process.exitCode).toBeUndefined()
  })
})
