import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { getProjectRoot } from 'src/lib/git-utils'
import type { ArgumentFormProvider } from 'src/types'

import { createDeployFormProvider } from '../deploy-form'

vi.mock('src/lib/git-utils', async (importOriginal) => {
  return { ...(await importOriginal<object>()), getProjectRoot: vi.fn() }
})

vi.mock('src/integrations/gh', async (importOriginal) => {
  return { ...(await importOriginal<object>()), getReleasePRsWithInfo: vi.fn() }
})

// `resolveProtectedEnvAccess` is left REAL and its config read is mocked one layer down, so
// `deployableEnvs` still does the filtering under test. Mocking `workflow-envs` itself would replace
// `isSharedEnv` too, and the env `.describe()` is asserted precisely because it is derived from it.
vi.mock('src/lib/infra-kit-config', async (importOriginal) => {
  return {
    ...(await importOriginal<object>()),
    getInfraKitConfig: vi.fn(() => {
      return Promise.resolve({})
    }),
  }
})

/**
 * Mirrors the consumer repos: `mobile` gated to dev/prod, `docs-fe` to dev plus a personal env,
 * `client-be` ungated, and `skip_terraform_deploy` declared as a boolean that is a FLAG, not a
 * service. The env choices carry `prod` so `deployableEnvs` has something to filter out.
 */
const DEPLOY_SELECTED = `name: deploy selected services
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options:
          - dev
          - arthur
          - stage
          - prod
      mobile:
        type: boolean
      docs-fe:
        type: boolean
      client-be:
        type: boolean
      skip_terraform_deploy:
        type: boolean
jobs:
  deploy-mobile:
    if: \${{ github.event.inputs.environment == 'dev' || github.event.inputs.environment == 'prod' }}
    uses: ./.github/workflows/_deploy-serverless-jobs.yml
    with:
      script_name: mobile
  deploy-docs-fe:
    if: \${{ github.event.inputs.environment == 'dev' || github.event.inputs.environment == 'arthur' }}
    uses: ./.github/workflows/_deploy-serverless-jobs.yml
    with:
      script_name: docs-fe
  deploy-client-be:
    uses: ./.github/workflows/_deploy-serverless-jobs.yml
    with:
      script_name: client-be
`

/** The `deploy-all` half of the two-axis split: same repo, its own env list, and no service inputs. */
const DEPLOY_ALL = `name: deploy all
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options:
          - dev
          - arthur
          - stage
          - prod
jobs:
  deploy-everything:
    uses: ./.github/workflows/_deploy-serverless-jobs.yml
`

let repo: string

/** A repo with a workflows directory but nothing in it — every candidate list comes back empty. */
let barrenRepo: string

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-deploy-form-'))
  barrenRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-deploy-form-barren-'))

  fs.mkdirSync(path.join(repo, '.github/workflows'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.github/workflows/deploy-selected-services.yml'), DEPLOY_SELECTED)
  fs.writeFileSync(path.join(repo, '.github/workflows/deploy-all.yml'), DEPLOY_ALL)
})

afterEach(() => {
  vi.clearAllMocks()
})

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(barrenRepo, { recursive: true, force: true })
})

/** Point every filesystem read at the fixture repo and give the release enum two real-shaped PRs. */
const populated = (root: string = repo): void => {
  vi.mocked(getProjectRoot).mockResolvedValue(root)
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue([
    {
      branch: 'release/v1.2.5',
      number: 1,
      title: 'Release v1.2.5',
      createdAt: '2026-01-01T00:00:00Z',
      baseRefName: 'dev',
      type: 'regular',
      titleMismatch: false,
      dualBase: false,
    },
    {
      branch: 'release/checkout-redesign',
      number: 2,
      title: 'Release checkout-redesign',
      createdAt: '2026-01-02T00:00:00Z',
      baseRefName: 'dev',
      type: 'regular',
      titleMismatch: false,
      dualBase: false,
    },
  ])
}

const deployAllProvider = (): ArgumentFormProvider => {
  return createDeployFormProvider({
    workflowFile: 'deploy-all.yml',
    fields: ['version', 'env'],
    toolName: 'gh-release-deploy-all',
  })
}

const deploySelectedProvider = (): ArgumentFormProvider => {
  return createDeployFormProvider({
    workflowFile: 'deploy-selected-services.yml',
    fields: ['version', 'env', 'services'],
    toolName: 'gh-release-deploy-selected',
  })
}

const localProvider = (toolName: string): ArgumentFormProvider => {
  return createDeployFormProvider({ workflowFile: 'deploy-all.yml', fields: ['env'], toolName })
}

interface RenderedField {
  type?: string
  description?: string
  enum?: string[]
  items?: { enum?: string[] }
}

interface RenderedSchema {
  properties?: Record<string, RenderedField>
  required?: string[]
}

