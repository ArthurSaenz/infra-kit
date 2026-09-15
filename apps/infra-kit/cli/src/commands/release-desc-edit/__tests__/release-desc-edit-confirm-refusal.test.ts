import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRsWithInfo, updateReleasePRBody } from 'src/integrations/gh'
import { findVersionByName, loadJiraConfig, updateJiraVersion } from 'src/integrations/jira'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { jsonOutput } from 'src/lib/json-output'

import { releaseDescEdit } from '../release-desc-edit'

/**
 * The confirm site of `release-desc-edit` under agent mode: `confirmation_required` reaches the
 * caller, and neither Jira nor the PR body is touched. Both writes are mocked so a regression here
 * would be a recorded call, not a network error.
 */

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn(), updateReleasePRBody: vi.fn() }
})

vi.mock('src/integrations/jira', () => {
  return {
    loadJiraConfig: vi.fn(),
    findVersionByName: vi.fn(),
    updateJiraVersion: vi.fn(),
    buildJiraVersionUrl: vi.fn(() => {
      return 'https://jira/versions/1'
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

vi.mock('@inquirer/confirm')

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  vi.mocked(loadJiraConfig).mockResolvedValue({
    baseUrl: 'https://jira',
    token: 't',
    email: 'e',
    projectId: 1,
  } as never)
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue([
    { branch: 'release/v1.2.5', title: 'Release v1.2.5', createdAt: '2024-01-01T00:00:00Z' },
  ])
  vi.mocked(findVersionByName).mockResolvedValue({ id: '1', name: 'v1.2.5', description: 'old' } as never)
})

afterEach(() => {
  agentMode.source = null
  jsonOutput.enabled = false
})

describe('release-desc-edit — the confirm site propagates its refusal', () => {
  it('an unconfirmed agent run throws confirmation_required and writes to neither Jira nor the PR', async () => {
    agentMode.source = 'flag'

    const error = await releaseDescEdit({ version: '1.2.5', description: 'new', confirmedCommand: false }).catch(
      (e: unknown) => {
        return e
      },
    )

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({
      status: 'confirmation_required',
      agentMode: 'flag',
    })
    expect((error as StructuredRefusalError).structuredContent.message).toContain('from: "old"')
    expect((error as StructuredRefusalError).exitCode).toBe(2)
    expect(updateJiraVersion).not.toHaveBeenCalled()
    expect(updateReleasePRBody).not.toHaveBeenCalled()
  })

  it('a missing --description in agent mode is argument_required naming it, not a prompt', async () => {
    agentMode.source = 'env'

    const error = await releaseDescEdit({ version: '1.2.5', confirmedCommand: false }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toEqual({
      status: 'argument_required',
      argument: 'description',
      agentMode: 'env',
    })
  })
})
