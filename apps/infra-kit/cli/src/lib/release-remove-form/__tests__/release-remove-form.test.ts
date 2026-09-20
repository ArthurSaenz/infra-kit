import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { releaseRemoveMcpTool } from 'src/commands/release-remove'
import { NO_OPEN_RELEASE_PRS_OPERATION, getReleasePRsWithInfo } from 'src/integrations/gh'
import type { ReleasePRInfo } from 'src/integrations/gh'
import { OperationError } from 'src/lib/errors/operation-error'
import { logger } from 'src/lib/logger'
import { getJiraDescriptions } from 'src/lib/release-utils'

import { createReleaseRemoveFormProvider } from '../release-remove-form'

vi.mock('src/integrations/gh', async (importOriginal) => {
  return { ...(await importOriginal<object>()), getReleasePRsWithInfo: vi.fn() }
})

// Spread over the real module: `parseBranchChoices` and `detectReleaseType` stay real, so the rows
// are derived the way the CLI picker derives them; only the Jira read is stubbed.
vi.mock('src/lib/release-utils', async (importOriginal) => {
  return { ...(await importOriginal<object>()), getJiraDescriptions: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

const REGULAR: ReleasePRInfo = {
  branch: 'release/v1.2.5',
  number: 1,
  title: 'Release v1.2.5',
  createdAt: '2026-01-01T00:00:00Z',
  baseRefName: 'dev',
  type: 'regular',
  titleMismatch: false,
  dualBase: false,
}
const HOTFIX: ReleasePRInfo = {
  branch: 'release/v1.2.6',
  number: 2,
  title: 'Hotfix v1.2.6',
  createdAt: '2026-01-02T00:00:00Z',
  baseRefName: 'main',
  type: 'hotfix',
  titleMismatch: false,
  dualBase: false,
}
const JUNK: ReleasePRInfo = {
  branch: 'release/Bad_Name',
  number: 3,
  title: 'Release Bad_Name',
  createdAt: '2026-01-03T00:00:00Z',
  baseRefName: 'dev',
  type: 'regular',
  titleMismatch: false,
  dualBase: false,
}
const DESCRIPTION = 'Checkout redesign, phase one'

const LABELS = ['1.2.5', '1.2.6']

const EMPTY_LINE = 'Tool execution form options empty (open release PRs): release-remove'
const FAILED_LINE = 'Tool execution form enumeration failed (gh pr list): release-remove'
const timedOutLine = (budgetMs: number): string => {
  return `Tool execution form enumeration timed out (gh pr list, ${budgetMs / 1000} s): release-remove`
}

const prs = (list: ReleasePRInfo[]): void => {
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue(list)
}

const descriptions = (entries: [string, string][] = [['v1.2.5', DESCRIPTION]]): void => {
  vi.mocked(getJiraDescriptions).mockResolvedValue(new Map(entries))
}

const never = <T>(): Promise<T> => {
  return new Promise<T>(() => {})
}

const infoLines = (): string[] => {
  return vi.mocked(logger.info).mock.calls.map(([entry]) => {
    return (entry as { msg: string }).msg
  })
}

interface RenderedField {
  type?: string
  description?: string
  enum?: string[]
}

interface RenderedSchema {
  properties?: Record<string, RenderedField>
  required?: string[]
}

/**
 * Render the provider's schema the way `refuseMissingArguments` ships it in `choices`: JSON Schema,
 * asserted here rather than on the zod object because that is the shape a skill actually reads.
 */
const render = async (provider = createReleaseRemoveFormProvider()): Promise<RenderedSchema> => {
  const schema = await provider.buildRequestedSchema({})

  expect(schema).not.toBeNull()

  return schema === null ? {} : (z.toJSONSchema(schema) as RenderedSchema)
}

/** The provider's own answer, raced so a missing deadline fails as an assertion instead of hanging. */
const schemaWithin = async (
  provider: ReturnType<typeof createReleaseRemoveFormProvider>,
): Promise<z.ZodObject<z.ZodRawShape> | null> => {
  let guardTimer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<'OUTRAN_THE_TEST'>((resolve) => {
    guardTimer = setTimeout(() => {
      resolve('OUTRAN_THE_TEST')
    }, 200)
  })
  const raced = await Promise.race([provider.buildRequestedSchema({}), guard])

  clearTimeout(guardTimer)
  expect(raced).not.toBe('OUTRAN_THE_TEST')

  return raced as z.ZodObject<z.ZodRawShape> | null
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('f1 — isFormable', () => {
  it.each([
    [{}, true],
    [{ version: undefined }, true],
    [{ version: '' }, true],
    [{ moveIssuesTo: 'x' }, true],
    [{ version: '1.2.5' }, false],
    [{ version: '1.2.5', moveIssuesTo: 'x' }, false],
    [undefined, false],
    ['x', false],
    [[], false],
  ])('%j → %s', (params, expected) => {
    expect(createReleaseRemoveFormProvider().isFormable(params)).toBe(expected)
  })
})

// f2. The assertion that separates "a form was offered" from "the provider silently broke": a
// provider returning `null` reads as "nothing to offer" and the refusal ships without `choices`.
describe('f2 — the form is OFFERED, as the CLI picker would draw it', () => {
  it('renders version as a required enum of the open release labels, with type and description rows', async () => {
    prs([REGULAR, HOTFIX])
    descriptions()

    const schema = await render()

    expect(Object.keys(schema.properties ?? {})).toStrictEqual(['version'])
    expect(schema.required).toStrictEqual(['version'])
    expect(schema.properties?.version?.enum).toStrictEqual(LABELS)

    const prose = schema.properties?.version?.description ?? ''

    expect(prose).toContain(`1.2.5 [regular] — ${DESCRIPTION}`)
    expect(prose).toContain('1.2.6 [hotfix]')
    expect(prose).not.toContain('1.2.6 [hotfix] —')
    expect(prose).toContain('removes the Jira fix version')
    expect(infoLines()).toStrictEqual([])
  })
})

// A helper-level pin: `getReleasePRsWithInfo` already filters unparseable refs, so this guards the
// provider's choice of label helper, not its input.
describe('f3 — labels come through the release-id parser', () => {
  it('drops a head ref that does not parse as a release', async () => {
    prs([REGULAR, JUNK])
    descriptions([])

    expect((await render()).properties?.version?.enum).toStrictEqual(['1.2.5'])
  })
})

describe('f4 — gh answered with nothing open', () => {
  it('answers null with the options-empty line on an empty list', async () => {
    prs([])
    descriptions([])

    expect(await createReleaseRemoveFormProvider().buildRequestedSchema({})).toBeNull()
    expect(infoLines()).toStrictEqual([EMPTY_LINE])
  })

  // What the real `getReleasePRsWithInfo` does on an empty repo: it THROWS, with this operation.
  it('reads the discovery refusal for "none open" as empty, not as a failure', async () => {
    vi.mocked(getReleasePRsWithInfo).mockRejectedValue(
      new OperationError(undefined, { operation: NO_OPEN_RELEASE_PRS_OPERATION }),
    )
    descriptions([])

    expect(await createReleaseRemoveFormProvider().buildRequestedSchema({})).toBeNull()
    expect(infoLines()).toStrictEqual([EMPTY_LINE])
  })
})

describe('f5 — the enumeration rejected', () => {
  it('answers null with the enumeration-failed line, and not the options-empty line', async () => {
    vi.mocked(getReleasePRsWithInfo).mockRejectedValue(
      new OperationError(new Error('gh: not logged in'), { operation: 'fetch release PRs' }),
    )
    descriptions([])

    expect(await createReleaseRemoveFormProvider().buildRequestedSchema({})).toBeNull()
    expect(infoLines()).toStrictEqual([FAILED_LINE])
  })
})

describe('f6 — the descriptions outran their budget', () => {
  it('still offers the form, says so in the prose, and logs the descriptions line', async () => {
    prs([REGULAR, HOTFIX])
    vi.mocked(getJiraDescriptions).mockReturnValue(never())

    const provider = createReleaseRemoveFormProvider({ fetchBudgetMs: 5 })

    expect(await schemaWithin(provider)).not.toBeNull()

    const prose = (await render(provider)).properties?.version?.description ?? ''

    expect(prose).toContain('could not be fetched within 0.005 s')
    expect(prose).toContain('1.2.5 [regular]')
    expect(infoLines()).toContain('Tool execution form descriptions unavailable (timeout): release-remove')
  })
})

// f7. The merged output is what the re-run hands the handler, so it must parse under the tool's own
// inputSchema and come out unchanged.
describe('f7 — every toArgs output is a fixed point of the tool schema', () => {
  const provider = createReleaseRemoveFormProvider()
  const inputSchema = z.object(releaseRemoveMcpTool.inputSchema)

  it.each(LABELS)('{ version: %j } parses under the tool inputSchema unchanged', (label) => {
    const merged = provider.toArgs({ version: label }, {})

    expect(merged).toStrictEqual({ version: label })
    expect(inputSchema.parse(merged)).toStrictEqual(merged)
  })
})

describe('f8 — merge over round 1', () => {
  const provider = createReleaseRemoveFormProvider()

  it('keeps the round-1 keys and adds version', () => {
    expect(provider.toArgs({ version: '1.2.5' }, { confirm: false })).toStrictEqual({
      confirm: false,
      version: '1.2.5',
    })
  })

  it('keeps a round-1 moveIssuesTo next to the picked version', () => {
    expect(provider.toArgs({ version: '1.2.5' }, { moveIssuesTo: 'v1.2.6' })).toStrictEqual({
      moveIssuesTo: 'v1.2.6',
      version: '1.2.5',
    })
  })

  it('replaces a blank round-1 version', () => {
    expect(provider.toArgs({ version: '1.2.5' }, { version: '' })).toStrictEqual({ version: '1.2.5' })
  })

  it('accepts non-record round-1 params', () => {
    expect(provider.toArgs({ version: '1.2.5' }, undefined)).toStrictEqual({ version: '1.2.5' })
    expect(provider.toArgs({ version: '1.2.5' }, 'garbage')).toStrictEqual({ version: '1.2.5' })
  })

  it.each([[{ version: 42 }], [{ version: undefined }], [{}]])('returns null for %j — the only null', (content) => {
    expect(provider.toArgs(content, {})).toBeNull()
  })
})

// The static imports above enter through `src/commands/release-remove` FIRST, so a back-import from
// the provider into that module would resolve benignly here and the fileoverview's TDZ claim would go
// unchecked. A fresh registry entered through the provider is the only order that fires it.
describe('f10 — the provider can be entered before the command module', () => {
  it('evaluates on its own, with no importer having loaded release-remove first', async () => {
    vi.resetModules()

    await expect(import('../release-remove-form')).resolves.toHaveProperty('createReleaseRemoveFormProvider')
  })
})

describe('f11 — the enumeration outran its budget', () => {
  it('answers null with the timed-out line, and neither of the other two', async () => {
    vi.mocked(getReleasePRsWithInfo).mockReturnValue(never())
    descriptions([])

    const provider = createReleaseRemoveFormProvider({ fetchBudgetMs: 5 })

    expect(await schemaWithin(provider)).toBeNull()
    expect(infoLines()).toStrictEqual([timedOutLine(5)])
  })
})
