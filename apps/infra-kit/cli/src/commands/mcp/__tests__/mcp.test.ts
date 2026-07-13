import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runMcp } from '../mcp'

class FakeChild extends EventEmitter {
  kill = vi.fn()
}

const harness = () => {
  const child = new FakeChild()
  const spawnFake = vi.fn(() => {
    return child
  })
  const exit = vi.fn()

  return { child, spawnFake, exit, spawn: spawnFake as unknown as typeof spawn }
}

afterEach(() => {
  process.removeAllListeners('SIGINT')
  process.removeAllListeners('SIGTERM')
})

describe('runMcp', () => {
  it('names a spawn failure and exits, rather than dying on an unhandled error event', () => {
    const { child, spawn, exit } = harness()
    const onError = vi.fn()

    runMcp({ spawn, exit, onError, env: {} })
    child.emit('error', new Error('EACCES'))

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('spawns the sibling mcp.js with the current node and a sanitized env', () => {
    const { spawnFake, spawn, exit } = harness()

    runMcp({ spawn, exit, env: { npm_command: 'exec', PNPM_SCRIPT_SRC_DIR: '/x', HOME: '/home/me' } })

    const [cmd, args, options] = spawnFake.mock.calls[0] as unknown as [string, string[], Record<string, unknown>]

    expect(cmd).toBe(process.execPath)
    expect(args[0]).toMatch(/mcp\.js$/)
    expect(options.stdio).toBe('inherit')

    const env = options.env as NodeJS.ProcessEnv

    expect(
      Object.keys(env).some((key) => {
        return key.startsWith('npm_')
      }),
    ).toBe(false)
    expect(env.PNPM_SCRIPT_SRC_DIR).toBeUndefined()
    expect(env.HOME).toBe('/home/me')
  })

  it('forwards the child exit code', () => {
    const { child, spawn, exit } = harness()

    runMcp({ spawn, exit, env: {} })
    child.emit('exit', 3, null)

    expect(exit).toHaveBeenCalledWith(3)
  })

  it('exits 1 when the child dies on a signal', () => {
    const { child, spawn, exit } = harness()

    runMcp({ spawn, exit, env: {} })
    child.emit('exit', null, 'SIGTERM')

    expect(exit).toHaveBeenCalledWith(1)
  })

  it('forwards SIGINT to the child', () => {
    const { child, spawn, exit } = harness()

    runMcp({ spawn, exit, env: {} })
    process.emit('SIGINT')

    expect(child.kill).toHaveBeenCalledWith('SIGINT')
  })
})
