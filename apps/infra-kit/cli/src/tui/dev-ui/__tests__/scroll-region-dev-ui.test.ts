import { describe, expect, it, vi } from 'vitest'

import type { ReadySummary } from 'src/dev/dev-ui'
import { DevRenderer } from 'src/dev/render'
import { RESTORE_CURSOR, SAVE_CURSOR, paintFooter } from 'src/dev/scroll-region'

import { ScrollRegionDevUi } from '../scroll-region-dev-ui'

/**
 * ScrollRegionDevUi pins the ready header as a DECSTBM scroll-region footer while a `turbo run dev`
 * child owns the same TTY. Tests drive a fake stdout so every escape sequence is asserted exactly. A
 * reference {@link DevRenderer} (same `isTTY`) reproduces the footer layout the UI computes internally.
 */
const baseSummary = (over: Partial<ReadySummary> = {}): ReadySummary => {
  return {
    target: 'client',
    watch: true,
    hasUiChild: true,
    release: 'feat-x',
    elapsedMs: 2400,
    endpoints: [{ tag: 'client/api', url: 'http://localhost:57076/api/v1', healthy: true }],
    uiRefs: [{ tag: 'client/ui' }],
    watchSummary: '1 app · 5 packages',
    logPath: '~/.cache/infra-kit/ab12cd34/logs.txt',
    logHref: '/home/u/.cache/infra-kit/ab12cd34/logs.txt',
    ...over,
  }
}

type FakeStdout = NodeJS.WriteStream & {
  write: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
}

const makeStdout = (over: Partial<{ isTTY: boolean; rows: number }> = {}): FakeStdout => {
  return {
    isTTY: true,
    rows: 40,
    columns: 100,
    write: vi.fn((): boolean => {
      return true
    }),
    on: vi.fn(),
    off: vi.fn(),
    ...over,
  } as unknown as FakeStdout
}

/** All bytes the UI has written to the fake stdout so far, concatenated. */
const written = (stdout: FakeStdout): string => {
  return stdout.write.mock.calls
    .map((c) => {
      return c[0] as string
    })
    .join('')
}

/** A reference footer layout matching what the UI computes internally for `isTTY`. */
const referenceFooter = (summary: ReadySummary, isTTY: boolean): string[] => {
  return new DevRenderer({ isTTY, appendLog: () => {}, write: () => {} }).formatReadyLines(summary)
}

const makeUi = (
  over: Partial<{ isTTY: boolean; rows: number }> = {},
): { ui: ScrollRegionDevUi; stdout: FakeStdout } => {
  const stdout = makeStdout(over)
  const ui = new ScrollRegionDevUi({ appendLog: () => {}, verbose: false, stdout })

  return { ui, stdout }
}

describe('scrollRegionDevUi — TTY sticky footer', () => {
  it('installs the scroll region above the footer and paints the footer in the bottom rows', () => {
    const { ui, stdout } = makeUi()
    const summary = baseSummary()
    const footer = referenceFooter(summary, true)
    const h = footer.length

    ui.ready(summary)
    const out = written(stdout)

    // Region confines scrolling to rows 1..(40 - h).
    expect(out).toContain(`\x1B[1;${40 - h}r`)
    // Footer painted from the first footer row (40 - h + 1) down to the last row (40).
    expect(out).toContain(`\x1B[${40 - h + 1};1H`)
    expect(out).toContain('\x1B[40;1H')
    // The whole paint sequence for the current footer is present verbatim.
    expect(out).toContain(paintFooter(footer, 40))
    // The resize listener is armed.
    expect(stdout.on).toHaveBeenCalledWith('resize', expect.any(Function))
  })

  it('log() writes plainly into the scroll region (no escape sequences)', () => {
    const { ui, stdout } = makeUi()

    ui.ready(baseSummary())
    stdout.write.mockClear()
    ui.log('a plain log line')

    expect(stdout.write).toHaveBeenCalledWith('a plain log line\n')
    expect(written(stdout)).not.toContain('\x1B')
  })

  it('refresh() repaints ONLY the footer in place (no region reinstall)', () => {
    const { ui, stdout } = makeUi()

    ui.ready(baseSummary())
    stdout.write.mockClear()

    const down = baseSummary({
      endpoints: [{ tag: 'client/api', url: 'http://localhost:57076/api/v1', healthy: false }],
    })

    ui.refresh(down)
    const out = written(stdout)

    // Exactly the footer paint for the new summary — nothing else, and no scroll-region set.
    expect(out).toBe(paintFooter(referenceFooter(down, true), 40))
    expect(out.startsWith(SAVE_CURSOR)).toBe(true)
    expect(out.endsWith(RESTORE_CURSOR)).toBe(true)
    // No scroll-region (DECSTBM) reinstall in a footer-only repaint.
    expect(out).not.toContain(`\x1B[1;${40 - referenceFooter(down, true).length}r`)
  })

  it('dispose() resets the scroll region and is idempotent', () => {
    const { ui, stdout } = makeUi()

    ui.ready(baseSummary())
    stdout.write.mockClear()

    ui.dispose()
    const out = written(stdout)

    expect(out).toContain('\x1B[r') // scroll region reset
    expect(out).toContain('\x1B[?25h') // cursor restored
    expect(stdout.off).toHaveBeenCalledWith('resize', expect.any(Function))

    // A second dispose writes nothing more.
    const callsAfterFirst = stdout.write.mock.calls.length

    ui.dispose()
    expect(stdout.write.mock.calls).toHaveLength(callsAfterFirst)
  })
})

describe('scrollRegionDevUi — non-TTY and too-short fallbacks', () => {
  it('non-TTY writes the header lines plainly with NO escape sequences', () => {
    const { ui, stdout } = makeUi({ isTTY: false })

    ui.ready(baseSummary())
    const out = written(stdout)

    expect(out).not.toContain('\x1B')
    expect(out).toContain('http://localhost:57076/api/v1')
    // No region was installed → no resize listener.
    expect(stdout.on).not.toHaveBeenCalled()
  })

  it('treats a TTY reporting rows=0 as a 24-row terminal and still installs the region', () => {
    // A pty allocated without a window size (`script(1)`, some CI runners, a terminal before its first
    // SIGWINCH) reports `isTTY: true` with `rows: 0`. A `??` fallback would pass the 0 through and
    // silently disable the footer on a terminal that is actually tall enough.
    const { ui, stdout } = makeUi({ rows: 0 })

    ui.ready(baseSummary())

    const out = written(stdout)
    const h = referenceFooter(baseSummary(), true).length

    expect(out).toContain(`\x1B[1;${24 - h}r`)
    expect(stdout.on).toHaveBeenCalled()
  })

  it('a 3-row terminal disables the feature (plain print) instead of throwing', () => {
    const { ui, stdout } = makeUi({ rows: 3 })

    expect(() => {
      ui.ready(baseSummary())
    }).not.toThrow()

    const out = written(stdout)
    const h = referenceFooter(baseSummary(), true).length

    // Too short for a region → the DECSTBM set is absent; the header is still printed.
    expect(out).not.toContain(`\x1B[1;${3 - h}r`)
    expect(out).toContain('http://localhost:57076/api/v1')
    // No region installed → no resize listener armed.
    expect(stdout.on).not.toHaveBeenCalled()
    // dispose stays safe even though nothing was installed.
    expect(() => {
      ui.dispose()
    }).not.toThrow()
  })
})
