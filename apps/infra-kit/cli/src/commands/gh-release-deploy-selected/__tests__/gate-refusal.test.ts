import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ghReleaseDeploySelected } from '../gh-release-deploy-selected'

// The response shape cannot distinguish "refused" from "refused but dispatched" — dispatch is
// fire-and-forget, so a run that shipped nothing still returns `success: true`. Record the rendered
// argv instead, and assert on it.
const dispatched = vi.hoisted(() => {
  return { argv: [] as string[] }
})

const fixture = vi.hoisted(() => {
  return { root: '' }
})

vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()

  return {
    ...actual,
    $: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      dispatched.argv.push(
        strings
          .map((part, index) => {
            const value = values[index]

            return part + (value === undefined ? '' : JSON.stringify(value))
          })
          .join(''),
      )

      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    }),
  }
})

// Only the two impure members are overridden; the gate under test stays real.
vi.mock('src/lib/workflow-envs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/workflow-envs')>()

  return {
    ...actual,
    readWorkflowEnvOptions: vi.fn().mockResolvedValue(['dev', 'stage', 'prod']),
    resolveProtectedEnvAccess: vi.fn().mockResolvedValue({ allowed: false, reason: 'disallow' }),
  }
})

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(() => {
      return Promise.resolve(fixture.root)
    }),
  }
})

/** travelist's prod-only `media`, in the reusable-workflow form — a gate this dispatch never runs. */
const DEPLOY_ALL = `name: deploy all
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
jobs:
  deploy-media:
    if: \${{ github.event.inputs.environment == 'prod' }}
    uses: ./.github/workflows/_deploy-media-jobs.yml
`

/**
 * The literal gate form both consumers carry for `mobile` (hulyo `:283`, travelist `:288`), plus a
 * `media` job this file gates by nothing and a `client-be` job gated in an unparseable form.
 */
const DEPLOY_SELECTED = `name: deploy selected services
on:
  workflow_dispatch:
    inputs:
      mobile:
        type: boolean
      media:
        type: boolean
      client-be:
        type: boolean
      skip_terraform_deploy:
        type: boolean
jobs:
  deploy-mobile:
    if: \${{ github.event.inputs.mobile == 'true' && (github.event.inputs.environment == 'dev' || github.event.inputs.environment == 'prod') && always() }}
    uses: ./.github/workflows/_deploy-serverless-jobs.yml
    with:
      script_name: mobile
  deploy-media:
    if: \${{ github.event.inputs.media == 'true' }}
    uses: ./.github/workflows/_deploy-media-jobs.yml
  deploy-client-be:
    if: \${{ contains(fromJSON('["dev","prod"]'), github.event.inputs.environment) }}
    uses: ./.github/workflows/_deploy-serverless-jobs.yml
    with:
      script_name: client-be
`

const deploy = async (env: string, services: string[]) => {
  return ghReleaseDeploySelected({ version: '1.9.0', env, services, confirmedCommand: true })
}

beforeAll(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-gate-refusal-'))

  await fs.mkdir(path.join(fixture.root, '.github/workflows'), { recursive: true })
  await fs.writeFile(path.join(fixture.root, '.github/workflows/deploy-all.yml'), DEPLOY_ALL, 'utf-8')
  await fs.writeFile(
    path.join(fixture.root, '.github/workflows/deploy-selected-services.yml'),
    DEPLOY_SELECTED,
    'utf-8',
  )
})

beforeEach(() => {
  dispatched.argv = []
})

afterAll(async () => {
  await fs.rm(fixture.root, { recursive: true, force: true })
})

describe('ghReleaseDeploySelected — execution-time service gates', () => {
  it('refuses a service the target environment gates out, naming it', async () => {
    await expect(deploy('stage', ['mobile'])).rejects.toThrow(/gates these services out of stage: mobile/)
  })

  // E1b. Without this the refusal could be reported while the dispatch still went out, which is the
  // exact failure mode the gate exists to close.
  it('dispatches nothing when a service is gated out', async () => {
    // Settled, not `rejects`: the argv assertion has to be the one that can fail, or deleting the
    // intersection reddens on the missing rejection and never shows the dispatch that went out.
    const outcome = await deploy('stage', ['mobile']).then(
      () => {
        return 'dispatched'
      },
      () => {
        return 'refused'
      },
    )

    expect(dispatched.argv).toStrictEqual([])
    expect(outcome).toBe('refused')
  })

  it('names only the excluded service when the selection mixes gated and ungated ones', async () => {
    await expect(deploy('stage', ['media', 'mobile'])).rejects.toThrow(/out of stage: mobile/)

    expect(dispatched.argv).toStrictEqual([])
  })

  it('dispatches the same service to an environment its gate allows', async () => {
    const result = await deploy('dev', ['mobile'])

    expect(result.structuredContent.success).toBe(true)
    expect(dispatched.argv).toHaveLength(1)
    expect(dispatched.argv[0]).toContain('mobile=true')
  })

  // The two-read requirement, observed through the command. `media` is prod-only in `deploy-all.yml`
  // and ungated in the workflow being dispatched, so the repo-wide union would refuse this run using
  // a gate from a file nobody is running. Pointing the refusal at `readWorkflowGates` reddens here.
  it('ignores a gate that belongs to a workflow this command does not dispatch', async () => {
    const result = await deploy('dev', ['media'])

    expect(result.structuredContent.success).toBe(true)
    expect(dispatched.argv).toHaveLength(1)
  })

  // Fail-open, preserved: a gate we cannot parse imposes no restriction. `client-be`'s `if:` really
  // does exclude `stage`, and this run really does go out — closing that would mean inventing gates.
  it('imposes no restriction when the gate is in a form it cannot parse', async () => {
    const result = await deploy('stage', ['client-be'])

    expect(result.structuredContent.success).toBe(true)
    expect(dispatched.argv).toHaveLength(1)
  })
})
