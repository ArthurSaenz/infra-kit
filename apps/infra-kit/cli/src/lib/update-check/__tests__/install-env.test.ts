import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installChildEnv, sessionEnvLoadVarNames } from '../install-env'

describe('installChildEnv', () => {
  it('strips the names env-load put in the shell, and keeps what an install needs', () => {
    const env = {
      PATH: '/bin',
      HOME: '/Users/me',
      HTTPS_PROXY: 'proxy.corp:3128',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      NPM_TOKEN: 'registry-token',
      API_KEY: 'secret',
      STRIPE_SECRET: 'secret',
    }

    expect(installChildEnv(env, ['API_KEY', 'STRIPE_SECRET'])).toEqual({
      PATH: '/bin',
      HOME: '/Users/me',
      HTTPS_PROXY: 'proxy.corp:3128',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      NPM_TOKEN: 'registry-token',
    })
  })

  it('strips the Doppler credentials and the loader markers even with no session file', () => {
    const env = { PATH: '/bin', DOPPLER_TOKEN: 'dp.st.x', INFRA_KIT_ENV: 'dev', INFRA_KIT_ENV_PROJECT: 'api' }

    expect(installChildEnv(env, [])).toEqual({ PATH: '/bin' })
  })

  it('never strips PATH or HOME, even when a project keeps a secret under that name', () => {
    expect(installChildEnv({ PATH: '/bin', HOME: '/h' }, ['PATH', 'HOME'])).toEqual({ PATH: '/bin', HOME: '/h' })
  })

  it('keeps the prefix and registry the package manager was detected with, and drops the npx markers', () => {
    const env = { npm_command: 'exec', npm_config_prefix: '/p', npm_config_registry: 'https://mirror/' }

    expect(installChildEnv(env, [])).toEqual({ npm_config_prefix: '/p', npm_config_registry: 'https://mirror/' })
  })
})

describe('sessionEnvLoadVarNames', () => {
  let cacheHome: string

  beforeEach(() => {
    cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-install-env-'))
    vi.stubEnv('XDG_CACHE_HOME', cacheHome)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(cacheHome, { recursive: true, force: true })
  })

  it('reads the names from the session file of the shell that started the worker', () => {
    const sessionDir = path.join(cacheHome, 'infra-kit', 'abcd1234')

    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, 'env-load.sh'), "set -a\nAPI_KEY='x'\nDB_URL='y'\nset +a\n")

    expect(sessionEnvLoadVarNames({ INFRA_KIT_SESSION: 'abcd1234' })).toEqual(['API_KEY', 'DB_URL'])
  })

  it.each([{}, { INFRA_KIT_SESSION: '' }, { INFRA_KIT_SESSION: 'no-such-session' }])(
    'returns no names for %o',
    (env) => {
      expect(sessionEnvLoadVarNames(env)).toEqual([])
    },
  )
})
