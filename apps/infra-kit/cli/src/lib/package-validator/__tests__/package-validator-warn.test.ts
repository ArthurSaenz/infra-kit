import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkAgentGuidance } from '../checks'
import { validatePackage } from '../package-validator'

// No check emits `warn` on its own yet, so one is forced here to pin the aggregate rule.
vi.mock('../checks', async (importOriginal) => {
  return { ...(await importOriginal<typeof import('../checks')>()), checkAgentGuidance: vi.fn() }
})

const tmpDirs: string[] = []

const makePackage = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-warn-'))

  tmpDirs.push(dir)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@x/w', type: 'module' }))
  fs.writeFileSync(
    path.join(dir, 'infra-kit.config.ts'),
    "export default { requiredScripts: [], requiredFiles: ['package.json'] }",
  )

  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('validatePackage passed', () => {
  it('stays true when a check warns', async () => {
    vi.mocked(checkAgentGuidance).mockReturnValue({ name: 'agent-guidance', status: 'warn', message: 'drift' })

    const result = await validatePackage(makePackage())

    expect(
      result.checks.some((check) => {
        return check.status === 'warn'
      }),
    ).toBe(true)
    expect(result.passed).toBe(true)
  })

  it('turns false when a check fails', async () => {
    vi.mocked(checkAgentGuidance).mockReturnValue({ name: 'agent-guidance', status: 'fail', message: 'missing' })

    expect((await validatePackage(makePackage())).passed).toBe(false)
  })
})
