import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { envLoad, envLoadMcpTool } from 'src/commands/env-load'
import { ghReleaseDeployAll, ghReleaseDeployAllMcpTool } from 'src/commands/gh-release-deploy-all'
import { ghReleaseDeploySelected, ghReleaseDeploySelectedMcpTool } from 'src/commands/gh-release-deploy-selected'
import { releaseCreate, releaseCreateMcpTool } from 'src/commands/release-create'
import { releaseRemove, releaseRemoveMcpTool } from 'src/commands/release-remove'
import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { readTokenStore } from 'src/lib/env-tokens'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { getProjectRoot } from 'src/lib/git-utils'
import { jsonOutput } from 'src/lib/json-output'
import { listProjectEnvs } from 'src/lib/project-envs'
import { getJiraDescriptions } from 'src/lib/release-utils'
import { loadExistingVersions } from 'src/lib/version-utils/load-existing-versions'
import type { ArgumentFormProvider } from 'src/types'

/**
 * @fileoverview
 * Choices parity (plan §3.4): a Bash-driven agent that omits a picker argument at one of the five
 * gh/Jira form-backed commands is refused with `argument_required` whose `choices` are the tool's
 * OWN form provider's requested schema, rendered as JSON Schema — the rows a human's picker would
 * have offered, byte for byte. The oracle is the live `formProvider` on each `*McpTool`, so a
 * command that grew a private row shape, or a guard that reached for a different provider, reds
 * here. (`local-deploy`'s pair is pinned in its own guard suite, whose fixture it needs.)
 *
 * Each fixture is the minimum that makes the builder return a non-null schema: the env list and
 * token store for `env-load`, the known versions for `release-create`, the open PRs (+ Jira
 * descriptions) for `release-remove`, and a temp repo with the two workflow files for the deploys.
 */

vi.mock('src/lib/project-envs', async (importOriginal) => {
  return { ...(await importOriginal<object>()), listProjectEnvs: vi.fn() }
})

vi.mock('src/lib/env-tokens', async (importOriginal) => {
  return { ...(await importOriginal<object>()), readTokenStore: vi.fn() }
})

vi.mock('src/lib/version-utils/load-existing-versions', async (importOriginal) => {
  return { ...(await importOriginal<object>()), loadExistingVersions: vi.fn() }
})

vi.mock('src/integrations/gh', async (importOriginal) => {
  return { ...(await importOriginal<object>()), getReleasePRsWithInfo: vi.fn() }
})

vi.mock('src/lib/release-utils', async (importOriginal) => {
  return { ...(await importOriginal<object>()), getJiraDescriptions: vi.fn() }
})

vi.mock('src/lib/git-guard', () => {
  return {
    assertManagementContext: vi.fn(async () => {}),
    assertBaseBranchSwitchable: vi.fn(async () => {}),
    assertCleanCheckout: vi.fn(async () => {}),
  }
})

vi.mock('src/lib/git-utils', async (importOriginal) => {
  return { ...(await importOriginal<object>()), getProjectRoot: vi.fn() }
})

vi.mock('src/lib/infra-kit-config', async (importOriginal) => {
  return {
    ...(await importOriginal<object>()),
    getInfraKitConfig: vi.fn(() => {
      return Promise.resolve({})
    }),
  }
})

vi.mock('src/integrations/jira', async (importOriginal) => {
  return {
    ...(await importOriginal<object>()),
    loadJiraConfig: vi.fn(() => {
      return Promise.resolve({ baseUrl: 'https://jira', token: 't', email: 'e', projectId: 1 })
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

const WORKFLOW = (name: string): string => {
  return `name: ${name}
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options:
          - dev
          - stage
      client-be:
        type: boolean
jobs:
  deploy-client-be:
    uses: ./.github/workflows/_deploy-serverless-jobs.yml
    with:
      script_name: client-be
`
}

let repo: string

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-agent-choices-'))
  fs.mkdirSync(path.join(repo, '.github/workflows'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.github/workflows/deploy-selected-services.yml'), WORKFLOW('selected'))
  fs.writeFileSync(path.join(repo, '.github/workflows/deploy-all.yml'), WORKFLOW('all'))
})

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  agentMode.source = 'flag'
  vi.mocked(getProjectRoot).mockResolvedValue(repo)
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
  ])
  vi.mocked(getJiraDescriptions).mockResolvedValue(new Map([['v1.2.5', 'checkout']]))
  vi.mocked(listProjectEnvs).mockResolvedValue([
    { env: 'dev', source: 'gh-workflow' },
    { env: 'arthur', source: 'token-only' },
  ])
  vi.mocked(readTokenStore).mockResolvedValue({ version: 1, envs: { dev: 'dp.st.dev.xxxx' } })
  vi.mocked(loadExistingVersions).mockResolvedValue([[1, 2, 4]])
})

afterEach(() => {
  agentMode.source = null
  jsonOutput.enabled = false
})

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true })
})

