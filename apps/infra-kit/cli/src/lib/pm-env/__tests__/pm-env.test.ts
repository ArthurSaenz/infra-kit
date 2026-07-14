import { describe, expect, it } from 'vitest'

import { packageManagerInstallEnv, withoutPackageManagerEnv } from 'src/lib/pm-env'

describe('packageManagerInstallEnv', () => {
  it('keeps npm_config_prefix — the npm matcher’s only signal — while still stripping the dlx markers', () => {
    // The regression: the blunt `npm_*` filter erased the very prefix `detectInstallManager` matched on, so
    // the CLI detected a global install at /usr/local and then installed into npm's DEFAULT prefix. Silent:
    // exit 0, `installed` reported, the version on PATH never moves, cycle repeats every 24h forever.
    const env = packageManagerInstallEnv({
      npm_config_prefix: '/usr/local',
      npm_command: 'exec',
      npm_lifecycle_event: 'dev',
      PNPM_SCRIPT_SRC_DIR: '/repo',
      PATH: '/usr/bin',
    })

    expect(env).toStrictEqual({ npm_config_prefix: '/usr/local', PATH: '/usr/bin' })
  })

  it('keeps npm_config_registry in BOTH cases — npm matches /^npm_config_/i, our filter did not', () => {
    // POSIX process.env is case-sensitive and `startsWith('npm_')` is too, so the uppercase form (what
    // Dockerfiles and CI images export) survived while the lowercase one was dropped — pointing the check
    // and the install at opposite registries.
    expect(packageManagerInstallEnv({ npm_config_registry: 'https://lower.example' })).toStrictEqual({
      npm_config_registry: 'https://lower.example',
    })
    expect(packageManagerInstallEnv({ NPM_CONFIG_REGISTRY: 'https://upper.example' })).toStrictEqual({
      NPM_CONFIG_REGISTRY: 'https://upper.example',
    })
  })

  it('does not preserve npm config that is neither prefix nor registry', () => {
    expect(packageManagerInstallEnv({ npm_config_cache: '/c', PATH: '/usr/bin' })).toStrictEqual({
      PATH: '/usr/bin',
    })
  })

  it('does not mutate the input env', () => {
    const env = { npm_config_prefix: '/usr/local', npm_command: 'exec' }

    packageManagerInstallEnv(env)

    expect(env).toStrictEqual({ npm_config_prefix: '/usr/local', npm_command: 'exec' })
  })
})

describe('withoutPackageManagerEnv', () => {
  it('strips every npm_* key so a child does not mistake `pnpm exec` for `pnpm dlx`', () => {
    const sanitised = withoutPackageManagerEnv({
      npm_command: 'exec',
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_lifecycle_event: 'dev',
      PATH: '/usr/bin',
      HOME: '/Users/dev',
    })

    expect(sanitised).toStrictEqual({ PATH: '/usr/bin', HOME: '/Users/dev' })
  })

  it('also strips PNPM_SCRIPT_SRC_DIR — dropping npm_lifecycle_event alone would ARM the dlx guard', () => {
    // isPnpmDlx = !!PNPM_SCRIPT_SRC_DIR && !npm_lifecycle_event. A script-style launch sets BOTH, and the
    // lifecycle event is what keeps the guard asleep. Strip only the `npm_*` block and we remove the
    // suppressor while leaving the trigger — turning a working invocation into an abort.
    const sanitised = withoutPackageManagerEnv({
      npm_lifecycle_event: 'dev',
      PNPM_SCRIPT_SRC_DIR: '/repo',
      PATH: '/usr/bin',
    })

    expect(sanitised).toStrictEqual({ PATH: '/usr/bin' })
  })

  it('leaves unrelated keys untouched', () => {
    const env = { PATH: '/usr/bin', HOME: '/Users/dev' }

    expect(withoutPackageManagerEnv(env)).toStrictEqual(env)
  })

  it('does not mutate the input env', () => {
    const env = { npm_command: 'exec', PNPM_SCRIPT_SRC_DIR: '/repo', PATH: '/usr/bin' }

    withoutPackageManagerEnv(env)
    expect(env).toStrictEqual({ npm_command: 'exec', PNPM_SCRIPT_SRC_DIR: '/repo', PATH: '/usr/bin' })
  })
})
