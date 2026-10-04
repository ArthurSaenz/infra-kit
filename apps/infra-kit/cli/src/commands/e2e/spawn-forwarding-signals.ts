import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import os from 'node:os'
import process from 'node:process'

/**
 * Spawn a child and resolve its exit code, `128 + signo` when a signal ended it. Stopping this process
 * alone (a background task's stop, a supervisor's SIGTERM) must reach the child, so Playwright stops the
 * dev server it started instead of orphaning both. A terminal's Ctrl-C already reaches the child through
 * the foreground process group, and a second SIGINT makes Playwright skip that shutdown.
 */
export const spawnForwardingSignals = (command: string, args: string[], options: SpawnOptions): Promise<number> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    const forwarded: NodeJS.Signals[] = process.stdin.isTTY ? ['SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP']
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal)
    }
    const stopForwarding = () => {
      for (const signal of forwarded) process.off(signal, forward)
    }

    for (const signal of forwarded) process.on(signal, forward)

    child.once('error', (error) => {
      stopForwarding()
      reject(error)
    })
    child.once('close', (code, signal) => {
      stopForwarding()
      resolve(code ?? (signal ? 128 + os.constants.signals[signal] : 1))
    })
  })
}
