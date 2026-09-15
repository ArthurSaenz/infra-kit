import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { jsonOutput } from 'src/lib/json-output'
import { setParsedArgv } from 'src/lib/parsed-argv'

import { confirmDeploy } from '../confirm-deploy'

/**
 * The ninth confirm site — `confirmDeploy` gates the two `gh-release-deploy-*` dispatches through
 * `withEscape` rather than `confirmOrExit`. It must speak the SAME `confirmation_required` shape
 * (real `command-echo` here; the sibling suite mocks it), with `{ branch, env }` as the plan.
 */

vi.mock('@inquirer/confirm')

beforeEach(() => {
  commandEcho.reset()
  setParsedArgv(['node', 'infra-kit', 'release', 'deploy-all', '--from', 'ci', '--version', '1.2.5', '--env', 'dev'])
})

afterEach(() => {
  agentMode.source = null
  jsonOutput.enabled = false
})

describe('confirmDeploy — confirmation_required for an agent', () => {
  it.each([
    { label: 'agent mode', source: 'flag' as const, json: false },
    { label: '--json', source: null, json: true },
  ])(
    'under $label an unconfirmed call throws the shared shape with the branch and env as plan',
    async ({ source, json }) => {
      agentMode.source = source
      jsonOutput.enabled = json

      const error = await confirmDeploy({ branch: 'release/v1.2.5', env: 'dev' }).catch((e: unknown) => {
        return e
      })

      expect(error).toBeInstanceOf(StructuredRefusalError)
      expect((error as StructuredRefusalError).structuredContent).toEqual({
        status: 'confirmation_required',
        message: 'Deploy release/v1.2.5 → dev via GitHub Actions?',
        plan: { branch: 'release/v1.2.5', env: 'dev' },
        rerun: ['release', 'deploy-all', '--from', 'ci', '--version', '1.2.5', '--env', 'dev', '--yes'],
        agentMode: source,
      })
      expect((error as StructuredRefusalError).exitCode).toBe(2)
    },
  )

  it('still returns true without a prompt when the command is already confirmed', async () => {
    agentMode.source = 'flag'

    await expect(confirmDeploy({ confirmedCommand: true, branch: 'release/v1.2.5', env: 'dev' })).resolves.toBe(true)
  })
})
