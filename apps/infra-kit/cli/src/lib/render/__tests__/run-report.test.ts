import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { RUN_REPORT_GLYPHS, formatRunReport, printRunReport } from '../run-report'
import type { RunReport, RunRow, RunStatus } from '../run-report'

// eslint-disable-next-line no-control-regex -- matching ANSI is the point.
const ANSI = /\u001B\[[0-9;]*m/g
const ESC = '\u001B'

const strip = (text: string): string => {
  return text.replace(ANSI, '')
}

const STATUSES: readonly RunStatus[] = ['ok', 'changed', 'skipped', 'manual', 'warn', 'fail']

const row = (name: string, status: RunStatus, message = `${status} message`): RunRow => {
  return { name, status, message }
}

const report = (rows: RunRow[], extra: Partial<RunReport> = {}): RunReport => {
  return { title: 'infra-kit test', sections: [{ label: 'Section', rows }], ...extra }
}

const render = (rows: RunRow[], width = 200): { header: string; totals: string } => {
  const lines = formatRunReport(report(rows), { width }).map(strip)

  return {
    header: lines.find((line) => {
      return line.startsWith('  Section')
    }) as string,
    totals: lines.at(-1) as string,
  }
}

describe('glyphs', () => {
  it.each(['unicode', 'ascii'] as const)('keeps every %s status marker the same width', (set) => {
    const widths = STATUSES.map((status) => {
      return RUN_REPORT_GLYPHS[set][status].length
    })

    expect(new Set(widths).size).toBe(1)
    expect(RUN_REPORT_GLYPHS[set].separator).toHaveLength(1)
  })

  it('gives every status a distinct marker in both sets', () => {
    for (const set of [RUN_REPORT_GLYPHS.unicode, RUN_REPORT_GLYPHS.ascii]) {
      const markers = STATUSES.map((status) => {
        return set[status]
      })

      expect(new Set(markers).size).toBe(STATUSES.length)
    }
  })

  it('aligns the message column for every status in ASCII mode', () => {
    const lines = formatRunReport(
      report(
        STATUSES.map((status) => {
          return row(`row-${status}`, status, 'MESSAGE')
        }),
      ),
      { unicode: false, width: 200 },
    ).filter((line) => {
      return line.includes('MESSAGE')
    })
    const offsets = lines.map((line) => {
      return line.indexOf('MESSAGE')
    })

    expect(offsets).toHaveLength(STATUSES.length)
    expect(new Set(offsets).size).toBe(1)
  })
})

describe('rollup and totals', () => {
  it.each([
    { mix: 'all ok', rows: [row('a', 'ok'), row('b', 'ok')], header: '2/2 ok', totals: '2 passed' },
    {
      mix: 'ok + fail',
      rows: [row('a', 'ok'), row('b', 'fail')],
      header: '1/2 · 1 failed',
      totals: '1 passed · 1 failed',
    },
    {
      mix: 'ok + warn',
      rows: [row('a', 'ok'), row('b', 'warn')],
      header: '1/2 · 1 warning',
      totals: '1 passed · 1 warned',
    },
    {
      mix: 'ok + changed',
      rows: [row('a', 'ok'), row('b', 'changed')],
      header: '2/2 · 1 changed',
      totals: '1 passed · 1 changed',
    },
    {
      mix: 'ok + skipped',
      rows: [row('a', 'ok'), row('b', 'skipped')],
      header: '1/2 · 1 skipped',
      totals: '1 passed · 1 skipped',
    },
    {
      mix: 'ok + manual',
      rows: [row('a', 'ok'), row('b', 'manual')],
      header: '1/2 · 1 to run yourself',
      totals: '1 passed · 1 to run yourself',
    },
    {
      mix: 'everything',
      rows: [
        ...STATUSES.map((status) => {
          return row(status, status)
        }),
        row('second-warn', 'warn'),
      ],
      header: '2/7 · 1 changed · 1 skipped · 1 to run yourself · 1 failed · 2 warnings',
      totals: '1 passed · 1 changed · 1 skipped · 1 to run yourself · 1 failed · 2 warned',
    },
  ])('$mix', ({ rows, header, totals }) => {
    const rendered = render(rows)

    expect(rendered.header.endsWith(` ${header}`)).toBe(true)
    expect(rendered.totals).toBe(`  ${totals}`)
  })

  it('keeps `n/n ok` for all-ok only: an all-changed section is not called ok', () => {
    expect(render([row('a', 'changed')]).header.endsWith(' 1/1 · 1 changed')).toBe(true)
  })

  it('right-aligns a header carrying every part to exactly the terminal width', () => {
    const rows = STATUSES.map((status) => {
      return row(status, status)
    })

    for (const width of [90, 120]) {
      expect(render(rows, width).header).toHaveLength(width)
    }
  })

  it('trails hints on the totals line', () => {
    const lines = formatRunReport(report([row('a', 'fail')], { hints: ['run the fix'] })).map(strip)

    expect(lines.at(-1)).toBe('  0 passed · 1 failed  run the fix')
  })

  it('states the empty message instead of rendering an empty report', () => {
    expect(formatRunReport(report([])).map(strip)).toEqual(['infra-kit test', '', '  Nothing ran.'])
    expect(formatRunReport(report([], { emptyMessage: 'No checks ran.' })).at(-1)).toBe('  No checks ran.')
  })
})

describe('notes', () => {
  const NOTE = 'sudo /opt/homebrew/Cellar/node/26.0.0/bin/node /opt/homebrew/lib/portless/dist/cli.js service install'

  it('prints each note verbatim on its own hanging line, never wrapped, even past the width', () => {
    const rows = [{ ...row('portless', 'manual', 'run this once'), notes: [NOTE, 'second  note'] }]
    const lines = formatRunReport(report(rows), { width: 40 })
    const messageColumn = (
      lines.find((line) => {
        return line.includes('run this once')
      }) ?? ''
    ).indexOf('run this once')
    const noteLines = lines.filter((line) => {
      return line.includes('sudo') || line.includes('second')
    })

    expect(noteLines).toEqual([`${' '.repeat(messageColumn)}${NOTE}`, `${' '.repeat(messageColumn)}second  note`])
    expect(noteLines[0]!.length).toBeGreaterThan(40)
  })

  it('leaves no trailing whitespace for an empty note', () => {
    const lines = formatRunReport(report([{ ...row('a', 'manual'), notes: [''] }]))

    expect(
      lines.filter((line) => {
        return line !== line.trimEnd()
      }),
    ).toEqual([])
  })
})

describe('colour', () => {
  const everyStatus = STATUSES.map((status) => {
    return { ...row(`row-${status}`, status), notes: ['a note'] }
  })

  it('emits zero ESC bytes when colour is off', () => {
    const output = formatRunReport(report(everyStatus, { hints: ['hint'] }), { color: false }).join('\n')

    expect(output).not.toContain(ESC)
  })

  it('paints the NAME of warn and fail rows only; the other four dim the message instead', () => {
    const lines = formatRunReport(report(everyStatus), { color: true, width: 200 })

    for (const status of STATUSES) {
      const line = lines.find((candidate) => {
        return candidate.includes(`row-${status}`)
      }) as string
      const nameEscaped = new RegExp(`${ESC}\\[[0-9;]*mrow-${status}`).test(line)
      const messageDimmed = line.includes(`${ESC}[2m${status} message`)
      const loud = status === 'warn' || status === 'fail'

      expect({ status, nameEscaped, messageDimmed }).toEqual({ status, nameEscaped: loud, messageDimmed: !loud })
    }
  })
})

describe('printRunReport', () => {
  it('writes the whole report in ONE call ending in a newline', () => {
    const write = vi.fn()

    printRunReport(report([row('a', 'ok'), row('b', 'fail')]), { write, env: {}, stream: {} })

    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]).toContain('infra-kit test')
    expect(write.mock.calls[0]?.[0]?.endsWith('\n')).toBe(true)
  })
})

