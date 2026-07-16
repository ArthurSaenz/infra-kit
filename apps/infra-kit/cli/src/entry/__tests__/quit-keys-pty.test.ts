import * as esbuild from 'esbuild'
import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildOptions } from '../../../scripts/build.js'

/**
 * A quit key at the palette must END THE PROCESS. This is a regression test in the literal
 * sense: before the stdin-ownership fix, `infra-kit` on a real terminal tore the palette
 * down on Ctrl-C — correctly, frame erased, cursor restored — and then hung forever,
 * because `renderToStderr` re-ref'd `process.stdin` on its way out, and a ref'd tty
 * ReadStream holds the event loop open with nothing listening to it.
 *
 * WHY A PTY — the bug lives entirely in real handle state. The session shell only engages
 * when stdin/stdout/stderr are ALL ttys (`sessionGateEnabled`), Ink only arms raw mode on
 * a tty, and "did node exit?" is not observable in-process. A non-tty run takes the
 * one-shot inquirer path and proves nothing. There is no node-pty here; `script` is the pty.
 *
 * WHY WE BUILD, AND WHERE — `dist/` is gitignored and `pnpm run qa` never produces it, so
 * reading it would test a stale bundle or nothing at all. We build fresh with the REAL
 * options (as dist-shebang.test.ts does) but INSIDE the package: `buildOptions` leaves
 * dependencies external, so the bundle only resolves `pino` & co. by walking up to a
 * `node_modules` that exists above it. Built into `os.tmpdir()` it dies on
 * ERR_MODULE_NOT_FOUND before drawing a frame.
 *
 * THE `cat` SHIM IS LOAD-BEARING — node's stdio pipes are socketpairs, and `script` runs
 * `tcgetattr` on its own stdin, which fails on a socket ("Operation not supported on
 * socket") before it ever spawns the child. `cat` launders the socket into a real pipe,
 * which `script` accepts. Ink draws to stderr, but `script` merges both streams onto the
 * pty, so watching `stdout` here is right even though it looks wrong.
 *
 * WE WATCH FOR A SENTINEL, NOT THE PIPELINE'S EXIT — `cat` outlives the CLI (its stdin
 * stays open), so the shell's own exit says nothing about ours. `runner.sh` echoes the
 * CLI's status the instant it returns, which is precisely the event under test. Closing
 * stdin to make `cat` exit would be worse than useless: `script` would see EOF and could
 * tear the child down itself, turning a hang into a green test.
 *
 * macOS ONLY, DELIBERATELY — this is the BSD `script` signature (`script -q <file> <cmd>`).
 * util-linux's is documented as `script [options] [file]`, one operand, so it SHOULD reject
 * the extra ones before spawning anything and fail CI (ubuntu-24.04-arm) for a reason that
 * has nothing to do with the palette. That "should" is honest: it was not verified here, and
 * neither was the Linux spelling, `script -qec "<cmd>" /dev/null`. Enabling a branch on an
 * unverified assertion about terminal behaviour is the exact species of claim that authored
 * the bug above; refusing to run is the conservative direction of the same uncertainty.
 *
 * THE COST, SAID OUT LOUD — CI therefore NEVER runs this test, so a contributor on Linux can
 * break the palette and see green. The unit tests around it (tui/__tests__/boot.test.tsx,
 * lib/prompts/__tests__/stdin-ref.test.ts) still pin the ref-ownership invariant everywhere;
 * what is lost on Linux is only the end-to-end proof that the process actually dies. Verify
 * `script -qec` on a real ubuntu-24.04-arm box and delete this whole paragraph.
 *
 * RAW MODE, AND THE LIMIT OF THIS TEST — Ink arms raw mode as it mounts, clearing termios
 * ISIG, so `0x03` reaches the palette as a BYTE it handles itself. Sent BEFORE that, it is
 * a real SIGINT, which `installSessionSignals` answers with `resetTerminal(); exit(0)` —
 * process gone, test GREEN, bug untouched. We gate on the footer hint plus a beat, which is
 * a heuristic, not an observation: the frame flushes a tick before stdin finishes arming.
 * The Ctrl-D case carries the rigour — `0x04` raises no signal, so in cooked mode it could
 * only hang, never false-green. If Ctrl-C ever passes while Ctrl-D fails, suspect the race,
 * not the fix.
 */
