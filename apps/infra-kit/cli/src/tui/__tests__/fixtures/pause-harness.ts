import { spawn } from 'node:child_process'
import process from 'node:process'

import { runCommandPalette } from 'src/tui/boot'

/**
 * Test fixture for `stdin-pause-pty.test.ts`. Runs the REAL `runCommandPalette` — hence the real
 * `renderToStderr`, the real Ink mount/teardown and the real `process.stdin.pause()` call site — and
 * then hands the terminal to a `stdio: 'inherit'` child exactly as `lib/session/run-session.ts` does.
 *
 * Whether the child then receives a keystroke IS the bug under test: without the pause, this parent's
 * handle is still armed and the kernel gives the byte to whichever reader gets there first.
 *
 * Bundled by the test with the real `buildOptions`, so it exercises the shipped chunk layout rather
 * than a `src`-only approximation.
 */

const childPath = process.argv[2]

if (!childPath) throw new Error('pause-harness: expected the child bundle path as argv[2]')

// Count the `'pause'` event at the real call site. This is the call-site half of the fence: it goes to
// zero if `renderToStderr` is ever restructured so its exit promise settles inside a microtask drain,
// which would silently disarm the fix. See stdin-pause-semantics.test.ts for that mechanism.
let pauseEvents = 0

process.stdin.on('pause', () => {
  pauseEvents += 1
})

// One item, so the first Enter selects it — a REAL keypress, so Ink's teardown is driven by the I/O
// callback it is driven by in production, not by a programmatic `onSelect`.
await runCommandPalette([{ name: 'alpha-command', description: 'the only row', group: 'Fixture' }])

process.stderr.write(`\nPAUSE_EVENTS:${pauseEvents}\n`)

const child = spawn(process.execPath, [childPath], { stdio: 'inherit' })

await new Promise<void>((resolve) => {
  child.on('exit', () => {
    resolve()
  })
})

process.stderr.write('\nHARNESS_DONE\n')
process.exit(0)
