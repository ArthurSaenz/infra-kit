import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRsWithInfo, updateReleasePRBody } from 'src/integrations/gh'
import { findVersionByName, loadJiraConfig, updateJiraVersion } from 'src/integrations/jira'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { jsonOutput } from 'src/lib/json-output'

import { releaseEdit } from '../release-edit'

/**
 * The confirm site of `release-edit` under agent mode: `confirmation_required` reaches the
 * caller, and neither Jira nor the PR body is touched. Both writes are mocked so a regression here
 * would be a recorded call, not a network error.
 *
 * The per-field cases below pin what each flag combination PUTs to Jira — exactly the changed
 * fields, nothing else — and that the PR body is rewritten only when the description changed (it
 * never carries the date).
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

vi.mock('@inquirer/input', () => {
  return { default: vi.fn() }
})

const input = vi.mocked((await import('@inquirer/input')).default)

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
    {
      branch: 'release/v1.2.5',
      number: 1,
      title: 'Release v1.2.5',
      createdAt: '2024-01-01T00:00:00Z',
      baseRefName: 'dev',
      type: 'regular',
      titleMismatch: false,
      dualBase: false,
    },
  ])
  vi.mocked(findVersionByName).mockResolvedValue({
    id: '1',
    name: 'v1.2.5',
    description: 'old',
    releaseDate: '2026-10-28',
  } as never)
  vi.mocked(updateJiraVersion).mockResolvedValue({ success: true } as never)
})

afterEach(() => {
  agentMode.source = null
  jsonOutput.enabled = false
})

describe('release-edit — the confirm site propagates its refusal', () => {
  it('an unconfirmed agent run throws confirmation_required and writes to neither Jira nor the PR', async () => {
    agentMode.source = 'flag'

    const error = await releaseEdit({ version: '1.2.5', description: 'new', confirmedCommand: false }).catch(
      (e: unknown) => {
        return e
      },
    )

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({
      status: 'confirmation_required',
      agentMode: 'flag',
    })
    expect((error as StructuredRefusalError).structuredContent.message).toContain('description: "old" → "new"')
    expect((error as StructuredRefusalError).exitCode).toBe(2)
    expect(updateJiraVersion).not.toHaveBeenCalled()
    expect(updateReleasePRBody).not.toHaveBeenCalled()
  })

  it('no field in agent mode is argument_required naming description, refused before any prompt', async () => {
    agentMode.source = 'env'

    const error = await releaseEdit({ version: '1.2.5', confirmedCommand: false }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toEqual({
      status: 'argument_required',
      argument: 'description',
      agentMode: 'env',
    })
    expect((error as StructuredRefusalError).message).toContain('--description and/or --release-date')
    expect(input).not.toHaveBeenCalled()
    expect(updateJiraVersion).not.toHaveBeenCalled()
  })

  it('no field under --json alone is refused the same way (the prompt it pre-empts keys on isHeadless)', async () => {
    jsonOutput.enabled = true

    const error = await releaseEdit({ version: '1.2.5', confirmedCommand: false }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({
      status: 'argument_required',
      argument: 'description',
      agentMode: null,
    })
    expect(input).not.toHaveBeenCalled()
  })
})

describe('release-edit — each flag writes exactly its own field', () => {
  beforeEach(() => {
    agentMode.source = 'flag'
  })

  it('--release-date alone PUTs only the date and leaves the PR body alone', async () => {
    const result = await releaseEdit({ version: '1.2.5', releaseDate: '2026-11-03', confirmedCommand: true })

    expect(updateJiraVersion).toHaveBeenCalledTimes(1)
    expect(vi.mocked(updateJiraVersion).mock.calls[0]?.[0]).toEqual({ versionId: '1', releaseDate: '2026-11-03' })
    expect(updateReleasePRBody).not.toHaveBeenCalled()
    expect(result.structuredContent).toMatchObject({
      changed: true,
      changedFields: ['releaseDate'],
      previousReleaseDate: '2026-10-28',
      newReleaseDate: '2026-11-03',
      previousDescription: 'old',
      newDescription: 'old',
    })
  })

  it('--description alone PUTs only the description and rewrites the PR body', async () => {
    const result = await releaseEdit({ version: '1.2.5', description: 'new', confirmedCommand: true })

    expect(updateJiraVersion).toHaveBeenCalledTimes(1)
    expect(vi.mocked(updateJiraVersion).mock.calls[0]?.[0]).toEqual({ versionId: '1', description: 'new' })
    expect(updateReleasePRBody).toHaveBeenCalledWith({
      branch: 'release/v1.2.5',
      body: expect.stringContaining('new'),
    })
    expect(result.structuredContent).toMatchObject({
      changedFields: ['description'],
      previousReleaseDate: '2026-10-28',
      newReleaseDate: '2026-10-28',
    })
  })

  it('both flags make ONE PUT carrying both fields', async () => {
    const result = await releaseEdit({
      version: '1.2.5',
      description: 'new',
      releaseDate: '2026-11-03',
      confirmedCommand: true,
    })

    expect(updateJiraVersion).toHaveBeenCalledTimes(1)
    expect(vi.mocked(updateJiraVersion).mock.calls[0]?.[0]).toEqual({
      versionId: '1',
      description: 'new',
      releaseDate: '2026-11-03',
    })
    expect(updateReleasePRBody).toHaveBeenCalledTimes(1)
    expect(result.structuredContent.changedFields).toEqual(['description', 'releaseDate'])
  })

  it('the same values are changed: false — no PUT and no confirm gate', async () => {
    const result = await releaseEdit({
      version: '1.2.5',
      description: 'old',
      releaseDate: '2026-10-28',
      confirmedCommand: false,
    })

    expect(result.structuredContent).toMatchObject({ changed: false, changedFields: [] })
    expect(updateJiraVersion).not.toHaveBeenCalled()
    expect(updateReleasePRBody).not.toHaveBeenCalled()
  })

  it('--release-date "" on a dated version PUTs releaseDate: null', async () => {
    const result = await releaseEdit({ version: '1.2.5', releaseDate: '', confirmedCommand: true })

    expect(vi.mocked(updateJiraVersion).mock.calls[0]?.[0]).toEqual({ versionId: '1', releaseDate: null })
    expect(result.structuredContent).toMatchObject({ newReleaseDate: null, changedFields: ['releaseDate'] })
  })

  it('releaseDate: "" on an undated version is changed: false, no PUT', async () => {
    vi.mocked(findVersionByName).mockResolvedValue({ id: '1', name: 'v1.2.5', description: 'old' } as never)

    const result = await releaseEdit({ version: '1.2.5', releaseDate: '', confirmedCommand: false })

    expect(result.structuredContent).toMatchObject({
      changed: false,
      previousReleaseDate: null,
      newReleaseDate: null,
    })
    expect(updateJiraVersion).not.toHaveBeenCalled()
  })

  it('the confirm text lists one line per changed field', async () => {
    const error = await releaseEdit({
      version: '1.2.5',
      description: 'new',
      releaseDate: '',
      confirmedCommand: false,
    }).catch((e: unknown) => {
      return e
    })

    expect((error as StructuredRefusalError).structuredContent.message).toContain('Update v1.2.5?')
    expect((error as StructuredRefusalError).structuredContent.message).toContain('description: "old" → "new"')
    expect((error as StructuredRefusalError).structuredContent.message).toContain('release date: 2026-10-28 → (none)')
  })
})
