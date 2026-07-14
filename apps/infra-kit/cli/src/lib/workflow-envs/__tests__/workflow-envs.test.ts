import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectRoot } from 'src/lib/git-utils'

import { listWorkflowEnvs, readWorkflowEnvOptions } from '../workflow-envs'

vi.mock('src/lib/git-utils', () => {
  return { getProjectRoot: vi.fn() }
})

let repo: string

const workflowsDir = (): string => {
  return path.join(repo, '.github', 'workflows')
}

const writeWorkflow = (file: string, content: string): void => {
  fs.mkdirSync(workflowsDir(), { recursive: true })
  fs.writeFileSync(path.join(workflowsDir(), file), content)
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-envs-test-'))
  vi.mocked(getProjectRoot).mockResolvedValue(repo)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(repo, { recursive: true, force: true })
})

/** A real-shaped `workflow_dispatch` `choice` input, the same structure every repo's `deploy-all.yml` uses. */
const REAL_SHAPED_WORKFLOW = `
name: Deploy All
on:
  workflow_dispatch:
    inputs:
      environment:
        description: Target environment
        type: choice
        options:
          - dev
          - stage
          - prod
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploying
`

describe('readWorkflowEnvOptions', () => {
  it('extracts the options from a real-shaped workflow_dispatch choice input', async () => {
    writeWorkflow('deploy-all.yml', REAL_SHAPED_WORKFLOW)

    await expect(readWorkflowEnvOptions('deploy-all.yml')).resolves.toEqual(['dev', 'stage', 'prod'])
  })

  it('returns [] for a workflow file that does not exist', async () => {
    await expect(readWorkflowEnvOptions('absent.yml')).resolves.toEqual([])
  })

  it('returns [] when the environment input is `type: string` (a reusable workflow, no options)', async () => {
    writeWorkflow(
      'reusable.yml',
      `on:
  workflow_call:
    inputs:
      environment:
        type: string
`,
    )

    await expect(readWorkflowEnvOptions('reusable.yml')).resolves.toEqual([])
  })

  it('returns [] when workflow_dispatch has no `options` key at all', async () => {
    writeWorkflow(
      'no-options.yml',
      `on:
  workflow_dispatch:
    inputs:
      environment:
        description: no options key here
`,
    )

    await expect(readWorkflowEnvOptions('no-options.yml')).resolves.toEqual([])
  })

  it('returns [] for a push-only workflow with no workflow_dispatch at all', async () => {
    writeWorkflow(
      'push-only.yml',
      `on:
  push:
    branches: [main]
`,
    )

    await expect(readWorkflowEnvOptions('push-only.yml')).resolves.toEqual([])
  })

  it('returns [] for malformed YAML instead of throwing', async () => {
    writeWorkflow('broken.yml', 'on: [dev\n  : : :\n')

    await expect(readWorkflowEnvOptions('broken.yml')).resolves.toEqual([])
  })

  it('filters out non-string option entries', async () => {
    writeWorkflow(
      'mixed-options.yml',
      `on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options:
          - dev
          - 42
          - ""
          - prod
`,
    )

    await expect(readWorkflowEnvOptions('mixed-options.yml')).resolves.toEqual(['dev', 'prod'])
  })
})

describe('listWorkflowEnvs', () => {
  it('unions options across multiple workflows, de-duping, preserving first-seen order', async () => {
    // Alphabetically deploy-all.yml sorts before deploy-selected.yml — the union should read
    // deploy-all's envs first, then deploy-selected's NEW ones only.
    writeWorkflow(
      'deploy-all.yml',
      `on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [dev, stage, prod]
`,
    )
    writeWorkflow(
      'deploy-selected.yml',
      `on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [dev, eliran, roman]
`,
    )

    await expect(listWorkflowEnvs()).resolves.toEqual(['dev', 'stage', 'prod', 'eliran', 'roman'])
  })

  it('returns [] when the .github/workflows directory does not exist', async () => {
    await expect(listWorkflowEnvs()).resolves.toEqual([])
  })

  it('ignores non-yml/yaml files and workflows with no declared options', async () => {
    writeWorkflow('README.md', 'not a workflow')
    writeWorkflow(
      'code-quality.yml',
      `on:
  push:
    branches: [main]
`,
    )

    await expect(listWorkflowEnvs()).resolves.toEqual([])
  })

  it('never throws when one workflow among several is malformed', async () => {
    writeWorkflow(
      'deploy-all.yml',
      `on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [dev, prod]
`,
    )
    writeWorkflow('broken.yml', 'on: [dev\n  : : :\n')

    await expect(listWorkflowEnvs()).resolves.toEqual(['dev', 'prod'])
  })
})
