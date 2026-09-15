import { afterEach, describe, expect, it, vi } from 'vitest'

import { OperationError } from 'src/lib/errors/operation-error'
import { PromptCancelledError } from 'src/lib/errors/prompt-cancelled-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { emit, jsonOutput } from 'src/lib/json-output'

import { exitForError } from '../exit-for-error'
import type { ExitForErrorDeps } from '../exit-for-error'

/**
 * The top-level catch of `entry/cli.ts`, with the process seams injected. `emit` is the REAL one
 * (with its writer captured) so the "stdout only under --json" property is the module's, not a
 * mock's; `exit` throws a sentinel so a branch that forgets to return is caught by the assertion,
 * not by the process ending.
 */
class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

const harness = () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const info: string[] = []

  const deps: ExitForErrorDeps = {
    exit: (code) => {
      throw new Exited(code)
    },
    emit: (result) => {
      return emit(result, (text) => {
        stdout.push(text)
      })
    },
    logger: {
      info: vi.fn((message: unknown) => {
        info.push(String(message))
      }) as unknown as ExitForErrorDeps['logger']['info'],
      error: vi.fn((message: unknown) => {
        stderr.push(String(message))
      }) as unknown as ExitForErrorDeps['logger']['error'],
    },
  }

  const exitCodeFor = (error: unknown): number => {
    try {
      exitForError(error, deps)
    } catch (caught) {
      if (caught instanceof Exited) return caught.code

      throw caught
    }

    throw new Error('exitForError returned without exiting')
  }

  return { deps, stdout, stderr, info, exitCodeFor }
}

const refusal = new StructuredRefusalError({ status: 'argument_required', argument: 'version', agentMode: 'flag' }, 2, {
  operation: 'interactive prompt',
  remediation: 'pass --version',
})

afterEach(() => {
  jsonOutput.enabled = false
})

describe('exitForError — the entry/cli.ts catch', () => {
  it('a prompt cancellation exits 0 with "Operation cancelled." and no error line (untouched branch)', () => {
    const h = harness()

    expect(h.exitCodeFor(new PromptCancelledError())).toBe(0)
    expect(h.info).toEqual(['Operation cancelled.'])
    expect(h.stderr).toEqual([])
    expect(h.stdout).toEqual([])
  })

  it('a StructuredRefusalError under --json emits the payload to stdout and exits with ITS code', () => {
    jsonOutput.enabled = true

    const h = harness()

    expect(h.exitCodeFor(refusal)).toBe(2)
    expect(h.stdout).toEqual([
      `${JSON.stringify({ status: 'argument_required', argument: 'version', agentMode: 'flag' }, null, 2)}\n`,
    ])
    expect(h.stderr).toEqual([refusal.message])
  })

  it('a StructuredRefusalError WITHOUT --json writes nothing to stdout, logs the message, keeps its code', () => {
    const h = harness()

    expect(h.exitCodeFor(refusal)).toBe(2)
    expect(h.stdout).toEqual([])
    expect(h.stderr).toEqual([refusal.message])
  })

  it('carries exit 1 for a partial_failure refusal', () => {
    const partial = new StructuredRefusalError({ status: 'partial_failure' }, 1, { operation: 'remove worktrees' })

    expect(harness().exitCodeFor(partial)).toBe(1)
  })

  it('a plain OperationError takes the generic branch: exit 1, message on stderr, nothing on stdout', () => {
    jsonOutput.enabled = true

    const h = harness()
    const plain = new OperationError(undefined, { operation: 'x', remediation: 'y' })

    expect(h.exitCodeFor(plain)).toBe(1)
    expect(h.stdout).toEqual([])
    expect(h.stderr).toEqual([plain.message])
  })

  it('a non-Error value is stringified and exits 1', () => {
    const h = harness()

    expect(h.exitCodeFor('boom')).toBe(1)
    expect(h.stderr).toEqual(['boom'])
  })

  it('a cancellation wins over everything, even when it is also a StructuredRefusalError-shaped object', () => {
    // Branch ORDER is the contract: the cancellation branch stays first and untouched.
    const h = harness()
    const cancelled = Object.assign(new PromptCancelledError(), {
      structuredContent: { status: 'refused' },
      exitCode: 2,
    })

    expect(h.exitCodeFor(cancelled)).toBe(0)
  })
})
