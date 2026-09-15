import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { releaseCreateMcpTool } from 'src/commands/release-create'
import { logger } from 'src/lib/logger'
import { FORM_DEADLINE_MS, buildArgumentForm, narrowsArgs } from 'src/lib/tool-handler/argument-form'
import { canonicalArgs, stripGateKeys } from 'src/lib/tool-handler/confirm-token'
import type { SemVer } from 'src/lib/version-utils'
import { loadExistingVersions } from 'src/lib/version-utils/load-existing-versions'

import { HINT_BUDGET_MS, createReleaseFormProvider } from '../release-form'

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
 * Send the provider's schema through `inputRequired.elicit()` and return the WIRE shape. Asserted
 * here rather than on the zod object because `elicit()` throws on anything it cannot express and
 * `buildArgumentForm` swallows that into the same `null` a form-less client produces.
 */
const render = async (provider = createReleaseFormProvider()): Promise<RenderedSchema> => {
  const form = await buildArgumentForm(provider, {}, FORM_DEADLINE_MS)

  expect(form).not.toBeNull()

  const request = form?.inputRequests?.args as { params?: { requestedSchema?: RenderedSchema } } | undefined

  return request?.params?.requestedSchema ?? {}
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

// R2. The assertion that separates "a form was offered" from "the provider silently broke": every
// other test in this file would pass against a provider whose schema `elicit()` refuses, because the
// refusal is flattened into the same `null` a non-elicitation client produces.
describe("r2 — the form is OFFERED, in the wizard's order", () => {
  it('renders type and release required, description optional, no default anywhere', async () => {
    known(KNOWN)
    silenceInfo()

    const schema = await render()

    expect(Object.keys(schema.properties ?? {})).toStrictEqual(['type', 'release', 'description'])
    expect(schema.required).toStrictEqual(['type', 'release'])
    expect(schema.properties?.type?.enum).toStrictEqual(['regular', 'hotfix'])
    expect(schema.properties?.release?.type).toBe('string')

    for (const field of Object.values(schema.properties ?? {})) {
      expect(field).not.toHaveProperty('default')
    }
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

  it("degrades to the timeout prose within its own budget, not the chokepoint's", async () => {
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

  it('keeps the exported budget strictly inside the chokepoint deadline', () => {
    expect(HINT_BUDGET_MS).toBe(2_500)
    expect(HINT_BUDGET_MS).toBeLessThan(FORM_DEADLINE_MS)
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

/** Every `toArgs` row R7 and R8 replay: the content the human sent, and the merged output owed. */
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

// R7. The fixed point under the WIRE's comparator: round 2 re-parses the merged arguments through
// the tool's inputSchema (whose transform defaults `type` and drops a blank description) and the
// gate compares `canonicalArgs` of the result against what round 1 signed. Any drift here is a
// `mismatch` refusal on every form-fed confirmation.
describe('r7 — every toArgs output is a fixed point of the tool schema', () => {
  const provider = createReleaseFormProvider()
  const inputSchema = z.object(releaseCreateMcpTool.inputSchema)

  it.each(CLASSIFIED)('%j survives the round-2 parse unchanged', (content) => {
    const m = provider.toArgs(content, {})

    expect(m).not.toBeNull()

    const parsed = inputSchema.parse({ ...m, confirm: true })

    expect(canonicalArgs(stripGateKeys(parsed))).toBe(canonicalArgs(m))
  })
})

describe('r8 — the chokepoint accepts the merge', () => {
  const provider = createReleaseFormProvider()

  it.each(CLASSIFIED)('%j does not narrow the empty round 1', (content) => {
    expect(narrowsArgs(stripGateKeys({}), provider.toArgs(content, {}))).toBe(false)
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
