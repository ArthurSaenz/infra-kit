import { describe, expect, it } from 'vitest'

import { withoutPackageManagerEnv } from 'src/lib/pm-env'

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
