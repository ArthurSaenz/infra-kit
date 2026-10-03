import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { callerPicksReporter, readPlaywrightReport, summarizePlaywrightReport } from '../playwright-report'

const fixture = (): unknown => {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/playwright-report.json'), 'utf8'))
}

describe('summarizePlaywrightReport', () => {
  it('reports the totals and one entry per failed or flaky test, passes and skips left out', () => {
    const report = summarizePlaywrightReport(fixture())

    expect(report?.summary).toEqual({ expected: 1, unexpected: 1, flaky: 1, skipped: 1 })
    expect(report?.failures).toEqual([
      {
        title: 'Checkout › rejects an expired coupon without changing the total',
        file: '/repo/apps/client/tests/src/tests/checkout/coupon.spec.ts',
        line: 12,
        project: 'chromium',
        status: 'unexpected',
        retry: 0,
        error: 'Error: expect(locator).toHaveText(expected)\n\nExpected: "€40"\nReceived: "€35"',
        tracePath: '/repo/apps/client/tests/test-results/coupon/trace.zip',
      },
      {
        title: 'Checkout › applies a valid coupon',
        file: '/repo/apps/client/tests/src/tests/checkout/coupon.spec.ts',
        line: 30,
        project: 'chromium',
        status: 'flaky',
        retry: 0,
        error: 'Test timeout of 30000ms exceeded.',
        tracePath: '/repo/apps/client/tests/test-results/apply/trace.zip',
      },
    ])
  })

  it('reports run-level errors that no test owns, ANSI stripped', () => {
    const raw = {
      suites: [],
      errors: [{ message: "\u001B[31mError: Cannot find module '#root/fixtures/base.fixture'\u001B[39m" }, {}],
      stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
    }

    const report = summarizePlaywrightReport(raw)

    expect(report?.failures).toEqual([])
    expect(report?.errors).toEqual(["Error: Cannot find module '#root/fixtures/base.fixture'"])
  })

  it('explains an unexpected pass of a test.fail() test, which has no failed attempt', () => {
    const raw = {
      suites: [
        {
          title: 'guard.spec.ts',
          specs: [
            {
              title: 'fails a readonly test that posts',
              file: 'guard.spec.ts',
              line: 7,
              tests: [{ projectName: 'chromium', status: 'unexpected', results: [{ status: 'passed', retry: 0 }] }],
            },
          ],
        },
      ],
      stats: { expected: 0, unexpected: 1, flaky: 0, skipped: 0 },
    }

    expect(summarizePlaywrightReport(raw)?.failures[0]).toMatchObject({
      status: 'unexpected',
      error: 'Expected to fail, but passed.',
    })
  })

  it('truncates a long error message', () => {
    const raw = fixture() as { suites: { suites: { specs: { tests: { results: { error: object }[] }[] }[] }[] }[] }
    const result = raw.suites[0]?.suites[0]?.specs[0]?.tests[0]?.results[0]

    if (result) result.error = { message: 'x'.repeat(5000) }

    const error = summarizePlaywrightReport(raw)?.failures[0]?.error

    expect(error).toHaveLength(2001)
    expect(error?.endsWith('…')).toBe(true)
  })

  it('returns null for anything that is not a Playwright JSON report', () => {
    expect(summarizePlaywrightReport({ suites: 'nope' })).toBeNull()
    expect(summarizePlaywrightReport(null)).toBeNull()
  })
})

describe('readPlaywrightReport', () => {
  it('returns null for a missing or unparseable file instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-e2e-report-test-'))
    const broken = path.join(dir, 'report.json')

    fs.writeFileSync(broken, '{ truncated')

    expect(readPlaywrightReport(path.join(dir, 'missing.json'))).toBeNull()
    expect(readPlaywrightReport(broken)).toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('callerPicksReporter', () => {
  it('sees both spellings of --reporter and nothing else', () => {
    expect(callerPicksReporter(['--reporter=dot'])).toBe(true)
    expect(callerPicksReporter(['src/tests/checkout', '--reporter', 'list'])).toBe(true)
    expect(callerPicksReporter(['--repeat-each=5', 'src/tests/reporter'])).toBe(false)
  })
})
