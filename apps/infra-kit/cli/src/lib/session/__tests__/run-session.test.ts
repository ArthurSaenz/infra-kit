import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'

import { SESSION_REPORT_ENV } from '../report'
import { runSession, sessionGateEnabled } from '../run-session'
import type { SessionCommand, SessionPaletteItem } from '../run-session'

const items: SessionPaletteItem[] = [{ name: 'vendor-check', description: 'Verify vendor/', group: 'Environment' }]

/** A fake child: writes a report (optionally) to the env path, then emits exit on the next tick. */
interface ChildBehavior {
  code: number | null
  signal?: NodeJS.Signals | null
  writeReport?: boolean
}

const fakeSpawnFor = (behaviors: ChildBehavior[], log: string[]) => {
  let call = 0

  return (_execPath: string, _argv: string[], opts: { env: NodeJS.ProcessEnv }): EventEmitter => {
    const behavior = behaviors[Math.min(call, behaviors.length - 1)]!

    call += 1
    log.push('spawn')

    const child = new EventEmitter()

    queueMicrotask(() => {
      if (behavior.writeReport) {
        const reportPath = opts.env[SESSION_REPORT_ENV]!

        fs.writeFileSync(reportPath, JSON.stringify({}))
      }
      child.emit('exit', behavior.code, behavior.signal ?? null)
    })

    return child
  }
}

/** A renderPalette that returns each queued pick in turn, then `null` (quit). */
const pickThenQuit = (picks: (string | null)[], log: string[]) => {
  let call = 0

  return async (): Promise<string | null> => {
    log.push('render')

    const pick = call < picks.length ? picks[call]! : null

    call += 1

    return pick
  }
}

const resolveVendorCheck = (name: string): SessionCommand | undefined => {
  return name === 'vendor-check' ? { groupPath: ['vendor', 'check'] } : undefined
}

const ttyStreams = { stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true }

describe('sessionGateEnabled', () => {
  it('is true for an interactive TTY with a capable terminal and no opt-out', () => {
    expect(sessionGateEnabled({ TERM: 'xterm' }, ttyStreams)).toBe(true)
  })

  it('is false when any stream is not a TTY', () => {
    expect(sessionGateEnabled({ TERM: 'xterm' }, { ...ttyStreams, stdoutIsTTY: false })).toBe(false)
    expect(sessionGateEnabled({ TERM: 'xterm' }, { ...ttyStreams, stdinIsTTY: false })).toBe(false)
  })

  it('is false when stderr is redirected — the palette and transcript both render there', () => {
    // `infra-kit 2>out.log`: the palette would be invisible, and pipe writes are async on macOS, so
    // the echoed header could land after the child's output.
    expect(sessionGateEnabled({ TERM: 'xterm' }, { ...ttyStreams, stderrIsTTY: false })).toBe(false)
  })

  it('is false for TERM=dumb, the opt-out env, or a nested session child', () => {
    expect(sessionGateEnabled({ TERM: 'dumb' }, ttyStreams)).toBe(false)
    expect(sessionGateEnabled({ TERM: 'xterm', INFRA_KIT_NO_SESSION: '1' }, ttyStreams)).toBe(false)
    expect(sessionGateEnabled({ TERM: 'xterm', [SESSION_REPORT_ENV]: '/fake/r.json' }, ttyStreams)).toBe(false)
  })

  it('does not require INFRA_KIT_SESSION (works without `infra-kit init`)', () => {
    expect(sessionGateEnabled({ TERM: 'xterm' }, ttyStreams)).toBe(true)
  })
})

/**
 * Each pick writes TWO blocks now: the `$ infra-kit …` header echoed BEFORE the child runs (so its
 * real output — which now lands on the primary screen, in the scrollback — arrives under a heading),
 * and the status footer after. `written[0]` is the header; `written[1]` is the footer.
 */
