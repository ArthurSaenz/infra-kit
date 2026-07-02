import { describe, expect, it } from 'vitest'

import { isPromptCancellation } from '../is-prompt-cancellation'
import { OperationError } from '../operation-error'

/** Mirrors the @inquirer/core error shape (matched by `name`, not class). */
const makeNamedError = (name: string): Error => {
  const err = new Error('prompt ended')

  err.name = name

  return err
}

describe('isPromptCancellation', () => {
  it('detects a Ctrl-C / Esc ExitPromptError', () => {
    expect(isPromptCancellation(makeNamedError('ExitPromptError'))).toBe(true)
  })

  it('detects a signal-driven AbortPromptError', () => {
    expect(isPromptCancellation(makeNamedError('AbortPromptError'))).toBe(true)
  })

  it('unwraps a cancellation re-wrapped in an OperationError', () => {
    const wrapped = new OperationError(makeNamedError('ExitPromptError'), {
      operation: 'create worktrees',
      remediation: 'irrelevant',
    })

    expect(isPromptCancellation(wrapped)).toBe(true)
  })

  it('returns false for a genuine operational error', () => {
    expect(isPromptCancellation(new Error('fatal: not a git repository'))).toBe(false)
  })

  it('returns false for an OperationError wrapping a real failure', () => {
    const wrapped = new OperationError(new Error('boom'), { operation: 'create worktrees' })

    expect(isPromptCancellation(wrapped)).toBe(false)
  })

  it('returns false for non-error values', () => {
    expect(isPromptCancellation(undefined)).toBe(false)
    expect(isPromptCancellation(null)).toBe(false)
    expect(isPromptCancellation('ExitPromptError')).toBe(false)
  })
})
