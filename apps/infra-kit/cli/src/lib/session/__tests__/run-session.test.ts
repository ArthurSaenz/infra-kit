import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'

import type { PauseContext } from '../post-run-pause'
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
/** Chalk's level-1 SGR codes, spelled with an explicit escape so no raw control byte lands in source. */
const SGR_BOLD = '\u001B[1m'
const SGR_GREEN = '\u001B[32m'

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
      // EXPLICIT, so no test's correctness depends on whatever stdin the vitest pool hands this worker:
      // the real default would consult `process.stdin.isTTY`, which differs between a local run and CI.
      // It writes nothing, so the `header()` / `footer()` index helpers below stay valid. It arms even
      // though it does not block — `armed()` is idempotent and the phase is reset at the top of the loop.
      afterRun: async (ctx: PauseContext) => {
        ctx.armed()

        return 'palette' as const
      },
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

  /**
   * The framing is what separates one run from the next in the scrollback, and the loop is the only
   * party that knows the terminal's width and colour support — the formatter is deliberately pure. So
   * the plumbing itself needs a test: drop either `width` or `color` on the floor here and every block
   * silently goes back to being an undifferentiated wall of text, with no other test noticing.
   */
  it('threads the terminal width and colour through to the framing it commits', async () => {
    const log: string[] = []
    const written: string[] = []
    const spawn = fakeSpawnFor([{ code: 0, writeReport: true }], log)

    await runSession(items, {
      renderPalette: pickThenQuit(['vendor-check', null], log),
      ...baseDeps(written, spawn),
      ascii: true,
      color: true,
      columns: () => {
        return 40
      },
    })

    // `[ok] ok · 0ms` is 13 columns, so the rule must be exactly 40 - 2 - 13 = 25 — no more (it would
    // wrap off the edge) and no fewer (it would stop short of the margin). The exact run catches both.
    // (Asserted on the rule alone, not the whole line: under colour the status is not one contiguous
    // substring — chalk interleaves an SGR code between the verdict and the duration.)
    expect(footer(written)).toContain('-'.repeat(25))
    expect(footer(written)).not.toContain('-'.repeat(26))
    // Colour is on, so both blocks carry SGR codes: the header bolded, the footer coloured by outcome.
    expect(header(written)).toContain(SGR_BOLD)
    expect(footer(written)).toContain(SGR_GREEN)
  })

  it('draws no rule and no colour when the transcript is not going to a terminal', async () => {
    const log: string[] = []
    const written: string[] = []
    const spawn = fakeSpawnFor([{ code: 0, writeReport: true }], log)

    await runSession(items, {
      renderPalette: pickThenQuit(['vendor-check', null], log),
      ...baseDeps(written, spawn),
      ascii: true,
      color: false,
      // A redirected stderr has no width at all. Injected, NOT left to default: a `columns` that falls
      // through to the real `process.stderr` would make this assert on the test runner's own tty, and it
      // would flip to a rule the day the runner is given one.
      columns: () => {
        return undefined
      },
    })

    expect(footer(written).trim()).toBe('[ok] ok · 0ms')
    expect(header(written).trim()).toBe('$ infra-kit vendor check')
  })

  /**
   * The session shell runs for hours, so the width it framed the LAST command with says nothing about
   * the window the next one lands in. Re-read per run, a resize just changes the next rule's length;
   * snapshotted at boot, a shrunk window would have every later rule overrun the margin and wrap.
   */
  it('re-reads the terminal width for every run, so a mid-session resize is honoured', async () => {
    const log: string[] = []
    const written: string[] = []
    const spawn = fakeSpawnFor(
      [
        { code: 0, writeReport: true },
        { code: 0, writeReport: true },
      ],
      log,
    )
    const widths = [40, 30]

    await runSession(items, {
      renderPalette: pickThenQuit(['vendor-check', 'vendor-check', null], log),
      ...baseDeps(written, spawn),
      ascii: true,
      columns: () => {
        return widths.shift()
      },
    })

    // Same command, same status (`[ok] ok · 0ms`, 13 cols) — only the window shrank between the two.
    expect(footer(written, 0)).toContain(`[ok] ok · 0ms ${'-'.repeat(25)}`) // 40 - 2 - 13
    expect(footer(written, 1)).toContain(`[ok] ok · 0ms ${'-'.repeat(15)}`) // 30 - 2 - 13
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

  /**
   * The pause between a finished command and the next palette draw. It exists for the scrollback: the
   * palette frame is nearly viewport-tall, so redrawing it the instant a command finishes would scroll
   * that command's own output away before the user has read a line of it.
   */
  describe('the afterRun pause', () => {
    it('runs once per pick, after the footer write and before the palette is drawn again', async () => {
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
        afterRun: async (ctx: PauseContext) => {
          log.push('afterRun')
          ctx.armed()

          return 'palette' as const
        },
      })

      // The whole transcript block is on screen before the user is asked to read it, and the palette
      // waits behind the pause rather than scrolling that block away.
      expect(log).toEqual(['render', 'header', 'spawn', 'footer', 'afterRun', 'render'])
    })

    /**
     * The context is the loop's, not the implementation's. `armed()` moves the signal phase to `'pause'`,
     * and `quitRequested()` is the signal owner's own flag — an `afterRun` that blocks without arming
     * would run the whole wait under the child's policy, which is an unkillable shell.
     */
    it("hands afterRun a context that flips the signal phase and reports the loop's deferred quit", async () => {
      const log: string[] = []
      const written: string[] = []
      const handlers = new Map<NodeJS.Signals, () => void>()
      const exits: number[] = []
      const raised: NodeJS.Signals[] = []
      const quitFlags: boolean[] = []
      const spawn = ((): EventEmitter => {
        log.push('spawn')
        // An external `kill` while the child owns the tty. DEFERRED in that phase, so the child finishes
        // and its entry commits — which is what leaves a flag for the pause's context to report.
        handlers.get('SIGTERM')?.()

        const child = new EventEmitter()

        queueMicrotask(() => {
          child.emit('exit', 0, null)
        })

        return child
      }) as never

      await runSession(items, {
        renderPalette: pickThenQuit(['vendor-check', null], log),
        ...baseDeps(written, spawn),
        installSignals: true,
        signals: {
          // Monotonic, NOT frozen: a frozen clock reads as "no time has passed", which holds the pnpm
          // relay window permanently open and swallows the SIGTERM this test depends on.
          now: (() => {
            let t = 0

            return () => {
              t += 1_000_000

              return t
            }
          })(),
          register: (signal, handler) => {
            handlers.set(signal, handler)
          },
          unregister: (signal) => {
            handlers.delete(signal)
          },
          exit: (code) => {
            exits.push(code)
          },
          raise: (signal) => {
            raised.push(signal)
          },
          resetTerminal: () => {
            return undefined
          },
        },
        afterRun: async (ctx: PauseContext) => {
          ctx.armed()
          quitFlags.push(ctx.quitRequested())
          // The phase is `'pause'` now — and both of these would do something VISIBLE in either other
          // phase: SIGTSTP raises SIGSTOP during a child, and SIGINT ends the session at the palette.
          // That neither happens is what proves `armed()` actually moved the phase.
          handlers.get('SIGTSTP')?.()
          handlers.get('SIGINT')?.()

          return 'palette' as const
        },
      })

      expect(quitFlags).toEqual([true])
      expect(raised).toEqual([])
      expect(exits).toEqual([])
      // The deferred SIGTERM is honoured at the top of the next iteration, so the palette never redraws.
      expect(log).toEqual(['render', 'spawn'])
    })

    it('ends the session when afterRun returns quit, without drawing the palette again', async () => {
      const log: string[] = []
      const written: string[] = []
      const spawn = fakeSpawnFor([{ code: 0, writeReport: true }], log)

      await runSession(items, {
        // A second pick is queued and must never be consumed.
        renderPalette: pickThenQuit(['vendor-check', 'vendor-check', null], log),
        ...baseDeps(written, spawn),
        afterRun: async (ctx: PauseContext) => {
          log.push('afterRun')
          ctx.armed()

          return 'quit' as const
        },
      })

      expect(log).toEqual(['render', 'spawn', 'afterRun'])
      expect(written).toHaveLength(2) // the finished command's header and footer, and nothing after
    })

    it('skips the pause when the pick resolves to no command — nothing ran, so nothing needs reading', async () => {
      const log: string[] = []
      const written: string[] = []
      const spawn = fakeSpawnFor([{ code: 0, writeReport: true }], log)

      await runSession(items, {
        renderPalette: pickThenQuit(['not-in-the-catalog', null], log),
        ...baseDeps(written, spawn),
        afterRun: async (ctx: PauseContext) => {
          log.push('afterRun')
          ctx.armed()

          return 'palette' as const
        },
      })

      expect(log).toEqual(['render', 'render'])
      expect(written).toHaveLength(0)
    })
  })

  /**
   * The signal seam's own terminal reset emits DECSC/DECSTBM/DECRC, `\r`, SGR, cursor-show and autowrap —
   * and NO line erase. So the post-run pause's single hint row would survive a signal exit, and the user's
   * shell prompt would draw at column 0 with the hint's tail still to its right. The fix is one erase in
   * the `signals.resetTerminal` closure, scoped to the pause phase.
   *
   * SCOPED, because `\u001B[2K` is erase-in-LINE: it clears one row, and a stranded palette frame is
   * multi-row by construction, so an unconditional erase would blank one row of six and leave the rest —
   * worse than the clean stranded frame that path tolerates today. And it must never reach the post-child
   * reset, which would wipe the child's last line of output.
   *
   * These tests drive the REAL default `signals` object, because injecting one replaces the very closure
   * under test. `process.on`/`off`/`exit` are spied so the handler can be captured and fired without
   * killing the test runner; non-signal events fall through to the real emitter.
   */
  describe('the signal path erases the pause hint, and nothing else', () => {
    /** Carriage return + EL (erase-in-line), spelled explicitly so no raw control byte lands in source. */
    const ERASE = '\r\u001B[2K'

    const withCapturedSignals = async (
      body: (handlers: Map<NodeJS.Signals, () => void>, exits: number[]) => Promise<void>,
    ): Promise<void> => {
      const handlers = new Map<NodeJS.Signals, () => void>()
      const exits: number[] = []
      const realOn = process.on.bind(process)
      const realOff = process.off.bind(process)
      const capture = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => void) => {
        if (!event.startsWith('SIG')) return realOn(event as 'exit', handler)

        handlers.set(event as NodeJS.Signals, handler)

        return process
      }) as never)
      const release = vi.spyOn(process, 'off').mockImplementation(((event: string, handler: () => void) => {
        if (!event.startsWith('SIG')) return realOff(event as 'exit', handler)

        handlers.delete(event as NodeJS.Signals)

        return process
      }) as never)
      const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
        exits.push(code)
      }) as never)

      try {
        await body(handlers, exits)
      } finally {
        capture.mockRestore()
        release.mockRestore()
        exit.mockRestore()
      }
    }

    it('writes no erase when a signal ends the session from the palette', async () => {
      await withCapturedSignals(async (handlers, exits) => {
        const log: string[] = []
        const written: string[] = []
        const resets: { entersAltScreen?: boolean }[] = []

        await runSession(items, {
          ...baseDeps(written, fakeSpawnFor([{ code: 0, writeReport: true }], log), resets),
          installSignals: true,
          renderPalette: async () => {
            log.push('render')
            // An external `kill` landing while the palette owns the screen. Its multi-row Ink frame is
            // exactly what a one-row erase must not touch.
            handlers.get('SIGTERM')?.()

            return null
          },
        })

        expect(exits).toEqual([0])
        // The reset itself still runs — this path skips Ink's teardown entirely.
        expect(resets).toEqual([{ entersAltScreen: false }])
        expect(written.join('')).not.toContain(ERASE)
      })
    })

    it("leaves the post-child reset alone, so a child's last output line survives", async () => {
      await withCapturedSignals(async (handlers, exits) => {
        const log: string[] = []
        const written: string[] = []
        const resets: { entersAltScreen?: boolean }[] = []
        const spawn = ((): EventEmitter => {
          log.push('spawn')
          // An external `kill` while the child holds the tty. DEFERRED in this phase — which is what pins
          // the phase: from `'palette'` or `'pause'` the very same signal exits immediately instead, so a
          // wrong phase here shows up as an extra reset and an `exit(0)` below.
          handlers.get('SIGTERM')?.()

          const child = new EventEmitter()

          queueMicrotask(() => {
            child.emit('exit', 0, null)
          })

          return child
        }) as never

        await runSession(items, {
          ...baseDeps(written, spawn, resets),
          installSignals: true,
          renderPalette: pickThenQuit(['vendor-check', null], log),
        })

        expect(exits).toEqual([])
        // Exactly one reset, the post-child hygiene one — and it carries no erase, which would have
        // wiped whatever line the child exited on.
        expect(resets).toEqual([{ entersAltScreen: undefined }])
        expect(written.join('')).not.toContain(ERASE)
        // The child finished and its footer committed; then the deferred kill was honoured, so the
        // palette is never drawn a second time.
        expect(log).toEqual(['render', 'spawn'])
        expect(written).toHaveLength(2)
      })
    })

    /**
     * The case the erase exists for. A `kill` at the pause finds a single hint row on screen with the
     * cursor parked at its end; without the erase the user's shell prompt draws at column 0 with that
     * hint's tail still to its right. It must land BEFORE the reset, whose escapes carry no line erase
     * of their own.
     */
    it('erases the hint row before the reset when a signal ends the session from the pause', async () => {
      await withCapturedSignals(async (handlers, exits) => {
        const log: string[] = []
        const written: string[] = []
        const order: string[] = []

        await runSession(items, {
          ...baseDeps(written, fakeSpawnFor([{ code: 0, writeReport: true }], log)),
          installSignals: true,
          renderPalette: pickThenQuit(['vendor-check', null], log),
          write: (text: string) => {
            written.push(text)

            if (text === ERASE) order.push('erase')
          },
          resetTerminal: () => {
            order.push('reset')
          },
          afterRun: async (ctx: PauseContext) => {
            ctx.armed()
            // A genuine external `kill` at the pause, with NO preceding SIGINT — so the pnpm-relay test
            // fails and the handler must end the session here and now, rather than defer to a keypress
            // that a `kill` cannot supply.
            handlers.get('SIGTERM')?.()

            return 'quit' as const
          },
        })

        expect(exits).toEqual([0])
        // The first `reset` is the post-child hygiene one, which carries no erase. The second is the
        // signal path's, and the erase precedes it.
        expect(order).toEqual(['reset', 'erase', 'reset'])
      })
    })
  })

  /**
   * Force-quitting a child means MASHING Ctrl-C, so SIGINTs keep landing after the one that killed it —
   * during the terminal reset, the report read and the footer. The session used to hand Ctrl-C back the
   * instant the child's `exit` fired, so those trailing signals took the "no child running" branch and
   * `exit(0)`-ed the WHOLE SHELL. Expected: return to the palette.
   *
   * `resetTerminal` runs inside precisely that window, so firing SIGINT from it reproduces the race
   * deterministically — no timing, no PTY.
   */
  describe('a SIGINT arriving after the child exits but before the palette is re-armed', () => {
    it('returns to the palette instead of killing the session shell', async () => {
      const log: string[] = []
      const exits: number[] = []
      const handlers = new Map<NodeJS.Signals, () => void>()

      await runSession(items, {
        renderPalette: pickThenQuit(['vendor-check', null], log),
        resolveCommand: resolveVendorCheck,
        cliPath: '/dist/cli.js',
        spawn: fakeSpawnFor([{ code: 130, signal: 'SIGINT' }], log) as never,
        now: () => {
          return 0
        },
        write: () => {
          return undefined
        },
        env: { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
        ascii: true,
        // This test builds its deps inline rather than from `baseDeps`, so it needs its own explicit
        // stub for the same reason: the real default would read the worker's ambient stdin.
        afterRun: async (ctx: PauseContext) => {
          ctx.armed()

          return 'palette' as const
        },
        signals: {
          // Monotonic, NOT frozen: this seam gates the pnpm-relay window, and a frozen clock reads as
          // "no time has passed", holding the window open so every SIGTERM is swallowed. A loop test
          // that fired SIGTERM against a frozen clock would pass while asserting the original bug.
          now: (() => {
            let t = 0

            return () => {
              t += 1_000_000

              return t
            }
          })(),
          register: (signal, handler) => {
            handlers.set(signal, handler)
          },
          unregister: (signal) => {
            handlers.delete(signal)
          },
          exit: (code) => {
            exits.push(code)
          },
          raise: () => {
            return undefined
          },
          resetTerminal: () => {
            // Signal-free test: the palette's terminal is nobody's here.
            return undefined
          },
        },
        resetTerminal: () => {
          // The trailing Ctrl-C of a user still hammering the key at the child they just killed.
          log.push('late-sigint')
          handlers.get('SIGINT')?.()
        },
      })

      expect(exits).toEqual([])
      // The second `render` is the proof: the loop survived and drew the palette again.
      expect(log).toEqual(['render', 'spawn', 'late-sigint', 'render'])
    })
  })
})
