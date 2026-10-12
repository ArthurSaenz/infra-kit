import { describe, expect, it } from 'vitest'

import type { AutoSetupRecord } from 'src/lib/auto-setup/record'

import { checkAutoSetup } from '../doctor'

const record = (overrides: Partial<AutoSetupRecord> = {}): AutoSetupRecord => {
  return {
    version: '0.19.0',
    attempts: 1,
    startedMs: 1,
    finishedMs: 2,
    runs: [
      { root: null, status: 'ok', notes: [] },
      { root: '/p/api', status: 'ok', notes: [] },
    ],
    ...overrides,
  }
}

describe('checkAutoSetup', () => {
  it('skips before the first pass and while a pass for this version is still owed', () => {
    expect(checkAutoSetup(null, '0.19.0').status).toBe('skip')
    expect(checkAutoSetup(record({ version: '0.18.1' }), '0.19.0')).toMatchObject({
      status: 'skip',
      message: 'last ran for 0.18.1; runs for 0.19.0 after the next background update check',
    })
  })

  it('skips while a pass is running or after one was interrupted', () => {
    expect(checkAutoSetup(record({ finishedMs: null, runs: [] }), '0.19.0').status).toBe('skip')
  })

  it('passes when every run of this version is ok', () => {
    expect(checkAutoSetup(record(), '0.19.0')).toEqual({
      name: 'background setup',
      status: 'pass',
      message: 'ran for 0.19.0 on the machine and 1 project(s)',
    })
  })

  it('warns — never fails — naming each run that left work', () => {
    const result = checkAutoSetup(
      record({
        runs: [
          { root: null, status: 'attention', notes: ['run /chrome'] },
          { root: '/p/api', status: 'failed', notes: ['killed'] },
        ],
      }),
      '0.19.0',
    )

    expect(result.status).toBe('warn')
    expect(result.message).toContain('machine: attention, /p/api: failed')
    expect(result.message).toContain('auto-setup.log')
  })
})
