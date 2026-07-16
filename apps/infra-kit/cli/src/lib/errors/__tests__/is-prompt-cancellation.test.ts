import { describe, expect, it } from 'vitest'

import { isPromptCancellation } from '../is-prompt-cancellation'
import { OperationError } from '../operation-error'
import { PromptCancelledError } from '../prompt-cancelled-error'

/** Mirrors the @inquirer/core error shape (matched by `name`, not class). */
const makeNamedError = (name: string): Error => {
  const err = new Error('prompt ended')

  err.name = name

  return err
}

describe('isPromptCancellation', () => {
  // Ctrl-C ONLY. Inquirer binds no escape key, so it never raises this for Esc —
  // the old name for this test ('a Ctrl-C / Esc ExitPromptError') asserted an
  // attribution the library cannot produce.
  it('detects a Ctrl-C ExitPromptError', () => {
    expect(isPromptCancellation(makeNamedError('ExitPromptError'))).toBe(true)
  })

  // How Esc reaches an @inquirer prompt: withEscape aborts the context's signal
  // (see lib/prompts/escapable-context), and inquirer rejects with this.
  it('detects an AbortPromptError — the shape Esc arrives in', () => {
    expect(isPromptCancellation(makeNamedError('AbortPromptError'))).toBe(true)
  })

  it('detects the Ink pickers own PromptCancelledError', () => {
    expect(isPromptCancellation(new PromptCancelledError())).toBe(true)
  })

  it('unwraps a PromptCancelledError re-wrapped in an OperationError', () => {
    const wrapped = new OperationError(new PromptCancelledError(), {
      operation: 'remove worktrees',
      remediation: 'irrelevant',
    })

    expect(isPromptCancellation(wrapped)).toBe(true)
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