/**
 * Render the provider's schema the way `refuseMissingArguments` ships it in `choices`: JSON Schema.
 *
 * Asserting here rather than on the returned zod object is the point: a skill reads the rendered
 * shape, so a schema that renders to something other than flat enums would go unnoticed by a test
 * that only inspected the zod object.
 */
const render = async (provider: ArgumentFormProvider, params: unknown): Promise<RenderedSchema> => {
  const schema = await provider.buildRequestedSchema(params)

  expect(schema).not.toBeNull()

  return schema === null ? {} : (z.toJSONSchema(schema) as RenderedSchema)
}

describe('isFormable', () => {
  it('is true when a declared field is absent and false when every one is present', () => {
    const provider = deploySelectedProvider()

    expect(provider.isFormable({ version: '1.2.5', env: 'dev' })).toBe(true)
    expect(provider.isFormable({ version: '1.2.5', env: 'dev', services: ['client-be'] })).toBe(false)
  })

  it('is false for anything that is not a record', () => {
    const provider = deploySelectedProvider()

    expect(provider.isFormable(undefined)).toBe(false)
    expect(provider.isFormable('dev')).toBe(false)
    expect(provider.isFormable(['dev'])).toBe(false)
    expect(provider.isFormable(null)).toBe(false)
  })

  it('ignores a field this tool does not declare — the local pair has no version', () => {
    expect(localProvider('local-deploy-all').isFormable({ env: 'dev' })).toBe(false)
    expect(localProvider('local-deploy-all').isFormable({ version: '1.2.5' })).toBe(true)
  })
})

// P10. The assertion that separates "a form was offered" from "the provider silently broke": a
// provider returning `null` reads as "nothing to offer" and the refusal ships without `choices`.
describe('p10 — every provider builds a RENDERABLE form', () => {
  it('renders all four, including the services-bearing shape', async () => {
    populated()

    const all = await render(deployAllProvider(), {})
    const selected = await render(deploySelectedProvider(), {})
    const localAll = await render(localProvider('local-deploy-all'), {})
    const localSelected = await render(localProvider('local-deploy-selected'), {})

    expect(Object.keys(all.properties ?? {})).toStrictEqual(['version', 'env'])
    expect(Object.keys(selected.properties ?? {})).toStrictEqual(['version', 'env', 'services'])
    expect(Object.keys(localAll.properties ?? {})).toStrictEqual(['env'])
    expect(Object.keys(localSelected.properties ?? {})).toStrictEqual(['env'])
  })

  it('renders services as an array of a string ENUM, the one spelling the wire accepts', async () => {
    populated()

    const schema = await render(deploySelectedProvider(), {})

    // `z.array(z.string())` — the spelling `gh-release-deploy-selected`'s own `inputSchema` uses —
    // would render no enum, leaving the skill nothing to pick from.
    expect(schema.properties?.services?.type).toBe('array')
    expect(schema.properties?.services?.items?.enum).toStrictEqual(['mobile', 'docs-fe', 'client-be'])
  })

  it('leaves every field optional — no field is required, and no default is rendered', async () => {
    populated()

    const schema = await render(deploySelectedProvider(), {})

    expect(schema.required).toBeUndefined()
  })
})

// P4. Offering `services` unconditionally would re-ask for a list round 1 already carried, and
// `toArgs` would then overwrite the caller's selection with the re-pick.
describe('p4 — the conditional services offer, both directions', () => {
  it('offers services when round 1 omitted them', async () => {
    populated()

    const schema = await render(deploySelectedProvider(), { version: '1.2.5', env: 'dev' })

    expect(schema.properties?.services).toBeDefined()
  })

  it('does NOT offer services when round 1 supplied them', async () => {
    populated()

    const schema = await render(deploySelectedProvider(), { services: ['client-be'] })

    expect(schema.properties?.services).toBeUndefined()
    expect(Object.keys(schema.properties ?? {})).toStrictEqual(['version', 'env'])
  })

  it('never puts services or service in any other provider shape', async () => {
    populated()

    const shapes = await Promise.all([
      render(deployAllProvider(), {}),
      render(localProvider('local-deploy-all'), {}),
      render(localProvider('local-deploy-selected'), {}),
    ])

    for (const schema of shapes) {
      expect(schema.properties?.services).toBeUndefined()
      expect(schema.properties?.service).toBeUndefined()
    }
  })
})

// P4b. An env-filtered enum would be derived from the ROUND-1 params, i.e. against an env the human
// may change on the same re-run — so it would validate their selection against the wrong list.
describe('p4b — the services enum is the full declared set', () => {
  it('is not filtered by the round-1 env, even one that gates two of the three services out', async () => {
    populated()

    const schema = await render(deploySelectedProvider(), { env: 'stage' })

    expect(schema.properties?.services?.items?.enum).toStrictEqual(['mobile', 'docs-fe', 'client-be'])
  })
})

