import { describe, expect, it, vi } from 'vitest'

import type { CheckResult } from '../doctor'
import {
  DOCTOR_CHECK_NAMES,
  FIXABLE_NAMES,
  OTHER_SECTION,
  formatDoctorReport,
  groupChecks,
  printDoctorReport,
  resolveReportCapabilities,
} from '../report'

const pass = (name: string, message = 'ok'): CheckResult => {
  return { name, status: 'pass', message }
}

const fail = (name: string, message = 'broken'): CheckResult => {
  return { name, status: 'fail', message }
}

/** eslint-disable-next-line no-control-regex — matching ANSI is the point. */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g

const strip = (text: string): string => {
  return text.replace(ANSI, '')
}

describe('groupChecks', () => {
  it('groups checks into the five sections in print order', () => {
    const sections = groupChecks([
      pass('portless installed'),
      pass('gh installed'),
      pass('env token valid'),
      pass('zshrc init block'),
      pass('user override path'),
    ])

    expect(
      sections.map((section) => {
        return section.label
      }),
    ).toEqual(['Tools & CLIs', 'Shell & integration', 'Project config', 'Doppler env tokens', 'Dev proxy (portless)'])
  })

  it('omits sections that have no checks', () => {
    const sections = groupChecks([pass('gh installed')])

    expect(sections).toHaveLength(1)
    expect(sections[0]?.label).toBe('Tools & CLIs')
  })

  it('puts an unmapped name in the Other bucket rather than dropping it', () => {
    const sections = groupChecks([pass('gh installed'), pass('some brand new check')])
    const other = sections.find((section) => {
      return section.label === OTHER_SECTION
    })

    expect(
      other?.checks.map((check) => {
        return check.name
      }),
    ).toEqual(['some brand new check'])
  })

  it('does NOT mutate or reorder its input (structuredContent.checks order is a contract)', () => {
    const input = [pass('portless installed'), pass('gh installed'), pass('env token valid')]
    const snapshot = [...input]

    groupChecks(input)

    expect(input).toEqual(snapshot)
    expect(input[0]?.name).toBe('portless installed')
  })
})

describe('section coverage', () => {
  it('maps every canonical check name to a real section, never Other', () => {
    const unmapped = DOCTOR_CHECK_NAMES.filter((name) => {
      const [section] = groupChecks([pass(name)])

      return section === undefined || section.label === OTHER_SECTION
    })

    expect(unmapped).toEqual([])
  })

  it('covers exactly 24 checks', () => {
    expect(DOCTOR_CHECK_NAMES).toHaveLength(24)
    expect(new Set(DOCTOR_CHECK_NAMES).size).toBe(24)
  })
})

describe('formatDoctorReport', () => {
  it('renders a section header with an all-pass rollup', () => {
    const lines = formatDoctorReport([pass('gh installed'), pass('aws installed')])
    const header = lines.find((line) => {
      return line.includes('Tools & CLIs')
    })

    expect(strip(header ?? '')).toContain('2/2 ok')
  })

  it('renders a mixed rollup showing the failure count', () => {
    const lines = formatDoctorReport([pass('gh installed'), fail('aws installed')])
    const header = lines.find((line) => {
      return line.includes('Tools & CLIs')
    })

    expect(strip(header ?? '')).toContain('1/2')
    expect(strip(header ?? '')).toContain('1 failed')
  })

  it('reports totals in the summary', () => {
    const lines = formatDoctorReport([pass('gh installed'), pass('aws installed'), fail('zshrc init block')])
    const summary = strip(lines.join('\n'))

    expect(summary).toContain('2 passed')
    expect(summary).toContain('1 failed')
  })

  it('shows the --fix hint only when a FAILING check is in FIXABLE_NAMES', () => {
    const fixable = strip(formatDoctorReport([fail('portless routes')]).join('\n'))
    const notFixable = strip(formatDoctorReport([fail('gh installed')]).join('\n'))
    const passingFixable = strip(formatDoctorReport([pass('portless routes')]).join('\n'))

    expect(fixable).toContain('infra-kit doctor --fix')
    expect(notFixable).not.toContain('infra-kit doctor --fix')
    expect(passingFixable).not.toContain('infra-kit doctor --fix')
  })

  it('counts every fixable failure in the hint', () => {
    const lines = strip(formatDoctorReport([fail('portless routes'), fail('tokens.json perms')]).join('\n'))

    expect(lines).toContain('2 fixable')
    expect([...FIXABLE_NAMES]).toHaveLength(2)
  })

  it('emits zero ANSI escape bytes when color is off', () => {
    const output = formatDoctorReport([pass('gh installed'), fail('portless routes')], { color: false }).join('\n')

    expect(output).toBe(strip(output))
  })

  it('emits ANSI when color is on', () => {
    const output = formatDoctorReport([fail('gh installed')], { color: true }).join('\n')

    expect(output).not.toBe(strip(output))
  })

  it('falls back to ASCII markers when unicode is off', () => {
    const output = formatDoctorReport([pass('gh installed'), fail('aws installed')], { unicode: false }).join('\n')

    expect(output).not.toContain('✓')
    expect(output).not.toContain('✗')
    expect(output).not.toContain('─')
    expect(output).toContain('ok')
    expect(output).toContain('!!')
  })

  it('degrades to a stated "no checks" line rather than an empty report', () => {
    const output = strip(formatDoctorReport([]).join('\n'))

    expect(output).toContain('infra-kit doctor')
    expect(output).toContain('No checks ran.')
  })

  it('leaves no trailing whitespace on any line', () => {
    const lines = formatDoctorReport([pass('gh installed', ''), fail('portless routes')], { width: 100 })
    const trailing = lines.filter((line) => {
      return line !== line.trimEnd()
    })

    expect(trailing).toEqual([])
  })

  it('uses unicode glyphs by default', () => {
    const output = formatDoctorReport([pass('gh installed'), fail('aws installed')]).join('\n')

    expect(output).toContain('✓')
    expect(output).toContain('✗')
  })
})

