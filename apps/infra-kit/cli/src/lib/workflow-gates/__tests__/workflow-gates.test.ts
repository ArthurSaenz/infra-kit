import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { intersectGates, readGatesFromWorkflow, readWorkflowGates } from '../workflow-gates'

let repo: string

/**
 * Mirrors travelist: `media` is prod-only here, through the reusable-workflow form that carries no
 * `script_name` at all. This is the gate the union imports into a dispatch that never runs this file.
 */
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
 * Mirrors both consumers' `deploy-selected-services.yml`: `mobile` gated to dev/prod (hulyo `:283`,
 * travelist `:288`), `media` declared but gated by nothing, and `client-be` gated in a form this
 * module cannot parse.
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

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-gates-'))

  await fs.mkdir(path.join(repo, '.github/workflows'), { recursive: true })
  await fs.writeFile(path.join(repo, '.github/workflows/deploy-all.yml'), DEPLOY_ALL, 'utf-8')
  await fs.writeFile(path.join(repo, '.github/workflows/deploy-selected-services.yml'), DEPLOY_SELECTED, 'utf-8')
})

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('readWorkflowGates — the repo-wide union', () => {
  it('unions a service gated in one workflow and ungated in another', async () => {
    const gates = await readWorkflowGates(repo)

    expect(gates.get('mobile')).toStrictEqual(['dev', 'prod'])
    expect(gates.get('media')).toStrictEqual(['prod'])
  })

  it('returns an empty map for a repo with no workflows dir', async () => {
    expect(await readWorkflowGates(path.join(repo, 'nope'))).toStrictEqual(new Map())
  })
})

describe('readGatesFromWorkflow — one named file', () => {
  // The two-read requirement, at the level where it is decidable. `local-deploy` wants the union
  // ("can this service deploy here at all"); a dispatch wants this file's answer ("will THIS job
  // run"). Collapsing the module to the union read reddens this: `media` would arrive gated to prod
  // by `deploy-all.yml`, a workflow the dispatch is not running.
  it("ignores another workflow's gate for the same service", async () => {
    const gates = await readGatesFromWorkflow(repo, 'deploy-selected-services.yml')

    expect(gates.get('media')).toBeUndefined()
    expect(gates.get('mobile')).toStrictEqual(['dev', 'prod'])
  })

  it('reads only the file it is given', async () => {
    const gates = await readGatesFromWorkflow(repo, 'deploy-all.yml')

    expect(gates.get('media')).toStrictEqual(['prod'])
    expect(gates.get('mobile')).toBeUndefined()
  })

  // Fail-open is the contract, not an oversight: inventing a restriction we did not understand would
  // silently shrink what the user can deploy.
  it('imposes no restriction for a gate it cannot parse', async () => {
    const gates = await readGatesFromWorkflow(repo, 'deploy-selected-services.yml')

    expect(gates.get('client-be')).toBeUndefined()
  })

  it('imposes no restriction for a workflow that does not exist', async () => {
    expect(await readGatesFromWorkflow(repo, 'deploy-nothing.yml')).toStrictEqual(new Map())
  })
})

describe('intersectGates', () => {
  it('treats an absent source as unrestricted rather than as "nowhere"', () => {
    expect(intersectGates(null, undefined)).toBeNull()
    expect(intersectGates(null, ['dev'])).toStrictEqual(['dev'])
    expect(intersectGates(['dev', 'prod'], undefined)).toStrictEqual(['dev', 'prod'])
  })

  it('intersects when both sources restrict', () => {
    expect(intersectGates(['dev', 'prod'], ['prod'])).toStrictEqual(['prod'])
  })
})
