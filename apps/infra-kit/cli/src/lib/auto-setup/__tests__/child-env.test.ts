import { describe, expect, it } from 'vitest'

import { unattendedChildEnv } from '../child-env'

describe('unattendedChildEnv', () => {
  it('keeps what a setup needs to find its tools and home', () => {
    const env = { PATH: '/bin', HOME: '/h', LC_ALL: 'C', XDG_CACHE_HOME: '/c', HOMEBREW_PREFIX: '/opt/homebrew' }

    expect(unattendedChildEnv(env)).toEqual(env)
  })

  it('drops secrets, session ids, git overrides and agent markers', () => {
    expect(
      unattendedChildEnv({
        PATH: '/bin',
        DOPPLER_TOKEN: 'x',
        DATABASE_URL: 'postgres://secret',
        INFRA_KIT_SESSION: 'abcd1234',
        GIT_DIR: '/r/.git',
        GIT_WORK_TREE: '/r',
        CLAUDECODE: '1',
        npm_command: 'exec',
      }),
    ).toEqual({ PATH: '/bin' })
  })
})
