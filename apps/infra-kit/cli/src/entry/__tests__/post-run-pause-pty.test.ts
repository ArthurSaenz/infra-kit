import * as esbuild from 'esbuild'
import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildOptions } from '../../../scripts/build.js'

/**
 * @fileoverview
 *
 * The post-run pause, end to end on a real terminal: after a command finishes, the session shell must
 * STOP — hint on screen, palette not redrawn, process alive — until the user presses a key.
 *
 * WHAT ONLY A PTY CAN SHOW. Every claim here is about handle state or about the order of bytes leaving
 * a live process, and neither is observable in-process. The session shell only engages when all three
 * streams are ttys (`sessionGateEnabled`), the pause only arms raw mode on a tty (`awaitPostRunKey`
 * resolves `'palette'` immediately otherwise), and "is the process paused or is it dead?" is a
 * question the unit tests cannot ask at all: a fake `write` seam records the same strings either way.
 * That distinction is this file's reason to exist — see the liveness assertion below.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CLAIM. It sees a byte STREAM, not a screen. It can prove that
 * an erase sequence follows the hint bytes with nothing between them; it cannot prove the hint is
 * actually gone from the rendered pane, and it cannot see wrapping at all — a wrapped row is two rows
 * on screen and one run of bytes on the wire. Those two properties live in `scripts/qa/post-run-pause-pty.sh`,
 * the manual tmux gate, which captures panes instead. Do not "strengthen" an assertion here into one
 * about the screen; it would be a claim the evidence cannot carry.
 *
 * SUFFIX ASSERTIONS, NEVER OCCURRENCE COUNTS. `Enter run` (the palette's footer hint) is ALREADY in
 * the capture by the time the pause opens, because reaching a pause requires picking from the palette
 * first. And Ink repaints its whole frame on every keystroke and every resize, so the number of times
 * it appears is not a stable property of anything. The palette-does-not-redraw claim is therefore
 * "not present in the bytes captured AFTER the pause opened", which is exactly the regression.
 *
 * INHERITED CONSTRAINTS — all discovered by `entry/__tests__/quit-keys-pty.test.ts`, all load-bearing:
 *   - build with the REAL `buildOptions` INSIDE the package. `dist/` is gitignored and `pnpm run qa`
 *     never produces it, so reading it would test a stale bundle or nothing; and `buildOptions` leaves
 *     dependencies external, so a bundle built under `os.tmpdir()` dies on ERR_MODULE_NOT_FOUND before
 *     drawing a frame — it resolves `pino` & co. by walking up to a `node_modules` that must exist.
 *   - `cat |` in front of `script`. Node's stdio pipes are socketpairs, and `script` runs `tcgetattr`
 *     on its own stdin, which fails on a socket before it spawns anything. `cat` launders the socket
 *     into a real pipe. It also keeps stdin from ever seeing EOF, which would let `script` tear the
 *     child down on its own and turn a hang into a green.
 *   - watch `stdout`, even though the shell writes its chrome to stderr: `script` merges both streams
 *     onto the one pty.
 *   - the `SENTINEL` echo, not the pipeline's exit. `cat` outlives the CLI, so the outer shell's exit
 *     says nothing about ours; `runner.sh` echoes the CLI's status the instant it returns.
 *   - macOS only. This is the BSD `script -q <file> <cmd>` signature; util-linux's differs and is
 *     unverified here. `INFRA_KIT_REQUIRE_PTY=1` turns the skip into a real run, so "skipped" cannot
 *     quietly become "always skipped" — that is what `pnpm run qa:pty` sets.
 *
 * THE CI MARKERS ARE SCRUBBED, and that is not hygiene. Ink resolves `interactive` as
 * `!isInCi && stdout.isTTY`, and `is-in-ci` reads these four variables; with any of them set the
 * palette flips to non-interactive and the program under test is a different program. `INFRA_KIT_SESSION`
 * goes for the same reason `scripts/qa/*-pty.sh` scrub it: it keys per-terminal caches, and a stale one
 * changes what the shell boots.
 *
 * WHY `version` IS THE COMMAND, AND WHY THE FILTER IS `cli version`. The pause needs a command that
 * finishes fast and mutates nothing. Picking one means typing a filter and pressing Enter, and Enter
 * runs the FIRST row that survives the filter — which the palette matches against `name + description`.
 * Typing `version` alone would also match `release deliver` ("Release a new version to production"),
 * which sorts ahead of it, so the harness would deploy to production instead of printing a version
 * string. `cli version` appears in exactly one description in the whole catalog. The run header is
 * asserted before anything else for the same reason: if the filter ever stops being unique, this test
 * says so instead of running whatever was on row one.
 */
