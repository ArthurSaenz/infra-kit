import { beforeEach, describe, expect, it, vi } from 'vitest'

let lastMessage = ''

const confirmPrompt = vi.fn(async (config: { message: string }) => {
  lastMessage = config.message

  return true
})

vi.mock('@inquirer/confirm', () => {
  return { default: confirmPrompt }
})
vi.mock('src/lib/prompts/escapable-context', () => {
  return {
    withEscape: async (run: (context: unknown) => Promise<boolean>) => {
      return run({})
    },
  }
})
vi.mock('src/lib/command-echo', () => {
  return { commandEcho: { setInteractive: vi.fn(), addOption: vi.fn() } }
})

const { confirmDeploy } = await import('../confirm-deploy')

beforeEach(() => {
  lastMessage = ''
  vi.clearAllMocks()
})

describe('confirmDeploy', () => {
  it('names the runner, not just the branch and env', async () => {
    // Fails against the pre-merge message `Deploy ${branch} → ${env}?`, which named neither the runner
    // nor the artifact — the gap that made `release` vs `local` the only signal of what was shipping.
    await confirmDeploy({ branch: 'release/v1.2.5', env: 'dev' })

    expect(lastMessage).toContain('GitHub Actions')
  })

  it('still names the artifact and the target', async () => {
    await confirmDeploy({ branch: 'release/v1.2.5', env: 'dev' })

    expect(lastMessage).toContain('release/v1.2.5')
    expect(lastMessage).toContain('dev')
  })

  it('never prompts once the command is already confirmed', async () => {
    // The scope limit that must not be misread as a control: `--yes` and every MCP call arrive with
    // `confirmedCommand` already true, so no agent-initiated deploy ever sees the message above.
    await expect(confirmDeploy({ branch: 'dev', env: 'dev', confirmedCommand: true })).resolves.toBe(true)

    expect(confirmPrompt).not.toHaveBeenCalled()
  })
})
