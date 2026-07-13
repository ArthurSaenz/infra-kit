import { describe, expect, it } from 'vitest'

import { isNewerVersion, parseSemver } from '../semver'

describe('parseSemver', () => {
  it('parses a bare release', () => {
    expect(parseSemver('0.1.130')).toEqual({ release: [0, 1, 130], prerelease: [] })
  })

  it('parses a prerelease and drops build metadata', () => {
    expect(parseSemver('1.0.0-rc.1+sha.abc')).toEqual({ release: [1, 0, 0], prerelease: ['rc', '1'] })
  })

  it('keeps a hyphen inside a single prerelease identifier', () => {
    expect(parseSemver('1.0.0-rc-1')).toEqual({ release: [1, 0, 0], prerelease: ['rc-1'] })
  })

  // The four-segment case is assembled rather than written literally: as a string literal it looks like a
  // hardcoded IP address and trips sonarjs/no-hardcoded-ip.
  const fourSegments = ['1', '0', '0', '0'].join('.')

  it.each(['v1.0.0', '1.0', fourSegments, '', 'latest', 'not.a.version'])('returns null for %o', (input) => {
    expect(parseSemver(input)).toBeNull()
  })

  it('never produces NaN, the failure mode of version-utils.parseVersion on bare versions', () => {
    // `version-utils.parseVersion('0.1.130')` does `.slice(1)` => [NaN, 1, 130]. This must not.
    expect(parseSemver('0.1.130')?.release.some(Number.isNaN)).toBe(false)
  })
})

describe('isNewerVersion', () => {
  it('compares patch numerically, not lexically', () => {
    // The load-bearing case: string compare puts '0.1.9' after '0.1.130' and pins users forever.
    expect(isNewerVersion('0.1.130', '0.1.9')).toBe(true)
    expect(isNewerVersion('0.1.9', '0.1.130')).toBe(false)
  })

  it.each([
    ['1.0.0', '0.9.9', true],
    ['0.2.0', '0.1.999', true],
    ['1.0.0', '1.0.0', false],
    ['0.9.9', '1.0.0', false],
  ] as const)('isNewerVersion(%s, %s) === %s', (latest, current, expected) => {
    expect(isNewerVersion(latest, current)).toBe(expected)
  })

  it('ranks a final release above its own prereleases', () => {
    expect(isNewerVersion('1.0.0', '1.0.0-rc.1')).toBe(true)
    expect(isNewerVersion('1.0.0-rc.1', '1.0.0')).toBe(false)
  })

  it('orders prerelease identifiers per semver precedence', () => {
    expect(isNewerVersion('1.0.0-rc.2', '1.0.0-rc.1')).toBe(true)
    expect(isNewerVersion('1.0.0-rc.10', '1.0.0-rc.9')).toBe(true)
    expect(isNewerVersion('1.0.0-rc.1', '1.0.0-rc')).toBe(true)
    expect(isNewerVersion('1.0.0-beta', '1.0.0-alpha')).toBe(true)
  })

  it('ignores build metadata', () => {
    expect(isNewerVersion('1.0.0+b', '1.0.0+a')).toBe(false)
  })

  it.each([
    ['garbage', '0.1.0'],
    ['0.1.0', 'garbage'],
    ['', ''],
  ])('never reports an update when input is unparsable (%o, %o)', (latest, current) => {
    // A garbled registry body must read as "no update", never as "install NaN".
    expect(isNewerVersion(latest, current)).toBe(false)
  })
})