/** What the human's picker would have offered: the tool's own provider, rendered the same way. */
const expectedChoices = async (provider: ArgumentFormProvider | undefined, params: unknown): Promise<unknown> => {
  const schema = await provider!.buildRequestedSchema(params)

  expect(schema, 'the fixture must make the builder offer a form').not.toBeNull()

  return z.toJSONSchema(schema!)
}

const refusalFrom = async (run: Promise<unknown>): Promise<StructuredRefusalError> => {
  const error = await run.catch((e: unknown) => {
    return e
  })

  expect(error).toBeInstanceOf(StructuredRefusalError)

  return error as StructuredRefusalError
}

describe('argument_required + choices at the form-backed guards', () => {
  it('env-load without --config: argument `config`, choices = the env-load form', async () => {
    const error = await refusalFrom(envLoad({}))

    expect(error.structuredContent).toEqual({
      status: 'argument_required',
      argument: 'config',
      choices: await expectedChoices(envLoadMcpTool.formProvider, {}),
      agentMode: 'flag',
    })
    expect(error.exitCode).toBe(2)
  })

  it('release create without --release: argument `release`, choices = the release form', async () => {
    const error = await refusalFrom(releaseCreate({ confirmedCommand: false }))

    expect(error.structuredContent).toEqual({
      status: 'argument_required',
      argument: 'release',
      choices: await expectedChoices(releaseCreateMcpTool.formProvider, {}),
      agentMode: 'flag',
    })
  })

  it('release remove without --version: argument `version`, choices = the open release PRs', async () => {
    const error = await refusalFrom(releaseRemove({ confirmedCommand: false }))

    expect(error.structuredContent).toEqual({
      status: 'argument_required',
      argument: 'version',
      choices: await expectedChoices(releaseRemoveMcpTool.formProvider, {}),
      agentMode: 'flag',
    })
    expect(JSON.stringify(error.structuredContent.choices)).toContain('1.2.5 [regular] — checkout')
  })

  it('release deploy-all with nothing: argument `version`, choices = the two-field deploy form', async () => {
    const error = await refusalFrom(ghReleaseDeployAll({}))

    expect(error.structuredContent).toEqual({
      status: 'argument_required',
      argument: 'version',
      choices: await expectedChoices(ghReleaseDeployAllMcpTool.formProvider, {}),
      agentMode: 'flag',
    })
  })

  it('release deploy-selected with only --version: names `env` (the first field left out), choices = the form', async () => {
    const params = { version: '1.2.5' }
    const error = await refusalFrom(ghReleaseDeploySelected(params))
    const choices = (await expectedChoices(ghReleaseDeploySelectedMcpTool.formProvider, params)) as {
      properties: Record<string, unknown>
    }

    // The form re-offers `version` (editable) — the named argument must still be the one omitted.
    expect(Object.keys(choices.properties)).toEqual(['version', 'env', 'services'])
    expect(error.structuredContent).toEqual({
      status: 'argument_required',
      argument: 'env',
      choices,
      agentMode: 'flag',
    })
  })

  it('fires under --json for a human too, with the source recorded as null', async () => {
    agentMode.source = null
    jsonOutput.enabled = true

    const error = await refusalFrom(envLoad({}))

    expect(error.structuredContent).toMatchObject({ status: 'argument_required', argument: 'config', agentMode: null })
  })
})