/**
 * The regression this guards: `padEnd` counts ANSI escape bytes as visible characters, so colouring a
 * glyph or name BEFORE padding skews every column — and only on the coloured path, which is the one a
 * naive strip-then-assert test never looks at. Here we render WITH colour, then strip, and require the
 * message column to land at the same visible offset for names of very different lengths.
 */
describe('column alignment under colour', () => {
  const checks = [
    pass('gh installed', 'MESSAGE'),
    pass('typescript-language-server installed', 'MESSAGE'),
    fail('terminal installed', 'MESSAGE'),
  ]

  const messageOffsets = (color: boolean): number[] => {
    return formatDoctorReport(checks, { color, width: 200 })
      .filter((line) => {
        return line.includes('MESSAGE')
      })
      .map((line) => {
        return strip(line).indexOf('MESSAGE')
      })
  }

  it('aligns the message column by VISIBLE width when colour is on', () => {
    const offsets = messageOffsets(true)

    expect(offsets).toHaveLength(3)
    expect(new Set(offsets).size).toBe(1)
  })

  it('produces the same visible layout with and without colour', () => {
    expect(messageOffsets(true)).toEqual(messageOffsets(false))
  })
})

/**
 * The regression that shipped once: the rollup's width was reconstructed from a stand-in template
 * that matched NEITHER branch of `formatRollup`, so all-pass headers stopped 6 columns short and
 * failing headers overshot by 2 and wrapped — mangling exactly the line the grouping exists to make
 * obvious. Any header measurement that is not taken from the rollup itself fails these.
 */
describe('section header right-alignment', () => {
  const headerFor = (checks: CheckResult[], width: number, color = false): string => {
    const line = formatDoctorReport(checks, { width, color }).find((candidate) => {
      return candidate.includes('Tools & CLIs')
    })

    return strip(line ?? '')
  }

  it('fills exactly the terminal width for an all-pass section', () => {
    expect(headerFor([pass('gh installed'), pass('aws installed')], 80)).toHaveLength(80)
  })

  it('fills exactly the terminal width for a section with failures', () => {
    expect(headerFor([pass('gh installed'), fail('aws installed')], 80)).toHaveLength(80)
  })

  it('holds at other widths, in ASCII mode, and under colour', () => {
    for (const width of [60, 100, 150]) {
      expect(headerFor([pass('gh installed'), fail('aws installed')], width)).toHaveLength(width)
      expect(headerFor([pass('gh installed'), pass('aws installed')], width)).toHaveLength(width)
      expect(headerFor([pass('gh installed'), fail('aws installed')], width, true)).toHaveLength(width)
    }

    const ascii = strip(
      formatDoctorReport([pass('gh installed'), fail('aws installed')], { width: 90, unicode: false }).find((line) => {
        return line.includes('Tools & CLIs')
      }) ?? '',
    )

    expect(ascii).toHaveLength(90)
  })

  it('never wraps: no rendered section header exceeds the width', () => {
    const labels = ['Tools & CLIs', 'Shell & integration', 'Dev proxy (portless)']
    const checks = [pass('gh installed'), fail('portless routes'), pass('zshrc init block')]
    const overlong = formatDoctorReport(checks, { width: 70 })
      .map((line) => {
        return strip(line)
      })
      .filter((line) => {
        return (
          labels.some((label) => {
            return line.includes(label)
          }) && line.length > 70
        )
      })

    expect(overlong).toEqual([])
  })
})

/**
 * Fail messages carry the command the user must run (`checkPortlessServing` prints a full
 * `<node> <cli.js> service install`). Truncating one is worse than wrapping it, so the contract is:
 * hanging-indent to the message column, never elide.
 */
