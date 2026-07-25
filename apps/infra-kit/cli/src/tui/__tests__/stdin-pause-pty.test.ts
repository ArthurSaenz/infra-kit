import * as esbuild from 'esbuild'
import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildOptions } from '../../../scripts/build.js'

/**
 * The consequence half of the `process.stdin.pause()` fence (tui/boot.tsx). `stdin-pause-semantics`
 * pins the node CONTRACT and runs everywhere; this pins what the contract BUYS — that after the
 * palette tears down, a `stdio: 'inherit'` child is the only reader of the tty — and it needs a real
 * terminal, so it is darwin-only.
 *
 * THE BUG: `runSession` spawns each picked command with `stdio: 'inherit'`, so parent and child hold
 * the SAME tty. Ink's teardown drops its `readable` listener and `unref()`s but never pauses, leaving
 * the parent's handle armed — and the kernel gives each keystroke to exactly one reader. Measured
 * before the fix, interleaved A/B against the real CLI: a lone Esc reached the child in 6/16 runs.
 *
 * WHY A REAL KEYPRESS AND NOT A PROGRAMMATIC SELECT — the fix depends on Ink resolving `waitUntilExit`
 * from an I/O callback, which is what puts `renderToStderr`'s `finally` in a macrotask continuation
 * where the nextTick queue (and with it `updateReadableListening`) has already drained. Forcing
 * `onSelect` by hand would resolve from a different context and could satisfy this test while
 * bypassing the very ordering the fix relies on.
 *
 * IT ALSO CARRIES THE CALL-SITE ASSERTION (`PAUSE_EVENTS`). That is deliberate: the "is the call site
 * still behind an await, resumed from I/O" invariant is only observable where there is a real tty and
 * the real Ink teardown, so it cannot live in the cross-platform file.
 *
 * INHERITED CONSTRAINTS, all load-bearing — see `entry/__tests__/quit-keys-pty.test.ts`, which
 * discovered them:
 *   - build with the REAL `buildOptions` INSIDE the package; `dist/` is gitignored and `pnpm run qa`
 *     never produces it, and a bundle built under `os.tmpdir()` dies on ERR_MODULE_NOT_FOUND because
 *     dependencies stay external and resolve by walking up to a `node_modules`.
 *   - `cat |` in front of `script`: node's stdio pipes are socketpairs and `script` runs `tcgetattr`
 *     on its own stdin, which fails on a socket. `cat` launders it into a real pipe.
 *   - and here `cat` has a SECOND job: stdin must never see EOF. node's bootstrap `onpause` bails out
 *     when `_handle.reading` is already false, which EOF causes — so an EOF'd harness would report a
 *     green that means nothing.
 *   - macOS only: this is the BSD `script -q <file> <cmd>` signature; util-linux's differs and is
 *     unverified here. Set `INFRA_KIT_REQUIRE_PTY=1` to turn the skip into a failure (see `qa:pty`),
 *     so "skipped" cannot quietly become "always skipped".
 */
const REQUIRE_PTY = process.env.INFRA_KIT_REQUIRE_PTY === '1'
const SUPPORTED = process.platform === 'darwin'

let outDir = ''
let runnerPath = ''

beforeAll(async () => {
  if (!SUPPORTED && !REQUIRE_PTY) return

  const cache = resolve(__dirname, '../../..', 'node_modules', '.cache')

  mkdirSync(cache, { recursive: true })
  outDir = mkdtempSync(join(cache, 'stdin-pause-pty-'))

  // Real options, our entries: the fixtures pull in `src/tui/boot` and therefore the real
  // `renderToStderr`, bundled the way it actually ships (splitting, external deps, jsx runtime).
  await esbuild.build({
    ...buildOptions,
    entryPoints: [resolve(__dirname, 'fixtures/pause-harness.ts'), resolve(__dirname, 'fixtures/pause-child.ts')],
    outdir: outDir,
  })

  runnerPath = join(outDir, 'runner.sh')
  writeFileSync(
    runnerPath,
    `#!/bin/sh\n"${process.execPath}" "${join(outDir, 'pause-harness.js')}" "${join(outDir, 'pause-child.js')}"\n`,
  )
}, 120_000)

afterAll(() => {
  if (outDir) rmSync(outDir, { force: true, recursive: true })
})

interface Outcome {
  /** What the child reported receiving: the JSON of the bytes, or `NOTHING` if the parent ate them. */
  childGot: string
  /** `'pause'` events observed at the real call site — the call-site invariant. */
  pauseEvents: number
  output: string
}

/** Boot the palette on a pty, select with a real Enter, then type into the spawned child. */
const runOnce = async (): Promise<Outcome> => {
  const child = spawn('/bin/sh', ['-c', `cat | script -q /dev/null /bin/sh ${runnerPath}`], {
    env: { ...process.env, INFRA_KIT_NO_AUTO_UPDATE: '1' },
    detached: true,
  })

  let output = ''
  let selected = false
  let typed = false

  return new Promise<Outcome>((resolveOutcome) => {
    const finish = () => {
      clearTimeout(timer)

      try {
        // Negative pid: the whole group. Throws when it is already gone, which is the happy path.
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // Already reaped.
      }

      const got = /CHILD_GOT:(\S+)/.exec(output)
      const pauses = /PAUSE_EVENTS:(\d+)/.exec(output)

      resolveOutcome({
        childGot: got?.[1] ?? 'NO_REPORT',
        pauseEvents: pauses ? Number(pauses[1]) : -1,
        output,
      })
    }

    const timer = setTimeout(finish, 25_000)

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()

      // The palette drew its only row: select it with a REAL Enter, so Ink tears down from I/O.
      if (!selected && output.includes('alpha-command')) {
        selected = true
        setTimeout(() => {
          child.stdin.write('\r')
        }, 250)
      }

      // The child armed its listener. Now — and only now — is a keystroke meaningful.
      if (!typed && output.includes('CHILD_READY')) {
        typed = true
        setTimeout(() => {
          child.stdin.write('AB')
        }, 150)
      }

      if (/CHILD_GOT:/.test(output)) finish()
    })
  })
}

describe.skipIf(!SUPPORTED && !REQUIRE_PTY)('a spawned child owns the tty after the palette tears down', () => {
  it('delivers the keystroke to the child, not the parent', async () => {
    const outcome = await runOnce()

    // The assertion. `NOTHING` is the pre-fix behaviour: the parent's handle was still armed and the
    // kernel handed it the byte instead.
    expect(outcome.childGot, `child did not receive the keystroke:\n${outcome.output}`).toBe('"AB"')
  }, 60_000)

  it('still pauses at the real call site (the awaited-from-I/O invariant)', async () => {
    const outcome = await runOnce()

    // Zero here means `pause()` was reached but emitted nothing — the silent no-op that happens when
    // the call site stops being awaited from an I/O callback. See stdin-pause-semantics.test.ts.
    expect(outcome.pauseEvents, `no pause event at the call site:\n${outcome.output}`).toBe(1)
  }, 60_000)
})