const SENTINEL = '__CLI_EXIT__:'

/** The palette's own footer hint. Its presence means a palette frame is on the wire. */
const PALETTE_HINT = 'Enter run'

/** The head of every pause-hint variant — the substring that says "the pause is open". */
const HINT_HEAD = 'any key commands'

/**
 * Every rendering `formatPauseHint` can produce, longest first. Listed rather than imported so this
 * file pins the COPY as a wire fact: a hint that changed shape would fail here, not silently pass.
 * The `plain` pair is unreachable on darwin (it is the win32 no-`SIGSTOP` variant) and the `ascii` pair
 * needs `TERM=dumb`; both are here so the matcher encodes no assumption about which one renders.
 */
const PAUSE_HINTS = [
  'any key commands · Esc / Ctrl-C quit · Ctrl-Z suspend',
  'any key commands - Esc / Ctrl-C quit - Ctrl-Z suspend',
  'any key commands · Esc / Ctrl-C quit',
  'any key commands - Esc / Ctrl-C quit',
]

/** The escape byte, spelled out: a literal one in a source file is invisible and unreviewable. */
const ESC = '\u001B'

/** The pause's erase (`post-run-pause.ts` `ERASE_HINT`): carriage return, then clear the line. */
const ERASE_HINT = `\r${ESC}[2K`

/** Filter text that narrows the palette to `version` and to nothing else (see the header doc). */
const FILTER_QUERY = 'cli version'

/** The echoed header the shell writes before it spawns — the proof that the right row was picked. */
const RUN_HEADER = 'infra-kit version'

/** Ink's `interactive` verdict flips on any of these; `is-in-ci` reads all four. */
const CI_MARKERS = ['CI', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER', 'RUN_ID', 'INFRA_KIT_SESSION']

const POLL_MS = 25
/** One beat of slack: an Ink frame flushes a tick before Ink finishes arming stdin. */
const ARM_BEAT_MS = 250
/** How long the pause is watched with no key sent. Both "no redraw" and "not dead" are claimed over it. */
const QUIET_MS = 1_000
const BOOT_TIMEOUT_MS = 15_000
const PAUSE_TIMEOUT_MS = 15_000
const REDRAW_TIMEOUT_MS = 10_000
const EXIT_TIMEOUT_MS = 10_000

/**
 * `INFRA_KIT_REQUIRE_PTY=1` turns the skip below into a real run, so "skipped" cannot quietly become
 * "always skipped". Set by the `qa:pty` script — the documented gate for the pty suites, since
 * `pnpm run qa` cannot reach them.
 */
const REQUIRE_PTY = process.env.INFRA_KIT_REQUIRE_PTY === '1'
const SUPPORTED = process.platform === 'darwin' || REQUIRE_PTY

let outDir = ''
let runnerPath = ''

beforeAll(async () => {
  // A top-level `beforeAll` runs even when every test below is skipped, and this one costs a full
  // esbuild pass. Nothing to build for a suite that will not run.
  if (!SUPPORTED) return

  const cache = resolve(__dirname, '../../..', 'node_modules', '.cache')

  mkdirSync(cache, { recursive: true })

  outDir = mkdtempSync(join(cache, 'post-run-pause-pty-'))

  await esbuild.build({ ...buildOptions, outdir: outDir })

  runnerPath = join(outDir, 'runner.sh')

  // Paths are baked in here rather than quoted through `sh -c` twice over.
  writeFileSync(runnerPath, `#!/bin/sh\n"${process.execPath}" "${join(outDir, 'cli.js')}"\necho "${SENTINEL}$?"\n`)
}, 90_000)

afterAll(() => {
  if (outDir) rmSync(outDir, { force: true, recursive: true })
})

/** The pipeline's environment: the real one minus the markers that would change the program. */
const childEnv = (): NodeJS.ProcessEnv => {
  const kept = Object.entries(process.env).filter(([name]) => {
    return !CI_MARKERS.includes(name)
  })

  return { ...Object.fromEntries(kept), INFRA_KIT_NO_AUTO_UPDATE: '1' }
}

const delay = (ms: number): Promise<void> => {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms)
  })
}

