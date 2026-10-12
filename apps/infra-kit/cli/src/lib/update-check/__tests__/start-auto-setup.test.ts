import { describe, expect, it, vi } from 'vitest'

import { AUTO_SETUP_ARGV, startAutoSetup } from '../start-auto-setup'

describe('startAutoSetup', () => {
  it('spawns `infra-kit setup --auto --json` with only the allowlisted env', () => {
    const spawnDetached = vi.fn()

    startAutoSetup({
      env: {
        PATH: '/bin',
        npm_command: 'exec',
        CLAUDECODE: '1',
        INFRA_KIT_AGENT: '1',
        INFRA_KIT_SESSION: 'abcd1234',
        DOPPLER_TOKEN: 'secret',
        GIT_DIR: '/other/.git',
        HOME: '/Users/me',
      },
      spawnDetached,
    })

    expect(spawnDetached).toHaveBeenCalledWith('infra-kit', AUTO_SETUP_ARGV, { PATH: '/bin', HOME: '/Users/me' })
    expect(AUTO_SETUP_ARGV).toEqual(['setup', '--auto', '--json'])
  })

  it('never throws when the spawn does', () => {
    expect(() => {
      startAutoSetup({
        env: {},
        spawnDetached: () => {
          throw new Error('EAGAIN')
        },
      })
    }).not.toThrow()
  })
})
