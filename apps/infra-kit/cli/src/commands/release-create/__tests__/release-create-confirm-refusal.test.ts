import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { jsonOutput } from 'src/lib/json-output'

import { releaseCreate } from '../release-create'

/**
 * The confirm site of `release-create` under agent mode / `--json`: the REAL `confirmOrExit` (the
 * sibling batch suite mocks it) throws `confirmation_required`, and it must reach the caller before
 * any entry is cut. Same mocks as the batch suite, minus that one.
 */

const mocks = vi.hoisted(() => {
  return {
    loadJiraConfig: vi.fn(),
    assertManagementContext: vi.fn(),
    assertBaseBranchSwitchable: vi.fn(),
    assertCleanCheckout: vi.fn(),
    prepareGitForRelease: vi.fn(),
    createSingleRelease: vi.fn(),
  }
})

vi.mock('src/integrations/jira', () => {
  return { loadJiraConfig: mocks.loadJiraConfig }
})

vi.mock('src/lib/git-guard', () => {
  return {
    assertManagementContext: mocks.assertManagementContext,
    assertBaseBranchSwitchable: mocks.assertBaseBranchSwitchable,
    assertCleanCheckout: mocks.assertCleanCheckout,
  }
})

vi.mock('src/lib/release-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/release-utils')>()

  return {
    ...actual,
    prepareGitForRelease: mocks.prepareGitForRelease,
    createSingleRelease: mocks.createSingleRelease,
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

vi.mock('@inquirer/confirm')

const releases = [{ version: '1.2.3', type: 'regular' as const }]

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  mocks.loadJiraConfig.mockResolvedValue({ baseUrl: 'https://jira', token: 't', email: 'e', projectId: 1 })
  mocks.assertManagementContext.mockResolvedValue(undefined)
  mocks.assertBaseBranchSwitchable.mockResolvedValue(undefined)
  mocks.assertCleanCheckout.mockResolvedValue(undefined)
})

afterEach(() => {
  agentMode.source = null
  jsonOutput.enabled = false
})

describe('release-create — the confirm site propagates its refusal', () => {
  it.each([
    {
      label: 'agent mode',
      arm: () => {
        agentMode.source = 'flag'
      },
    },
    {
      label: '--json',
      arm: () => {
        jsonOutput.enabled = true
      },
    },
  ])('under $label an unconfirmed run throws confirmation_required and cuts nothing', async ({ arm }) => {
    arm()

    const error = await releaseCreate({ releases, confirmedCommand: false }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({ status: 'confirmation_required' })
    expect((error as StructuredRefusalError).structuredContent.message).toContain('Create the following 1 release(s)?')
    expect((error as StructuredRefusalError).exitCode).toBe(2)
    expect(mocks.prepareGitForRelease).not.toHaveBeenCalled()
    expect(mocks.createSingleRelease).not.toHaveBeenCalled()
  })

  // The confirm text is what the human approves, so the date Jira will end up with must be in it.
  it('shows the planned release date in the confirm summary', async () => {
    agentMode.source = 'flag'

    const error = await releaseCreate({
      releases: [{ version: '1.2.3', type: 'regular', releaseDate: '2026-10-28' }],
      confirmedCommand: false,
    }).catch((e: unknown) => {
      return e
    })

    expect((error as StructuredRefusalError).structuredContent.message).toContain('v1.2.3 · regular · ships 2026-10-28')
  })
})