describe('long messages at a narrow width', () => {
  const LONG =
    'No portless daemon is serving HTTPS on :443. Install it once (needs root): ' +
    '`sudo /opt/homebrew/Cellar/node/26.0.0/bin/node /opt/homebrew/lib/node_modules/infra-kit/node_modules/portless/dist/cli.js service install`.'

  const rows = (): string[] => {
    const lines = formatDoctorReport([fail('portless serving TLS on :443', LONG)], { width: 40, color: false })
    const start = lines.findIndex((line) => {
      return line.includes('portless serving TLS')
    })
    // Stop at the blank line that closes the section, so the summary rule (indented 2) is not
    // mistaken for a wrapped continuation of the message.
    const end = lines.findIndex((line, index) => {
      return index > start && line.trim().length === 0
    })

    return lines.slice(start, end === -1 ? undefined : end)
  }

  it('never truncates — every word of the fix command survives', () => {
    const rendered = rows().join(' ')

    expect(rendered).not.toContain('…')
    expect(rendered).not.toContain('...')
    for (const word of LONG.split(/\s+/)) {
      expect(rendered).toContain(word)
    }
  })

  it('keeps the long path token intact on a single line', () => {
    const path = '/opt/homebrew/lib/node_modules/infra-kit/node_modules/portless/dist/cli.js'
    const holder = rows().find((line) => {
      return line.includes(path)
    })

    expect(holder).toBeDefined()
  })

  it('hanging-indents continuation lines to the message column', () => {
    const rendered = rows()
    const first = rendered[0] ?? ''
    const messageColumn = first.indexOf('No portless daemon')
    const continuations = rendered.slice(1)
    const indents = continuations.map((line) => {
      return line.search(/\S/)
    })

    expect(continuations.length).toBeGreaterThan(0)
    expect(new Set(indents)).toEqual(new Set([messageColumn]))
  })
})

describe('resolveReportCapabilities', () => {
  it('turns colour on for a stderr TTY', () => {
    expect(resolveReportCapabilities({ env: {}, stream: { isTTY: true } }).color).toBe(true)
  })

  it('turns colour off when the stream is not a TTY', () => {
    expect(resolveReportCapabilities({ env: {}, stream: { isTTY: false } }).color).toBe(false)
  })

  it('honours NO_COLOR over a TTY', () => {
    expect(resolveReportCapabilities({ env: { NO_COLOR: '1' }, stream: { isTTY: true } }).color).toBe(false)
  })

  it('honours FORCE_COLOR through a pipe', () => {
    expect(resolveReportCapabilities({ env: { FORCE_COLOR: '1' }, stream: { isTTY: false } }).color).toBe(true)
  })

  it('treats FORCE_COLOR=0 as OFF even on a TTY (Boolean("0") is true — the trap)', () => {
    expect(resolveReportCapabilities({ env: { FORCE_COLOR: '0' }, stream: { isTTY: true } }).color).toBe(false)
    expect(resolveReportCapabilities({ env: { FORCE_COLOR: 'false' }, stream: { isTTY: true } }).color).toBe(false)
  })

  it('assumes unicode when NO locale variable is set', () => {
    expect(resolveReportCapabilities({ env: {}, stream: {} }).unicode).toBe(true)
  })

  it('keeps unicode for a UTF-8 locale', () => {
    expect(resolveReportCapabilities({ env: { LANG: 'en_US.UTF-8' }, stream: {} }).unicode).toBe(true)
  })

  it('drops to ASCII for a non-UTF-8 locale that is actually set', () => {
    expect(resolveReportCapabilities({ env: { LC_ALL: 'C' }, stream: {} }).unicode).toBe(false)
  })

  it('lets --ascii force ASCII regardless of locale', () => {
    expect(resolveReportCapabilities({ ascii: true, env: { LANG: 'en_US.UTF-8' }, stream: {} }).unicode).toBe(false)
  })

  it('takes the width from the target stream and falls back to 80', () => {
    expect(resolveReportCapabilities({ env: {}, stream: { columns: 120 } }).width).toBe(120)
    expect(resolveReportCapabilities({ env: {}, stream: {} }).width).toBe(80)
  })
})

describe('printDoctorReport', () => {
  it('writes the whole report in ONE call (pino shares fd 2 — many writes could tear)', () => {
    const write = vi.fn()

    printDoctorReport([pass('gh installed')], { write, env: {}, stream: {} })

    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]).toContain('gh installed')
    expect(write.mock.calls[0]?.[0]?.endsWith('\n')).toBe(true)
  })

  it('never touches stdout — that stream belongs to --json and the MCP transport', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const write = vi.fn()

    printDoctorReport([pass('gh installed'), fail('portless routes')], { write, env: {}, stream: {} })

    expect(stdout).not.toHaveBeenCalled()
    stdout.mockRestore()
  })
})
