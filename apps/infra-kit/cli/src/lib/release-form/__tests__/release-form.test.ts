import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { releaseCreateMcpTool } from 'src/commands/release-create'
import { logger } from 'src/lib/logger'
import { InvalidReleaseDateError } from 'src/lib/release-date'
import { formatReleaseSpec, parseReleaseSpec } from 'src/lib/version-utils'
import type { ReleaseInput, SemVer } from 'src/lib/version-utils'
import { loadExistingVersions } from 'src/lib/version-utils/load-existing-versions'

import { createReleaseFormProvider } from '../release-form'

vi.mock('src/lib/version-utils/load-existing-versions', async (importOriginal) => {
  return { ...(await importOriginal<object>()), loadExistingVersions: vi.fn() }
})

const KNOWN: SemVer[] = [[1, 63, 2]]

const known = (versions: SemVer[]): void => {
  vi.mocked(loadExistingVersions).mockResolvedValue(versions)
}

const silenceInfo = (): ReturnType<typeof vi.spyOn> => {
  return vi.spyOn(logger, 'info').mockImplementation(() => {})
}

interface RenderedField {
  type?: string
  description?: string
  enum?: string[]
  default?: unknown
}

interface RenderedSchema {
  properties?: Record<string, RenderedField>
  required?: string[]
}

/**
 * Render the provider's schema the way `refuseMissingArguments` ships it in `choices`: JSON Schema,
 * asserted here rather than on the zod object because that is the shape a skill actually reads.
 */
const render = async (provider = createReleaseFormProvider()): Promise<RenderedSchema> => {
  const schema = await provider.buildRequestedSchema({})

  expect(schema).not.toBeNull()

  return schema === null ? {} : (z.toJSONSchema(schema) as RenderedSchema)
}