describe('runSession loop', () => {
  const baseDeps = (written: string[], spawn: unknown, resets: { entersAltScreen?: boolean }[] = []) => {
    return {
      resolveCommand: resolveVendorCheck,
      cliPath: '/dist/cli.js',
      spawn: spawn as never,
      now: () => {
        return 0
      },
      write: (text: string) => {
        return written.push(text)
      },
      resetTerminal: (opts: { entersAltScreen?: boolean }) => {
        return resets.push(opts)
      },
      env: { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
      ascii: true,
      installSignals: false as const,
    }
  }

  /** The footer of the n-th pick (writes go header, footer, header, footer, …). */
  const footer = (written: string[], pick = 0): string => {
    return written[pick * 2 + 1] ?? ''
  }

  const header = (written: string[], pick = 0): string => {
    return written[pick * 2] ?? ''
  }

  it('echoes a header and a footer per pick, and quits on null', async () => {
    const log: string[] = []
    const written: string[] = []
    const spawn = fakeSpawnFor([{ code: 0, writeReport: true }], log)

    await runSession(items, {
      renderPalette: pickThenQuit(['vendor-check', 'vendor-check', null], log),
      ...baseDeps(written, spawn),
    })

    expect(written).toHaveLength(4) // two picks × (header + footer)
    expect(header(written)).toContain('$ infra-kit vendor check')
    expect(footer(written)).toContain('[ok]')
  })

  it('does not repeat the command line in the footer when it matches the echoed header', async () => {
    const log: string[] = []
    const written: string[] = []
    const spawn = fakeSpawnFor([{ code: 0, writeReport: true }], log)

    await runSession(items, {
      renderPalette: pickThenQuit(['vendor-check', null], log),
      ...baseDeps(written, spawn),
    })

    // The header already said it; the footer is just the status line.
    expect(footer(written)).not.toContain('infra-kit vendor check')
    expect(footer(written)).toContain('[ok]')
  })

  it('echoes the header BEFORE spawning the child, and renders the palette before that', async () => {
    const log: string[] = []
    const written: string[] = []
    const spawn = fakeSpawnFor([{ code: 0, writeReport: true }], log)

    await runSession(items, {
      renderPalette: pickThenQuit(['vendor-check', null], log),
      ...baseDeps(written, spawn),
      write: (text: string) => {
        written.push(text)
        log.push(text.includes('$ ') ? 'header' : 'footer')
      },
    })

    // The header must reach the terminal before the child starts drawing on it.
    expect(log).toEqual(['render', 'header', 'spawn', 'footer', 'render'])
  })

  it('classifies findings (report present, non-zero exit) and continues the loop', async () => {
    const log: string[] = []
    const written: string[] = []
    const spawn = fakeSpawnFor([{ code: 1, writeReport: true }], log)

    await runSession(items, {
      renderPalette: pickThenQuit(['vendor-check', 'vendor-check', null], log),
      ...baseDeps(written, spawn),
    })

    expect(written).toHaveLength(4)
    expect(footer(written)).toContain('[!]') // findings glyph (ascii)
  })

  it('classifies failed (no report, non-zero exit)', async () => {
    const log: string[] = []
    const written: string[] = []
    const spawn = fakeSpawnFor([{ code: 1, writeReport: false }], log)

    await runSession(items, {
      renderPalette: pickThenQuit(['vendor-check', null], log),
      ...baseDeps(written, spawn),
    })

    expect(footer(written)).toContain('[x]') // failed
  })

  it('classifies cancelled (no report, exit 0) and keeps looping', async () => {
    const log: string[] = []
    const written: string[] = []
    const spawn = fakeSpawnFor([{ code: 0, writeReport: false }], log)

    await runSession(items, {
      renderPalette: pickThenQuit(['vendor-check', 'vendor-check', null], log),
      ...baseDeps(written, spawn),
    })

    expect(written).toHaveLength(4)
    expect(footer(written)).toContain('[-]') // cancelled
  })

  it('classifies cancelled when the child is killed by SIGINT', async () => {
    const log: string[] = []
    const written: string[] = []
    const spawn = fakeSpawnFor([{ code: null, signal: 'SIGINT', writeReport: false }], log)

    await runSession(items, {
      renderPalette: pickThenQuit(['vendor-check', null], log),
      ...baseDeps(written, spawn),
    })

    expect(footer(written)).toContain('[-]') // cancelled
  })

  it('degrades a synchronous spawn throw to a failed entry and keeps the loop alive', async () => {
    const log: string[] = []
    const written: string[] = []
    const throwingSpawn = (() => {
      log.push('spawn')

      throw new Error('spawn boom')
    }) as never

    await runSession(items, {
      renderPalette: pickThenQuit(['vendor-check', 'vendor-check', null], log),
      ...baseDeps(written, throwingSpawn),
    })

    expect(written).toHaveLength(4)
    expect(footer(written)).toContain('[x]') // failed — the session survived the throw
  })

  it('never wraps the child in the alternate screen (that is what swallowed every command output)', async () => {
    const log: string[] = []
    const written: string[] = []
    const spawn = fakeSpawnFor([{ code: 0, writeReport: true }], log)

    await runSession(items, {
      renderPalette: pickThenQuit(['vendor-check', null], log),
      ...baseDeps(written, spawn),
    })

    expect(written.join('')).not.toContain('[?1049')
  })

  it('spawns the child with inherited stdio so its output reaches the terminal', async () => {
    const log: string[] = []
    const written: string[] = []
    const spy = vi.fn(fakeSpawnFor([{ code: 0, writeReport: true }], log))

    await runSession(items, {
      renderPalette: pickThenQuit(['vendor-check', null], log),
      ...baseDeps(written, spy as never),
    })

    const [, argv, opts] = spy.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv; stdio: string }]

    expect(opts.stdio).toBe('inherit') // piping would strip the child's TTY, colour and prompts
    expect(argv).toEqual(['/dist/cli.js', 'vendor', 'check'])
    expect(opts.env.INFRA_KIT_NO_AUTO_UPDATE).toBe('1')
    expect(opts.env[SESSION_REPORT_ENV]).toContain(`infra-kit-session-${process.pid}-`)
  })

  describe('terminal hygiene', () => {
    it.each([
      ['ok', { code: 0, writeReport: true }],
      ['findings', { code: 1, writeReport: true }],
      ['failed', { code: 1, writeReport: false }],
      ['cancelled', { code: null, signal: 'SIGINT' as const, writeReport: false }],
    ])('resets the terminal after a %s child, not just a cancelled one', async (_name, behavior) => {
      const log: string[] = []
      const written: string[] = []
      const resets: { entersAltScreen?: boolean }[] = []

      await runSession(items, {
        renderPalette: pickThenQuit(['vendor-check', null], log),
        ...baseDeps(written, fakeSpawnFor([behavior as ChildBehavior], log), resets),
      })

      expect(resets).toHaveLength(1)
    })

    it('resets the terminal even when the spawn throws', async () => {
      const log: string[] = []
      const written: string[] = []
      const resets: { entersAltScreen?: boolean }[] = []
      const throwingSpawn = (() => {
        throw new Error('spawn boom')
      }) as never

      await runSession(items, {
        renderPalette: pickThenQuit(['vendor-check', null], log),
        ...baseDeps(written, throwingSpawn, resets),
      })

      expect(resets).toHaveLength(1)
    })

    it("forwards the command's entersAltScreen flag, so a killed $EDITOR cannot strand the alt buffer", async () => {
      const log: string[] = []
      const written: string[] = []
      const resets: { entersAltScreen?: boolean }[] = []

      await runSession(items, {
        renderPalette: pickThenQuit(['vendor-check', null], log),
        ...baseDeps(written, fakeSpawnFor([{ code: 0, writeReport: true }], log), resets),
        resolveCommand: () => {
          return { groupPath: ['config', 'edit'], entersAltScreen: true }
        },
      })

      expect(resets[0]?.entersAltScreen).toBe(true)
    })
  })
})