/**
 * Poll `test` until it holds, or reject with `describeFailure()` — which every caller fills with the
 * whole capture, because a pty failure is unreadable without the bytes that led to it.
 *
 * A re-armed `setTimeout` rather than an interval or a counted loop: the predicate reads a buffer that
 * only grows on I/O, so there is nothing to count and no work to overlap.
 */
const waitUntil = (test: () => boolean, timeoutMs: number, describeFailure: () => string): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  return new Promise((resolveWait, rejectWait) => {
    const tick = () => {
      if (test()) {
        resolveWait()

        return
      }

      if (Date.now() >= deadline) {
        rejectWait(new Error(describeFailure()))

        return
      }

      setTimeout(tick, POLL_MS)
    }

    tick()
  })
}

interface PtySession {
  /** Everything the pty has emitted so far, both streams merged. */
  captured: () => string
  /** Type at the terminal. Bytes go in through `cat`, so they arrive as real terminal input. */
  send: (bytes: string) => void
  waitFor: (needle: string, timeoutMs: number, what: string) => Promise<void>
  /** The CLI's own exit status, from the `runner.sh` echo. */
  waitForExit: (timeoutMs: number) => Promise<number>
  dispose: () => void
}

/** Boot the session shell on a pty and hand back the levers to drive it. */
const startSession = (): PtySession => {
  // `/bin/sh` absolute, not `sh` off PATH: sonarjs/no-os-command-from-path, and correctly so.
  // `detached` gives the pipeline its own process group: a plain `child.kill()` would signal the
  // outer `sh` alone and leave `cat`, `script` and `node` behind.
  const child = spawn('/bin/sh', ['-c', `cat | script -q /dev/null /bin/sh ${runnerPath}`], {
    env: childEnv(),
    detached: true,
  })

  let output = ''

  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })

  const captured = () => {
    return output
  }

  return {
    captured,
    send: (bytes: string) => {
      child.stdin.write(bytes)
    },
    waitFor: (needle: string, timeoutMs: number, what: string) => {
      return waitUntil(
        () => {
          return output.includes(needle)
        },
        timeoutMs,
        () => {
          return `${what} (waited ${timeoutMs}ms for ${JSON.stringify(needle)}):\n${output}`
        },
      )
    },
    waitForExit: async (timeoutMs: number) => {
      const done = () => {
        return new RegExp(`${SENTINEL}(\\d+)`).exec(output)
      }

      await waitUntil(
        () => {
          return done() !== null
        },
        timeoutMs,
        () => {
          return `the CLI never exited (waited ${timeoutMs}ms for the sentinel):\n${output}`
        },
      )

      return Number(done()?.[1])
    },
    dispose: () => {
      try {
        // Negative pid: the whole group (see `detached`). Throws once the group is already gone, which
        // is the normal case after a clean exit.
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // Already reaped; nothing to clean up.
      }
    },
  }
}

/**
 * Drive a fresh session to an open pause: wait for the palette, filter it down to `version`, run it,
 * and wait for the hint. Returns the capture length at that moment — the MARK every suffix assertion
 * is taken against.
 *
 * The two waits between keystrokes are observations, not sleeps. The first gates on the palette's own
 * footer (plus a beat, since the frame flushes a tick before stdin is armed); the second gates on the
 * typed query appearing in the palette's prompt row, which is what proves the filter has been applied
 * before Enter commits to a row. The 150ms drain at the head of the pause (`PAUSE_DRAIN_MS`) discards
 * keys by design, so nothing is sent until the hint itself is on the wire.
 */
const driveToPause = async (session: PtySession): Promise<number> => {
  await session.waitFor(PALETTE_HINT, BOOT_TIMEOUT_MS, 'the palette never drew')
  await delay(ARM_BEAT_MS)

  session.send(FILTER_QUERY)
  await session.waitFor(FILTER_QUERY, BOOT_TIMEOUT_MS, 'the palette never echoed the filter')

  session.send('\r')
  await session.waitFor(HINT_HEAD, PAUSE_TIMEOUT_MS, 'the pause hint never appeared')

  const captured = session.captured()

  // The filter is only unique until someone writes a description containing "cli version". If that
  // ever happens this fails here, rather than after running whatever sorted first.
  expect(captured, `a command other than \`version\` was picked:\n${captured}`).toContain(RUN_HEADER)

  return captured.length
}