const SENTINEL = '__CLI_EXIT__:'

let outDir = ''
let runnerPath = ''

const SUPPORTED = process.platform === 'darwin'

beforeAll(async () => {
  // A top-level `beforeAll` runs even when every test below is skipped, and this one costs a full
  // esbuild pass. Nothing to build for a suite that will not run.
  if (!SUPPORTED) return

  const cache = resolve(__dirname, '../../..', 'node_modules', '.cache')

  mkdirSync(cache, { recursive: true })

  outDir = mkdtempSync(join(cache, 'quit-keys-pty-'))

  await esbuild.build({ ...buildOptions, outdir: outDir })

  runnerPath = join(outDir, 'runner.sh')

  // Paths are baked in here rather than quoted through `sh -c` twice over.
  writeFileSync(runnerPath, `#!/bin/sh\n"${process.execPath}" "${join(outDir, 'cli.js')}"\necho "${SENTINEL}$?"\n`)
}, 90_000)

afterAll(() => {
  if (outDir) rmSync(outDir, { force: true, recursive: true })
})

/**
 * Boot the palette on a pty, send `key` once it is drawn, and resolve to the CLI's exit
 * code — or `null` if it never terminated, which is the hang this test exists for.
 */
const quitWith = async (key: string): Promise<number | null> => {
  // `/bin/sh` absolute, not `sh` off PATH: sonarjs/no-os-command-from-path, and correctly so.
  // `detached` gives the pipeline its own process group: a plain `child.kill()` would signal the
  // outer `sh` alone and leave `cat`, `script` and `node` behind.
  const child = spawn('/bin/sh', ['-c', `cat | script -q /dev/null /bin/sh ${runnerPath}`], {
    env: { ...process.env, INFRA_KIT_NO_AUTO_UPDATE: '1' },
    detached: true,
  })

  let output = ''
  let armed = false

  return new Promise<number | null>((resolve_) => {
    const finish = (code: number | null) => {
      clearTimeout(timer)

      try {
        // Negative pid: the whole group (see `detached`). Throws once the group is already gone,
        // which is the normal case on the happy path — the sentinel means the CLI is done.
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // Already reaped; nothing to clean up.
      }

      resolve_(code)
    }

    const timer = setTimeout(() => {
      // `finish` FIRST: an assertion that throws inside a timer callback would skip the kill and
      // the resolve, turning a clean red into a 40s hang plus a stray pipeline.
      finish(null)
      expect(armed, `the palette never drew, so no quit key was ever sent:\n${output}`).toBe(true)
    }, 15_000)

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()

      // The footer hint means the palette mounted, so raw mode is armed.
      if (!armed && output.includes('Enter run')) {
        armed = true
        // One beat of slack: the frame flushes a tick before Ink finishes arming stdin.
        setTimeout(() => {
          child.stdin.write(key)
        }, 250)
      }

      const done = new RegExp(`${SENTINEL}(\\d+)`).exec(output)

      if (done) finish(Number(done[1]))
    })
  })
}

// See "macOS ONLY" above: the BSD and util-linux `script` signatures differ, and the Linux one
// is unverified here. Skipping is the honest option — a guessed invocation would fail CI for a
// reason unrelated to the palette, and "fixing" it blind would be a claim, not a test.
describe.skipIf(!SUPPORTED)('a quit key at the palette ends the process', () => {
  it('exits on Ctrl-C', async () => {
    expect(await quitWith('\x03')).toBe(0)
  }, 40_000)

  it('exits on Ctrl-D', async () => {
    expect(await quitWith('\x04')).toBe(0)
  }, 40_000)
})
