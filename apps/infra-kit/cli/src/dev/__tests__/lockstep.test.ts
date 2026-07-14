import configPackageJson from '@slip-stream-kit/config/package.json' with { type: 'json' }
import { describe, expect, it } from 'vitest'

import { HELPER_PACKAGES, isBelowVersion } from 'src/dev/dev-server'

import cliPackageJson from '../../../package.json' with { type: 'json' }

/**
 * `infra-kit` and `@slip-stream-kit/config` MUST ship as one version line.
 *
 * Three hand-maintained literals encode that promise — the CLI's version, the config package's version,
 * and the floor in {@link HELPER_PACKAGES} — and nothing but this file makes them agree. Both ways of
 * drifting are silent and both are described elsewhere in the code as fatal:
 *
 * - Floor bumped past the published config version → EVERY consumer's `infra-kit dev` hard-refuses.
 * - Wire contract changed without bumping the floor → the guard passes vacuously. It still looks alive,
 *   while an old helper quietly proxies plain HTTP into portless's TLS listener.
 *
 * A comment in a readme cannot catch either. This can.
 */
const CONFIG_PACKAGE = '@slip-stream-kit/config'

const configFloor = HELPER_PACKAGES.find((helper) => {
  return helper.name === CONFIG_PACKAGE
})?.floor

describe('infra-kit / @slip-stream-kit/config lockstep', () => {
  it('ships both packages on the same version', () => {
    expect(
      configPackageJson.version,
      `${CONFIG_PACKAGE} and infra-kit must release in lockstep. Independent version lines make the floor in HELPER_PACKAGES incomparable: seeded low it throws for every consumer, seeded high it passes vacuously and the guard is dead while still looking alive.`,
    ).toBe(cliPackageJson.version)
  })

  it('keeps the floor at or below the version actually shipped', () => {
    expect(configFloor, `no floor registered for ${CONFIG_PACKAGE}`).toBeDefined()
    expect(
      isBelowVersion(configPackageJson.version, configFloor ?? '0.0.0'),
      `the floor (${configFloor}) is ABOVE the ${CONFIG_PACKAGE} version being shipped (${configPackageJson.version}), so every consumer that installs this release would be refused at startup by the very guard meant to protect them`,
    ).toBe(false)
  })
})
