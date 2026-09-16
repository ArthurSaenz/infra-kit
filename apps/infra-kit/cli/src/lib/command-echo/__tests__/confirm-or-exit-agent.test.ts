import confirm from '@inquirer/confirm'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentMode } from 'src/lib/agent-mode'
import { OperationError } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { jsonOutput } from 'src/lib/json-output'
import { setParsedArgv } from 'src/lib/parsed-argv'

import { commandEcho } from '../command-echo'
import { confirmOrExit } from '../confirm-or-exit'

/**
 * The preview-then-execute contract of `confirmOrExit` (plan §3.3): with no human to ask — agent
 * mode, or `--json` — and no `confirmedCommand`, the helper throws a `confirmation_required`
 * refusal that carries the message, the site's plan and the argv that confirms. The sibling file
 * pins the three human outcomes; nothing here may change them.
 */

vi.mock('@inquirer/confirm', () => {
  return { default: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const confirmMock = vi.mocked(confirm)

let exitSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    return undefined
  }) as never)
  setParsedArgv(['node', 'infra-kit', 'release', 'remove', '1.2.3', '--agent', '--json'])
})

afterEach(() => {
  vi.restoreAllMocks()
  agentMode.source = null
  jsonOutput.enabled = false
})

const refusalFrom = async (confirmedCommand: boolean | undefined, plan?: unknown): Promise<StructuredRefusalError> => {
  const error = await confirmOrExit(confirmedCommand, 'Remove release 1.2.3?', { plan }).catch((e: unknown) => {
    return e
  })

  expect(error).toBeInstanceOf(OperationError)
  expect(error).toBeInstanceOf(StructuredRefusalError)

  return error as StructuredRefusalError
}

describe('confirmOrExit — confirmation_required for an agent', () => {
  it('throws before any prompt, with message, plan, rerun (+ --yes) and the source; exit 2', async () => {
    agentMode.source = 'flag'

    const error = await refusalFrom(undefined, { branch: 'release/v1.2.3', pr: 42 })

    expect(error.exitCode).toBe(2)
    expect(error.structuredContent).toEqual({
      status: 'confirmation_required',
      message: 'Remove release 1.2.3?',
      plan: { branch: 'release/v1.2.3', pr: 42 },
      rerun: ['release', 'remove', '1.2.3', '--agent', '--json', '--yes'],
      agentMode: 'flag',
    })
    expect(confirmMock).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('names the re-run command in its remediation', async () => {
    agentMode.source = 'env'

    const error = await refusalFrom(false)

    expect(error.message).toContain('re-run `infra-kit release remove 1.2.3 --agent --json --yes`')
    expect(error.structuredContent.plan).toBeUndefined()
  })

  it('fires under --json with no agent source too, wording --yes and dropping --json as the two exits', async () => {
    jsonOutput.enabled = true

    const error = await refusalFrom(false)

    expect(error.structuredContent.agentMode).toBeNull()
    expect(error.message).toContain('pass `--yes` to confirm, or drop `--json` to be prompted')
  })

  it('short-circuits on confirmedCommand exactly as before — every --yes agent and human', async () => {
    agentMode.source = 'flag'
    jsonOutput.enabled = true

    await expect(confirmOrExit(true, 'Proceed?')).resolves.toBeUndefined()
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('does NOT fire for a human at a TTY: the prompt path is byte-for-byte the old one', async () => {
    confirmMock.mockResolvedValue(true)

    await expect(confirmOrExit(false, 'Proceed?')).resolves.toBeUndefined()
    expect(confirmMock).toHaveBeenCalledWith(
      { message: 'Proceed?' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})
