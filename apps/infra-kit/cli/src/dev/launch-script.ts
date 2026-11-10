import { exec } from 'node:child_process'
import util from 'node:util'

import type { LogFn } from './runner-types.js'

const execFn = util.promisify(exec)

export const launchScript = async (script: string, logFn?: LogFn): Promise<void> => {
  try {
    // 32 MB (parity with the dep-closure dry-runner) instead of exec's 1 MB default: a failing `turbo run
    // build` easily emits >1 MB of tsc diagnostics, which would reject with ERR_CHILD_PROCESS_STDIO_MAXBUFFER
    // and MASK the real compile errors — surfacing a bogus "maxBuffer exceeded" instead of the actual failure.
    const { stderr } = await execFn(script, { maxBuffer: 32 * 1024 * 1024 })

    if (stderr && logFn) logFn(`   (build) ${stderr.trim()}`, 'debug')
    if (stderr && !logFn) console.error('stderr:', stderr)
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }

    if (logFn && (err.stdout || err.stderr)) {
      if (err.stdout) logFn(`   stdout: ${err.stdout.trim()}`, 'error')
      if (err.stderr) logFn(`   stderr: ${err.stderr.trim()}`, 'error')
    }

    throw error
  }
}
