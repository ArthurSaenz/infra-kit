import { describe, expect, it } from 'vitest'

import { extractVersionBranches } from '../load-existing-versions'

const lsRemoteLine = (ref: string): string => {
  return `0000000000000000000000000000000000000000\trefs/heads/${ref}`
}

describe('extractVersionBranches', () => {
  it('keeps only semver version branches and returns no-v tokens', () => {
    const stdout = [lsRemoteLine('release/v1.62.0'), lsRemoteLine('release/v1.64.5'), ''].join('\n')

    expect(extractVersionBranches(stdout)).toEqual(['1.62.0', '1.64.5'])
  })

  it('ignores named release/<name> branches (irrelevant to next-bump math)', () => {
    const stdout = [
      lsRemoteLine('release/v1.0.0'),
      lsRemoteLine('release/checkout-redesign'),
      lsRemoteLine('release/zeta-feature'),
    ].join('\n')

    expect(extractVersionBranches(stdout)).toEqual(['1.0.0'])
  })

  it('ignores junk and non-release lines without throwing', () => {
    const stdout = [
      lsRemoteLine('release/Bad_Name'),
      lsRemoteLine('release/v2.3.4'),
      'malformed-line-without-tab',
      lsRemoteLine('feature/login'),
      '',
    ].join('\n')

    expect(extractVersionBranches(stdout)).toEqual(['2.3.4'])
  })
})
