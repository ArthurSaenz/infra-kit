import { describe, expect, it } from 'vitest'

import { suspendForeground } from '../suspend'

/**
 * The process half of the palette's Ctrl-Z. These assert the SIGNAL POLICY — which pid, which signal,
 * and what happens when the kill fails — not the terminal state; that only a real pty can show (see
 * scripts/qa/suspend-pty.sh).
 */

/** Record every `kill` the call makes. */
const spy = (opts: { platform: NodeJS.Platform; throws?: boolean }) => {
  const kills: Array<{ pid: number; signal: NodeJS.Signals }> = []

  suspendForeground({
    platform: opts.platform,
    kill: (pid, signal) => {
      kills.push({ pid, signal })

      if (opts.throws) {
        throw new Error('EPERM')
      }
    },
  })

  return { kills }
}

describe('suspendForeground', () => {
  it('stops the whole PROCESS GROUP (pid 0), not just this process', () => {
    const { kills } = spy({ platform: 'darwin' })

    // pid 0 is the contract, not an optimisation: under `pnpm exec infra-kit` the shell waits on
    // pnpm, so a self-stop (process.pid) leaves pnpm in waitpid and wedges the terminal.
    expect(kills).toEqual([{ pid: 0, signal: 'SIGSTOP' }])
  })

  it('is a no-op on win32 — SIGSTOP does not exist there and process.kill would THROW', () => {
    const { kills } = spy({ platform: 'win32' })

    // A throw here would reach Ink's ErrorBoundary → handleExit(error) → the session would silently
    // quit, turning Ctrl-Z into "lose my shell".
    expect(kills).toEqual([])
  })

  it('swallows a failing kill instead of taking the session down mid terminal-restore', () => {
    expect(() => {
      return spy({ platform: 'darwin', throws: true })
    }).not.toThrow()
  })
})
