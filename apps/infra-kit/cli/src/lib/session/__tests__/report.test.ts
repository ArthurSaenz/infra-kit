import { afterEach, describe, expect, it } from 'vitest'

import {
  SESSION_REPORT_ENV,
  addSessionSummary,
  captureSessionReportPath,
  isSessionChild,
  newReportPath,
  readAndUnlinkReport,
  resetSessionReport,
  writeSessionReport,
} from '../report'

afterEach(() => {
  resetSessionReport()
})

describe('captureSessionReportPath', () => {
  it('captures the path and deletes the var so grandchildren do not inherit it', () => {
    const env: NodeJS.ProcessEnv = { [SESSION_REPORT_ENV]: '/fake/report.json', PATH: '/usr/bin' }

    captureSessionReportPath(env)

    expect(env[SESSION_REPORT_ENV]).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(isSessionChild()).toBe(true)
  })

  it('captures null and is a no-op when the var is unset (normal top-level invocation)', () => {
    captureSessionReportPath({ PATH: '/usr/bin' })

    expect(isSessionChild()).toBe(false)
  })

  it('is idempotent — a second capture does not clobber the first', () => {
    captureSessionReportPath({ [SESSION_REPORT_ENV]: '/fake/first.json' })
    captureSessionReportPath({ [SESSION_REPORT_ENV]: '/fake/second.json' })

    const written: Record<string, string> = {}

    writeSessionReport(
      { summary: ['x'] },
      {
        write: (file, data) => {
          written[file] = data
        },
      },
    )

    expect(Object.keys(written)).toEqual(['/fake/first.json'])
  })
})

describe('writeSessionReport', () => {
  it('writes the record on the success path when a path was captured', () => {
    captureSessionReportPath({ [SESSION_REPORT_ENV]: '/fake/r.json' })

    const written: Record<string, string> = {}

    writeSessionReport(
      { equivalent: { line: 'infra-kit vendor check', reproducible: true } },
      {
        write: (file, data) => {
          written[file] = data
        },
      },
    )

    expect(written['/fake/r.json']).toBeDefined()
    expect(JSON.parse(written['/fake/r.json']!)).toEqual({
      equivalent: { line: 'infra-kit vendor check', reproducible: true },
    })
  })

  it('merges accumulated addSessionSummary lines into the written record', () => {
    captureSessionReportPath({ [SESSION_REPORT_ENV]: '/fake/r.json' })
    addSessionSummary('found 3 violations')

    const written: Record<string, string> = {}

    writeSessionReport(
      { equivalent: { line: 'infra-kit audit', reproducible: true } },
      {
        write: (file, data) => {
          written[file] = data
        },
      },
    )

    expect(JSON.parse(written['/fake/r.json']!).summary).toEqual(['found 3 violations'])
  })

  it('is a no-op (no throw, no write) when no path was captured — non-session run', () => {
    captureSessionReportPath({ PATH: '/usr/bin' })

    let calls = 0

    expect(() => {
      return writeSessionReport(
        { summary: ['x'] },
        {
          write: () => {
            calls += 1
          },
        },
      )
    }).not.toThrow()
    expect(calls).toBe(0)
  })
})

describe('newReportPath / readAndUnlinkReport', () => {
  it('mints unique paths under the temp dir without Math.random', () => {
    const a = newReportPath({
      tmpdir: () => {
        return '/fake'
      },
      pid: 42,
    })
    const b = newReportPath({
      tmpdir: () => {
        return '/fake'
      },
      pid: 42,
    })

    expect(a).not.toBe(b)
    expect(a.startsWith('/fake/infra-kit-session-42-')).toBe(true)
  })

  it('reads then unlinks a present report', () => {
    const store = new Map<string, string>([['/fake/r.json', JSON.stringify({ summary: ['ok'] })]])
    const unlinked: string[] = []

    const record = readAndUnlinkReport('/fake/r.json', {
      exists: (f) => {
        return store.has(f)
      },
      read: (f) => {
        return store.get(f)!
      },
      unlink: (f) => {
        return unlinked.push(f)
      },
    })

    expect(record).toEqual({ summary: ['ok'] })
    expect(unlinked).toEqual(['/fake/r.json'])
  })

  it('returns null when the report is absent (child cancelled before writing)', () => {
    const record = readAndUnlinkReport('/fake/missing.json', {
      exists: () => {
        return false
      },
      read: () => {
        return ''
      },
      unlink: () => {
        return undefined
      },
    })

    expect(record).toBeNull()
  })

  it('returns null (and still unlinks) on unparseable content', () => {
    const unlinked: string[] = []
    const record = readAndUnlinkReport('/fake/bad.json', {
      exists: () => {
        return true
      },
      read: () => {
        return 'not json'
      },
      unlink: (f) => {
        return unlinked.push(f)
      },
    })

    expect(record).toBeNull()
    expect(unlinked).toEqual(['/fake/bad.json'])
  })
})