/**
 * Drop SGR (colour/dim) sequences and nothing else: they occupy no cells and carry no ordering
 * information, so what survives is what was actually drawn.
 *
 * Split-and-rejoin rather than a regex because a regex over the escape byte trips `no-control-regex`
 * (and `sonarjs/no-control-regex`), and suppressing both to match one invisible character would be the
 * wrong trade. An escape that is NOT an SGR is put back deliberately: the caller's assertion is
 * "nothing else was written", so a cursor move or a second erase must stay visible to it.
 */
const stripSgr = (text: string): string => {
  return text
    .split(ESC)
    .map((part, index) => {
      if (index === 0) return part

      const stripped = part.replace(/^\[[0-9;]*m/, '')

      return stripped === part ? `${ESC}${part}` : stripped
    })
    .join('')
}

// See "macOS ONLY" above: the BSD and util-linux `script` signatures differ, and the Linux one is
// unverified here. Skipping is the honest option — a guessed invocation would fail CI for a reason
// unrelated to the pause, and "fixing" it blind would be a claim, not a test.
describe.skipIf(!SUPPORTED)('the session shell pauses after a command instead of redrawing the palette', () => {
  it('holds the pause open, then redraws on a key, and erases the hint first', async () => {
    const session = startSession()

    try {
      const mark = await driveToPause(session)

      // (1) + (4), over the same window and deliberately so. Separately, each has a trivial way to
      // pass for the wrong reason: "no palette" is also true of a process that died, and "no exit" is
      // also true of one that redrew and is sitting at the palette. Together they are the property the
      // feature exists for — stopped, alive, waiting.
      await delay(QUIET_MS)

      const quiet = session.captured()

      expect(quiet.slice(mark), `the palette redrew during the pause:\n${quiet}`).not.toContain(PALETTE_HINT)
      expect(quiet, `the process exited instead of pausing:\n${quiet}`).not.toContain(SENTINEL)

      // (2) A key — the most ordinary one — resumes the loop. After a full second of silence this is
      // also the second half of the liveness claim: a dead process cannot answer.
      session.send(' ')
      await waitUntil(
        () => {
          return session.captured().slice(mark).includes(PALETTE_HINT)
        },
        REDRAW_TIMEOUT_MS,
        () => {
          return `the palette never redrew after a key:\n${session.captured()}`
        },
      )

      // (5) The ordering invariant: the hint bytes, then the erase, and nothing at all between them.
      // Anything drawn in that gap would be drawn over a hint the erase then clears — the "dim corpse"
      // failure this design is shaped around. SGR sequences are the one thing allowed through: the
      // hint is written dim, so its own `ESC[22m` reset sits inside the run.
      const final = session.captured()
      const hintAt = final.indexOf(HINT_HEAD)
      const eraseAt = final.indexOf(ERASE_HINT, hintAt)

      expect(eraseAt, `no erase followed the hint:\n${final}`).toBeGreaterThan(hintAt)

      const written = final.slice(hintAt, eraseAt)
      const spelled = stripSgr(written)
      const drawn = `between the hint and its erase: ${JSON.stringify(written)}`

      expect(spelled, `an escape sequence was written ${drawn}`).not.toContain(ESC)
      expect(spelled, `the line was re-drawn ${drawn}`).not.toContain('\r')
      expect(spelled, `a newline was written ${drawn}`).not.toContain('\n')

      // …and what those bytes spell is the hint itself, whole or truncated to the terminal's width —
      // not the hint plus a stray write that happened to contain no control characters.

      expect(
        PAUSE_HINTS.some((hint) => {
          return hint.startsWith(spelled)
        }),
        `the bytes before the erase are not a pause hint: ${JSON.stringify(spelled)}`,
      ).toBe(true)
    } finally {
      session.dispose()
    }
  }, 60_000)

  it('exits 0 when Esc is pressed at the pause', async () => {
    const session = startSession()

    try {
      await driveToPause(session)

      session.send(ESC)

      // The status the CLI itself returned, echoed by `runner.sh` — not the pipeline's, which `cat`
      // outlives. A quit at the pause is a clean end to the session, so it is 0, exactly as a quit at
      // the palette is.
      expect(await session.waitForExit(EXIT_TIMEOUT_MS)).toBe(0)
    } finally {
      session.dispose()
    }
  }, 60_000)
})