const releaseDescription = async (provider?: ReturnType<typeof createReleaseFormProvider>): Promise<string> => {
  return (await render(provider)).properties?.release?.description ?? ''
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('r1 — isFormable', () => {
  it.each([
    [{}, true],
    [{ releases: undefined }, true],
    [{ releases: [] }, true],
    [{ releases: [{ version: 'next' }] }, false],
    [{ releases: [{ version: '1.2.3' }, { version: 'next' }, { name: 'x' }] }, false],
    [undefined, false],
    ['x', false],
    [[], false],
  ])('%j → %s', (params, expected) => {
    expect(createReleaseFormProvider().isFormable(params)).toBe(expected)
  })
})

// R2. The assertion that separates "a form was offered" from "the provider silently broke": a
// provider returning `null` reads as "nothing to offer" and the refusal ships without `choices`.
describe("r2 — the form is OFFERED, in the wizard's order", () => {
  it('renders type and release required, description and releaseDate optional, no default anywhere', async () => {
    known(KNOWN)
    silenceInfo()

    const schema = await render()

    expect(Object.keys(schema.properties ?? {})).toStrictEqual(['type', 'release', 'description', 'releaseDate'])
    expect(schema.required).toStrictEqual(['type', 'release'])
    expect(schema.properties?.type?.enum).toStrictEqual(['regular', 'hotfix'])
    expect(schema.properties?.release?.type).toBe('string')

    for (const field of Object.values(schema.properties ?? {})) {
      expect(field).not.toHaveProperty('default')
    }
  })

  // The prose is the agent's only instruction for where the date goes on the re-run, and the only
  // thing that stops `1.64.0@2026-10-28` being typed into `release` (where round 2 would refuse it
  // as "not kebab-case").
  it('tells the agent the date rides in -r as <token>@yyyy-mm-dd and keeps @ out of release', async () => {
    known(KNOWN)

    const schema = await render()

    expect(schema.properties?.releaseDate?.type).toBe('string')
    expect(schema.properties?.releaseDate?.description).toContain('yyyy-mm-dd')
    expect(schema.properties?.releaseDate?.description).toContain(
      'On the re-run it is passed as <token>@yyyy-mm-dd inside -r',
    )
    expect(schema.properties?.release?.description).toContain('no "@" here')
  })
})

describe('r3 — the [next] hint', () => {
  it('names both computed numbers when prior versions are known', async () => {
    known(KNOWN)

    expect(await releaseDescription()).toContain('1.64.0 for a regular release or 1.63.3 for a hotfix')
  })

  it('says "next" will be refused when nothing is known', async () => {
    known([])
    silenceInfo()

    expect(await releaseDescription()).toContain('will be REFUSED')
  })

  it('degrades to the timeout prose within its own budget', async () => {
    vi.mocked(loadExistingVersions).mockReturnValue(new Promise(() => {}))
    silenceInfo()

    const provider = createReleaseFormProvider({ hintBudgetMs: 5 })

    let guardTimer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<string>((resolve) => {
      guardTimer = setTimeout(() => {
        resolve('OUTRAN_THE_TEST')
      }, 200)
    })
    // Raced in the TEST too, so a missing deadline wrapper fails as an assertion rather than hanging
    // until the runner's own timeout — which reads as infrastructure flake, not as a defect.
    const raced = await Promise.race([provider.buildRequestedSchema({}), guard])

    clearTimeout(guardTimer)
    expect(raced).not.toBe('OUTRAN_THE_TEST')
    expect(raced).not.toBeNull()

    expect(await releaseDescription(provider)).toContain('could not be computed')
  })
})

describe('r4 — observability', () => {
  it('logs the timeout line when the hint outruns its budget', async () => {
    vi.mocked(loadExistingVersions).mockReturnValue(new Promise(() => {}))
    const info = silenceInfo()

    await render(createReleaseFormProvider({ hintBudgetMs: 5 }))

    expect(info).toHaveBeenCalledWith({ msg: 'Tool execution form hint unavailable (timeout): release-create' })
  })

  it('logs the no-prior-versions line when nothing is known', async () => {
    known([])
    const info = silenceInfo()

    await render()

    expect(info).toHaveBeenCalledWith({
      msg: 'Tool execution form hint unavailable (no prior versions): release-create',
    })
  })

  it('logs nothing on the happy branch', async () => {
    known(KNOWN)
    const info = silenceInfo()

    await render()

    expect(info).not.toHaveBeenCalled()
  })
})

/** Every `toArgs` row R7 replays: the content the human sent, and the merged output owed. */
const CLASSIFIED: [Record<string, unknown>, Record<string, unknown>][] = [
  [{ type: 'regular', release: '1.63.3' }, { releases: [{ version: '1.63.3', type: 'regular' }] }],
  [{ type: 'regular', release: 'v1.63.3' }, { releases: [{ version: 'v1.63.3', type: 'regular' }] }],
  [{ type: 'regular', release: 'next' }, { releases: [{ version: 'next', type: 'regular' }] }],
  [{ type: 'regular', release: ' NEXT ' }, { releases: [{ version: 'NEXT', type: 'regular' }] }],
  [{ type: 'regular', release: 'checkout-redesign' }, { releases: [{ name: 'checkout-redesign', type: 'regular' }] }],
  [{ type: 'regular', release: 'Checkout Redesign' }, { releases: [{ name: 'Checkout Redesign', type: 'regular' }] }],
  [{ type: 'regular', release: 'dev' }, { releases: [{ name: 'dev', type: 'regular' }] }],
  [{ type: 'regular', release: '1.2' }, { releases: [{ name: '1.2', type: 'regular' }] }],
  [{ type: 'hotfix', release: 'next' }, { releases: [{ version: 'next', type: 'hotfix' }] }],
  // `type` absent pins `toArgs`'s TOTALITY only — the wire requires it, so this is not a wire case.
  [{ release: 'next' }, { releases: [{ version: 'next', type: 'regular' }] }],
  [
    { type: 'regular', release: 'next', description: '  x ' },
    { releases: [{ version: 'next', type: 'regular', description: 'x' }] },
  ],
  [{ type: 'regular', release: 'next', description: '' }, { releases: [{ version: 'next', type: 'regular' }] }],
  [
    { type: 'regular', release: '1.64.0', releaseDate: ' 2026-10-28 ' },
    { releases: [{ version: '1.64.0', type: 'regular', releaseDate: '2026-10-28' }] },
  ],
  // Blank → key ABSENT, not `releaseDate: undefined`: the gate compares round-1 and round-2 objects.
  [{ type: 'regular', release: '1.64.0', releaseDate: '' }, { releases: [{ version: '1.64.0', type: 'regular' }] }],
  [{ type: 'regular', release: '1.64.0', releaseDate: '   ' }, { releases: [{ version: '1.64.0', type: 'regular' }] }],
]

describe('r5 — toArgs classifies through the one shared classifier', () => {
  const provider = createReleaseFormProvider()

  it.each(CLASSIFIED)('%j → %j', (content, expected) => {
    expect(provider.toArgs(content, {})).toStrictEqual(expected)
  })

  it.each([
    [{ type: 'regular', release: '' }],
    [{ type: 'regular', release: '   ' }],
    [{ type: 'regular', release: 42 }],
    [{ type: 'regular' }],
  ])('returns null for %j — the only null', (content) => {
    expect(provider.toArgs(content, {})).toBeNull()
  })
})

// The form does not validate the date (no measured wire shape on form fields, and nothing parses
// `inputSchema` at runtime). The real refusal is the re-run: the agent passes `-r <token>@<date>`,
// and `parseReleaseSpec` names the date.
describe('r5b — an invalid date passes the form and is refused on the re-run by name', () => {
  it('lets 2026-02-30 through toArgs, then parseReleaseSpec throws InvalidReleaseDateError naming it', () => {
    const merged = createReleaseFormProvider().toArgs(
      { type: 'regular', release: '1.64.0', releaseDate: '2026-02-30' },
      {},
    )

    expect(merged).toStrictEqual({ releases: [{ version: '1.64.0', type: 'regular', releaseDate: '2026-02-30' }] })

    const [entry] = (merged as { releases: ReleaseInput[] }).releases
    const spec = formatReleaseSpec({
      id: { kind: 'version', semver: { major: 1, minor: 64, patch: 0 }, raw: '1.64.0' },
      type: 'regular',
      releaseDate: entry!.releaseDate!,
    })

    expect(spec).toBe('1.64.0@2026-02-30')
    expect(() => {
      return parseReleaseSpec(spec)
    }).toThrow(InvalidReleaseDateError)
    expect(() => {
      return parseReleaseSpec(spec)
    }).toThrow('Release date "2026-02-30" is not a calendar date in yyyy-mm-dd form.')
  })
})

describe('r6 — merge over round 1', () => {
  const provider = createReleaseFormProvider()

  it('keeps the round-1 keys and adds releases', () => {
    expect(provider.toArgs({ type: 'regular', release: 'next' }, { confirm: true })).toStrictEqual({
      confirm: true,
      releases: [{ version: 'next', type: 'regular' }],
    })
  })

  it('accepts non-record round-1 params', () => {
    expect(provider.toArgs({ type: 'regular', release: 'next' }, undefined)).toStrictEqual({
      releases: [{ version: 'next', type: 'regular' }],
    })
    expect(provider.toArgs({ type: 'regular', release: 'next' }, 'garbage')).toStrictEqual({
      releases: [{ version: 'next', type: 'regular' }],
    })
  })
})

// R7. The merged output is what the re-run hands the handler, so it must parse under the tool's own
// inputSchema (whose transform defaults `type` and drops a blank description).
describe('r7 — every toArgs output is a valid release-create call', () => {
  const provider = createReleaseFormProvider()
  const inputSchema = z.object(releaseCreateMcpTool.inputSchema)

  it.each(CLASSIFIED)('%j parses under the tool inputSchema', (content) => {
    const merged = provider.toArgs(content, {})

    expect(merged).not.toBeNull()
    expect(inputSchema.safeParse(merged).success).toBe(true)
  })
})

describe('r9 — a failed enumeration', () => {
  it('still yields a schema with the timeout prose when loadExistingVersions rejects', async () => {
    vi.mocked(loadExistingVersions).mockRejectedValue(new Error('no remote'))
    silenceInfo()

    const schema = await createReleaseFormProvider().buildRequestedSchema({})

    expect(schema).not.toBeNull()
    expect(await releaseDescription()).toContain('could not be computed')
  })
})

// The static imports above enter through `src/commands/release-create` FIRST, so a back-import from
// the provider into that module would resolve benignly here and the fileoverview's TDZ claim would go
// unchecked. A fresh registry entered through the provider is the only order that fires it.
describe('r10 — the provider can be entered before the command module', () => {
  it('evaluates on its own, with no importer having loaded release-create first', async () => {
    vi.resetModules()

    await expect(import('../release-form')).resolves.toHaveProperty('createReleaseFormProvider')
  })
})
