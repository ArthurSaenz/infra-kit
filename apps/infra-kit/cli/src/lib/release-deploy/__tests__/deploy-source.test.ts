import { afterEach, describe, expect, it } from 'vitest'

import { agentMode } from 'src/lib/agent-mode'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { jsonOutput } from 'src/lib/json-output'

import { DEPLOY_SOURCES, assertFlagsMatchSource, parseDeploySource } from '../deploy-source'

afterEach(() => {
  agentMode.source = null
  jsonOutput.enabled = false
})

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

  // The non-form picker's agent shape: the flag is named, and there are NO `choices` — `--from` is
  // a two-value enum the remediation already spells, not a form.
  it.each([
    { source: 'flag' as const, json: false },
    { source: null, json: true },
  ])(
    'source $source / --json $json: a missing --from is argument_required naming `from`, without choices',
    ({ source, json }) => {
      agentMode.source = source
      jsonOutput.enabled = json

      let thrown: unknown

      try {
        parseDeploySource(undefined)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(StructuredRefusalError)
      expect((thrown as StructuredRefusalError).structuredContent).toEqual({
        status: 'argument_required',
        argument: 'from',
        agentMode: source,
      })
      expect((thrown as StructuredRefusalError).message).toContain('pass --from with one of: ci, local')
    },
  )

  it('a bad --from value stays a plain OperationError even for an agent — it is not a missing argument', () => {
    agentMode.source = 'flag'

    expect(() => {
      return parseDeploySource('github')
    }).toThrow(/unknown --from value "github"/)
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
