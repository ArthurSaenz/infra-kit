import { afterEach, describe, expect, it, vi } from 'vitest'

import { doctor } from 'src/commands/doctor'
import { allChecksPassed } from 'src/commands/doctor/doctor'
import type { CheckResult } from 'src/commands/doctor/doctor'

import { buildProgram } from '../program'

// The preAction seed writes to $HOME; it is not under test, and a test must not change its machine.
vi.mock('src/lib/config-bootstrap', () => {
  return { ensureUserProjectConfig: vi.fn(async () => {}) }
})

// Spread the original: a partial mock of this barrel drops `doctorMcpTool`, which the catalog imports.
vi.mock('src/commands/doctor', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import('src/commands/doctor')>()),
    doctor: vi.fn(),
    printDoctorReport: vi.fn(),
  }
})

const runDoctorAction = async (checks: CheckResult[]): Promise<typeof process.exitCode> => {
  const structuredContent = {
    checks: checks.map((check) => {
      return { ...check, fixable: false, detail: undefined }
    }),
    allPassed: allChecksPassed(checks),
    cliVersion: '0.0.0',
  }

  vi.mocked(doctor).mockResolvedValue({ content: [{ type: 'text', text: '' }], structuredContent })
  await buildProgram().parseAsync(['node', 'infra-kit', 'doctor'])

  return process.exitCode
}

afterEach(() => {
  process.exitCode = undefined
  vi.clearAllMocks()
})

/**
 * The exit rule keys on `plugin installed` FAILING. A `skip` is "not evaluated", never a failure, so a run
 * whose only non-pass rows are skips must exit 0 — including when the skipped row is `plugin installed`.
 */
describe('doctor exit code with skip rows', () => {
  it('exits 0 when the only non-pass rows are skips, even a skipped plugin installed', async () => {
    const exitCode = await runDoctorAction([
      { name: 'portless installed', status: 'pass', message: 'ok' },
      { name: 'portless CA chain valid', status: 'skip', message: 'no daemon to handshake with' },
      { name: 'Agent allowlist', status: 'skip', message: 'no git root' },
      { name: 'plugin installed', status: 'skip', message: 'not evaluated' },
    ])

    expect(exitCode ?? 0).toBe(0)
  })

  // The control: without it, a harness that never reached the action would pass the case above.
  it('still exits 1 when plugin installed fails', async () => {
    const exitCode = await runDoctorAction([{ name: 'plugin installed', status: 'fail', message: 'missing' }])

    expect(exitCode).toBe(1)
  })
})
