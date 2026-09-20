import { beforeEach, describe, expect, it, vi } from 'vitest'

import { expectRejection } from 'src/lib/errors/__tests__/expect-rejection'
import { OperationError } from 'src/lib/errors/operation-error'

import { createSingleRelease } from '../release-utils'

const mocks = vi.hoisted(() => {
  return {
    findVersionByName: vi.fn(),
    createJiraVersion: vi.fn(),
    updateJiraVersion: vi.fn(),
    createReleaseBranch: vi.fn(),
  }
})

vi.mock('src/integrations/jira', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/integrations/jira')>()

  return {
    ...actual,
    findVersionByName: mocks.findVersionByName,
    createJiraVersion: mocks.createJiraVersion,
    updateJiraVersion: mocks.updateJiraVersion,
  }
})

vi.mock('src/integrations/gh', () => {
  return { createReleaseBranch: mocks.createReleaseBranch }
})

const jiraConfig = {
  baseUrl: 'https://jira.example.com',
  token: 't',
  email: 'e@example.com',
  projectId: 10_001,
} as never

const id = { kind: 'version', semver: { major: 1, minor: 2, patch: 3 }, raw: '1.2.3' } as const

const version = (overrides: Record<string, unknown> = {}) => {
  return {
    id: '42',
    self: 'https://jira.example.com/rest/api/3/version/42',
    name: 'v1.2.3',
    archived: false,
    released: false,
    projectId: 10_001,
    ...overrides,
  }
}

const run = (description?: string, releaseDate?: string) => {
  return createSingleRelease({
    id,
    jiraConfig,
    description,
    ...(releaseDate === undefined ? {} : { releaseDate }),
    type: 'regular',
    baseSha: 'a'.repeat(40),
  })
}

describe('createSingleRelease — Jira fix version reuse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createReleaseBranch.mockResolvedValue({ branchName: 'release/v1.2.3', prUrl: 'https://gh/pr/1' })
  })

  it('creates the version when none exists', async () => {
    mocks.findVersionByName.mockResolvedValue(null)
    mocks.createJiraVersion.mockResolvedValue({ success: true, version: version() })

    const result = await run('first cut')

    expect(mocks.createJiraVersion).toHaveBeenCalledOnce()
    expect(result.jiraVersionUrl).toBe(
      'https://jira.example.com/projects/10001/versions/42/tab/release-report-all-issues',
    )
  })

  // The whole point of the reuse: an unconditional POST answers a duplicate name with a 4xx, so
  // a release whose git half failed could never be retried — the retry died on the leftover
  // version rather than on whatever actually went wrong the first time.
  it('reuses an existing version instead of POSTing a duplicate', async () => {
    mocks.findVersionByName.mockResolvedValue(version({ description: 'first cut' }))

    const result = await run('first cut')

    expect(mocks.createJiraVersion).not.toHaveBeenCalled()
    expect(mocks.updateJiraVersion).not.toHaveBeenCalled()
    expect(result.branchName).toBe('release/v1.2.3')
  })

  // The PR body is composed from the description passed to THIS call, so a silent reuse would
  // leave the PR and the fix version permanently disagreeing with nothing to say which is current.
  it('writes a changed description through to the existing version', async () => {
    mocks.findVersionByName.mockResolvedValue(version({ description: 'stale' }))

    await run('current')

    expect(mocks.updateJiraVersion).toHaveBeenCalledWith({ versionId: '42', description: 'current' }, jiraConfig)
  })

  it('leaves the description alone when the caller supplies none', async () => {
    mocks.findVersionByName.mockResolvedValue(version({ description: 'kept' }))

    await run()

    expect(mocks.updateJiraVersion).not.toHaveBeenCalled()
  })

  describe('the release date', () => {
    it('creates the version with the date and reports what Jira echoed', async () => {
      mocks.findVersionByName.mockResolvedValue(null)
      mocks.createJiraVersion.mockResolvedValue({ success: true, version: version({ releaseDate: '2026-10-28' }) })

      const result = await run('first cut', '2026-10-28')

      expect(mocks.createJiraVersion).toHaveBeenCalledWith(
        expect.objectContaining({ releaseDate: '2026-10-28' }),
        jiraConfig,
      )
      expect(result.releaseDate).toBe('2026-10-28')
    })

    // Byte-identical create body when no date is given: the key is absent, not `undefined`.
    it('sends no releaseDate key on create when none is given, and reports null', async () => {
      mocks.findVersionByName.mockResolvedValue(null)
      mocks.createJiraVersion.mockResolvedValue({ success: true, version: version() })

      const result = await run('first cut')

      expect(mocks.createJiraVersion.mock.calls[0]?.[0]).not.toHaveProperty('releaseDate')
      expect(result.releaseDate).toBeNull()
    })

    // The confirm summary the human approved shows the date, so Jira has to end up matching it.
    it('writes a differing date through to the existing version in one PUT', async () => {
      mocks.findVersionByName.mockResolvedValue(version({ description: 'kept', releaseDate: '2026-10-01' }))
      mocks.updateJiraVersion.mockResolvedValue({ success: true, version: version({ releaseDate: '2026-10-28' }) })

      const result = await run('kept', '2026-10-28')

      expect(mocks.updateJiraVersion).toHaveBeenCalledOnce()
      expect(mocks.updateJiraVersion).toHaveBeenCalledWith({ versionId: '42', releaseDate: '2026-10-28' }, jiraConfig)
      expect(result.releaseDate).toBe('2026-10-28')
    })

    it('writes a differing date and a differing description in the same PUT', async () => {
      mocks.findVersionByName.mockResolvedValue(version({ description: 'stale' }))
      mocks.updateJiraVersion.mockResolvedValue({ success: true, version: version({ releaseDate: '2026-10-28' }) })

      await run('current', '2026-10-28')

      expect(mocks.updateJiraVersion).toHaveBeenCalledOnce()
      expect(mocks.updateJiraVersion).toHaveBeenCalledWith(
        { versionId: '42', description: 'current', releaseDate: '2026-10-28' },
        jiraConfig,
      )
    })

    // Creating must not be a way to erase: an absent date leaves the existing one alone.
    it('never clears an existing date when the caller supplies none', async () => {
      mocks.findVersionByName.mockResolvedValue(version({ description: 'kept', releaseDate: '2026-10-01' }))

      const result = await run('kept')

      expect(mocks.updateJiraVersion).not.toHaveBeenCalled()
      expect(result.releaseDate).toBe('2026-10-01')
    })

    it('does not PUT when the given date equals the existing one', async () => {
      mocks.findVersionByName.mockResolvedValue(version({ releaseDate: '2026-10-28' }))

      await run(undefined, '2026-10-28')

      expect(mocks.updateJiraVersion).not.toHaveBeenCalled()
    })
  })

  // Re-cutting a release whose version was already delivered is a plausible mistake; attaching a
  // fresh branch to a closed version would misreport what that version shipped.
  it.each([
    ['released', { released: true }],
    ['archived', { archived: true }],
  ])('refuses to reuse a %s version', async (state, overrides) => {
    mocks.findVersionByName.mockResolvedValue(version(overrides))

    const error = await expectRejection(run('retry'))

    expect(error).toBeInstanceOf(OperationError)
    expect(error.message).toContain(state)
    expect(mocks.createReleaseBranch).not.toHaveBeenCalled()
  })
})
