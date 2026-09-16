import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchPRByHead } from 'src/integrations/gh'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { jsonOutput } from 'src/lib/json-output'

import { ghReleaseDeliver } from '../gh-release-deliver'

/**
 * `release deliver` is CLI-only (plan §3.3): under agent mode it refuses REGARDLESS of `--yes`,
 * from a site-local guard placed before the shared `confirmOrExit` — whose own `confirmedCommand`
 * short-circuit must keep working for every other command. A `--json` human without `--yes` still
 * gets the ordinary `confirmation_required`, which is how the guard's placement is pinned.
 */

vi.mock('src/integrations/gh', () => {
  return { fetchPRByHead: vi.fn(), getReleasePRsWithInfo: vi.fn() }
})

vi.mock('src/integrations/jira', () => {
  return { deliverJiraRelease: vi.fn(), loadJiraConfigOptional: vi.fn() }
})

vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return { deleteLocalBranch: vi.fn(), deleteRemoteBranch: vi.fn(), getProjectRoot: vi.fn() }
})

vi.mock('src/lib/worktrees', () => {
  return { removeReleaseWorktreeIfPresent: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

vi.mock('zx', () => {
  return { $: Object.assign(vi.fn(), { quiet: false }) }
})

vi.mock('@inquirer/confirm')

const deliver = (confirmedCommand: boolean): Promise<unknown> => {
  return ghReleaseDeliver({ version: '1.2.5', confirmedCommand }).catch((e: unknown) => {
    return e
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  vi.mocked(fetchPRByHead).mockResolvedValue({ title: 'Release v1.2.5', state: 'OPEN' } as never)
})

afterEach(() => {
  agentMode.source = null
  jsonOutput.enabled = false
})

describe('gh-release-deliver — CLI-only under agent mode', () => {
  it.each(['flag', 'env'] as const)('refuses under source %s even WITH --yes, and touches nothing', async (source) => {
    agentMode.source = source

    const error = await deliver(true)

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toEqual({ status: 'refused', agentMode: source })
    expect((error as StructuredRefusalError).exitCode).toBe(2)
    // The remediation is a hand-off, never an action the agent could take itself.
    expect((error as StructuredRefusalError).remediation).toContain('ask a human to run')
    expect((error as StructuredRefusalError).remediation).not.toContain('--yes')
  })

  it('the refusal sits BEFORE the confirm: a --json human without --yes gets confirmation_required instead', async () => {
    jsonOutput.enabled = true

    const error = await deliver(false)

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({
      status: 'confirmation_required',
      agentMode: null,
    })
    expect((error as StructuredRefusalError).structuredContent.message).toContain('deliver version release/v1.2.5')
  })
})