/** The workspace root, found by walking up: the fixture lives in the plugin tree, outside this package. */
const findRepoRoot = (): string => {
  let dir = path.dirname(fileURLToPath(import.meta.url))

  while (!existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir)

    if (parent === dir) throw new Error('no pnpm-workspace.yaml above the test file')
    dir = parent
  }

  return dir
}

describe('shared chrome fixture', () => {
  // The same report `plugins/infra-kit/skills/doctor/__tests__/session-probe.test.mjs` renders through
  // the probe's duplicated formatter. The probe cannot import this module (it must run when the CLI is
  // broken), so this fixture is the only thing holding the two renderers together.
  it('renders the fixture the session probe also reproduces, byte for byte', () => {
    const fixture = readFileSync(
      path.join(findRepoRoot(), 'plugins/infra-kit/skills/doctor/__tests__/__fixtures__/run-report-chrome.txt'),
      'utf8',
    )
    const chrome: RunReport = {
      title: 'infra-kit chrome fixture',
      sections: [
        {
          label: 'Chrome',
          rows: [
            row('ok row', 'ok', 'passed'),
            row('changed row', 'changed', 'wrote the file'),
            row('skipped row', 'skipped', 'did not run'),
            row('manual row', 'manual', 'run this yourself'),
            row('warn row', 'warn', 'advisory finding'),
            row(
              'fail row',
              'fail',
              'a long message that wraps across several lines of the report and carries one unbreakable token /Users/someone/.claude/plugins/cache/infra-kit/infra-kit/0.0.0/skills/doctor/scripts/session-probe.mjs whole',
            ),
          ],
        },
      ],
    }

    expect(`${formatRunReport(chrome, { width: 80, color: false, unicode: true }).join('\n')}\n`).toBe(fixture)
  })
})
