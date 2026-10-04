import process from 'node:process'
import { describe, expect, it } from 'vitest'

import { spawnForwardingSignals } from '../spawn-forwarding-signals'

const SIGTERM_EXIT = 128 + 15

describe('spawnForwardingSignals', () => {
  it('resolves the child exit code', async () => {
    await expect(spawnForwardingSignals(process.execPath, ['-e', 'process.exit(3)'], {})).resolves.toBe(3)
  })

  it('forwards a SIGTERM sent to this process and resolves 128 + signo, listeners removed', async () => {
    const before = process.listenerCount('SIGTERM')
    const running = spawnForwardingSignals(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {})

    // Let the child start before the signal reaches it.
    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })
    process.emit('SIGTERM', 'SIGTERM')

    await expect(running).resolves.toBe(SIGTERM_EXIT)
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})
