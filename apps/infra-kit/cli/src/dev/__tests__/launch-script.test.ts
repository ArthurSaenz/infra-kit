import process from 'node:process'
import { describe, expect, it } from 'vitest'

import { launchScript } from 'src/dev/dev-server'

/**
 * Regression (B3): the initial build shells out via `exec`, whose default stdout/stderr cap is 1 MB. A
 * failing `turbo run build` easily emits more than that in tsc diagnostics; with the default cap the promise
 * rejects with ERR_CHILD_PROCESS_STDIO_MAXBUFFER and the REAL compile errors are truncated away — the dev
 * session aborts on a bogus "maxBuffer exceeded" instead of showing what actually failed. `launchScript`
 * now passes a 32 MB buffer (parity with the dep-closure dry-runner), so a noisy failure surfaces intact.
 *
 * The child writes ~2 MB to stderr then exits non-zero: under the OLD 1 MB cap this same test would fail
 * with a maxBuffer error, so it is a genuine guard, not a tautology.
 */
describe('launchScript (initial-build exec buffer)', () => {
  it('surfaces the real (>1 MB) build output on failure instead of a maxBuffer error', async () => {
    // fs.writeSync (not stderr.write) so all 2 MB flush to the pipe synchronously BEFORE exit — an async
    // write races process.exit and truncates at the ~64 KB pipe buffer, which would test the harness, not the fix.
    const bomb = "const fs=require('fs'); fs.writeSync(2,'E'.repeat(2000000)); process.exit(1)"
    const script = `${process.execPath} -e "${bomb}"`

    let caught: unknown

    try {
      await launchScript(script)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeDefined()
    const err = caught as { message?: string; stderr?: string }

    // The failure must be the child's own non-zero exit, NOT a truncation artifact.
    expect(err.message ?? '').not.toMatch(/maxBuffer/i)
    // And the real >1 MB output is captured intact rather than cut off at 1 MB.
    expect((err.stderr ?? '').length).toBeGreaterThan(1024 * 1024)
  })
})