describe('the descriptions that carry what the wire cannot', () => {
  it('marks the gate map on the services field, derived from the workflow-scoped read', async () => {
    populated()

    const schema = await render(deploySelectedProvider(), {})

    expect(schema.properties?.services?.description).toContain('mobile: dev, prod only.')
    expect(schema.properties?.services?.description).toContain('docs-fe: dev, arthur only.')
    expect(schema.properties?.services?.description).toContain('Others: any environment.')
  })

  it('names both env partitions, derived from isSharedEnv rather than written out here', async () => {
    populated()

    const schema = await render(deployAllProvider(), {})

    expect(schema.properties?.env?.enum).toStrictEqual(['dev', 'arthur', 'stage'])
    expect(schema.properties?.env?.description).toContain('Shared with the whole team: dev, stage.')
    expect(schema.properties?.env?.description).toContain('Personal accounts: arthur.')
  })

  it('states the drift escape hatch when round 1 sent an env this tree does not declare', async () => {
    populated()

    const schema = await render(deployAllProvider(), { env: 'qa-7' })

    expect(schema.properties?.env?.description).toContain('WORKING TREE')
    expect(schema.properties?.env?.description).toContain(`Leave it blank to keep the caller's "qa-7"`)
  })
})

// M4. `z.enum([])` is not an empty dropdown — it is a `TypeError` at construction. Refusing early
// is what makes "nothing to offer" a decision with a reason rather than a swallowed error.
describe('an empty candidate list returns null explicitly, for each of the three sources', () => {
  it('returns null when there are no open releases', async () => {
    populated()
    vi.mocked(getReleasePRsWithInfo).mockResolvedValue([])

    expect(await deployAllProvider().buildRequestedSchema({})).toBeNull()
  })

  it('returns null when the release fetch FAILS, which is not the same as a one-option dropdown', async () => {
    populated()
    vi.mocked(getReleasePRsWithInfo).mockRejectedValue(new Error('gh is not authenticated'))

    expect(await deployAllProvider().buildRequestedSchema({})).toBeNull()
  })

  it('returns null when the workflow declares no environments', async () => {
    populated(barrenRepo)

    expect(await localProvider('local-deploy-all').buildRequestedSchema({})).toBeNull()
  })

  it('returns null when the workflow declares no services and services is the offered field', async () => {
    populated()

    // `deploy-all.yml` has real env choices and zero boolean inputs, so only the services list is
    // empty — which isolates the services leg from the env one.
    const provider = createDeployFormProvider({
      workflowFile: 'deploy-all.yml',
      fields: ['env', 'services'],
      toolName: 'gh-release-deploy-selected',
    })

    expect(await provider.buildRequestedSchema({})).toBeNull()
  })

  it('does NOT refuse for an empty service list when round 1 already supplied services', async () => {
    populated()

    const provider = createDeployFormProvider({
      workflowFile: 'deploy-all.yml',
      fields: ['env', 'services'],
      toolName: 'gh-release-deploy-selected',
    })

    expect(await provider.buildRequestedSchema({ services: ['client-be'] })).not.toBeNull()
  })
})

// P11. The enum is a WORKING-TREE read while the dispatch targets `--ref <branch>`, so the two can
// legitimately differ. Because the field is `.optional()` and `toArgs` merges rather than
// constructs, a blank submission keeps the round-1 value — writing `undefined` for untouched fields
// would silently delete it.
describe('p11 — the drift escape hatch', () => {
  it('keeps a round-1 env the working tree does not declare when the human leaves it blank', () => {
    const merged = deployAllProvider().toArgs({ version: '1.2.5' }, { env: 'qa-7', confirm: true })

    expect(merged).toStrictEqual({ env: 'qa-7', confirm: true, version: '1.2.5' })
  })
})

describe('p12 — toArgs merges, and an empty services selection is a named discard', () => {
  it('introduces no key beyond round-1 keys union the declared fields', () => {
    const merged = deploySelectedProvider().toArgs(
      { version: '1.2.5', env: 'dev', services: ['client-be'], smuggled: 'x' },
      { skipTerraform: true },
    )

    expect(Object.keys(merged ?? {}).sort()).toStrictEqual(['env', 'services', 'skipTerraform', 'version'])
  })

  it('overwrites field by field and leaves untouched round-1 keys alone', () => {
    const merged = deploySelectedProvider().toArgs({ env: 'arthur' }, { version: '1.2.5', env: 'dev' })

    expect(merged).toStrictEqual({ version: '1.2.5', env: 'arthur' })
  })

  // `services` is absent from round 1, so an auto-filled `[]` would reach the tool as "deploy
  // nothing" — a dispatch that reports success and ships nothing. `null` names the discard instead.
  it('returns null for an empty services selection', () => {
    expect(deploySelectedProvider().toArgs({ services: [] }, { env: 'dev' })).toBeNull()
  })

  it('never throws on content it did not expect', () => {
    const provider = deploySelectedProvider()

    expect(provider.toArgs({ services: 'client-be' }, { env: 'dev' })).toBeNull()
    expect(provider.toArgs({}, undefined)).toStrictEqual({})
  })
})
