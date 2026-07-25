import type { Buffer } from 'node:buffer'
import process from 'node:process'

/**
 * The spawned child for `stdin-pause-pty.test.ts`. Stands in for any interactive `infra-kit`
 * subcommand: it arms raw mode (as inquirer and Ink both do) and waits for one keystroke off the
 * INHERITED tty.
 *
 * It reports what it received either way, so the test distinguishes "the child got the byte" from
 * "the parent ate it" rather than distinguishing pass from timeout.
 */

const GIVE_UP_MS = 3_000

if (process.stdin.isTTY) process.stdin.setRawMode(true)

const done = (result: string): never => {
  process.stderr.write(`\nCHILD_GOT:${result}\n`)
  process.exit(0)
}

const timer = setTimeout(() => {
  // The parent stole it. This is the failure the test exists to catch, and it must be a REPORTED
  // outcome rather than a hang, or a red test would be indistinguishable from a broken harness.
  done('NOTHING')
}, GIVE_UP_MS)

process.stdin.on('data', (chunk: Buffer) => {
  clearTimeout(timer)
  done(JSON.stringify(chunk.toString()))
})

// Only once the listener is armed, so the test never sends the keystroke into a window where nobody
// on either side is reading.
process.stderr.write('\nCHILD_READY\n')
