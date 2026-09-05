import { describe, expect, it } from 'vitest'

import { DEPLOY_SOURCES, assertFlagsMatchSource, parseDeploySource } from '../deploy-source'

describe('parseDeploySource', () => {
  it('refuses a missing --from rather than assuming one', () => {
    // The load-bearing assertion of the whole merge: no default, ever. If this test is ever relaxed,
    // the command silently regains the ambiguity that `--from` was introduced to remove.
    expect(() => {
      return parseDeploySource(undefined)
    }).toThrow(/--from is required/)
  })

  it('refuses a value that is neither runner', () => {
    expect(() => {
      return parseDeploySource('github')
    }).toThrow(/unknown --from value "github"/)
  })

  it.each(DEPLOY_SOURCES)('accepts %s', (source) => {
    expect(parseDeploySource(source)).toBe(source)
  })
})

describe('assertFlagsMatchSource', () => {
  it('refuses a local-only flag under --from ci', () => {
    expect(() => {
      return assertFlagsMatchSource('ci', { '--dry-run': true })
    }).toThrow(/--dry-run is not valid with --from ci/)
  })

  it('refuses a ci-only flag under --from local', () => {
    expect(() => {
      return assertFlagsMatchSource('local', { '--skip-terraform': true })
    }).toThrow(/--skip-terraform is not valid with --from local/)
  })

  it('refuses --version under --from local', () => {
    expect(() => {
      return assertFlagsMatchSource('local', { '--version': '1.2.5' })
    }).toThrow(/--version is not valid with --from local/)
  })

  it('names every offender at once instead of only the first', () => {
    expect(() => {
      return assertFlagsMatchSource('ci', { '--dry-run': true, '--print-env': true })
    }).toThrow(/--dry-run, --print-env are not valid/)
  })

  it('treats a false boolean as absent', () => {
    expect(() => {
      return assertFlagsMatchSource('local', { '--skip-terraform': false })
    }).not.toThrow()
  })

  it('allows each runner its own flags', () => {
    expect(() => {
      return assertFlagsMatchSource('ci', { '--version': '1.2.5', '--skip-terraform': true })
    }).not.toThrow()

    expect(() => {
      return assertFlagsMatchSource('local', { '--dry-run': true, '--print-env': true })
    }).not.toThrow()
  })
})
