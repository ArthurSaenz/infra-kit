import { describe, expect, it } from 'vitest'

import { OperationError } from '../operation-error'
import { StructuredRefusalError } from '../structured-refusal-error'

describe('structuredRefusalError', () => {
  const error = new StructuredRefusalError({ status: 'argument_required', argument: 'version', agentMode: 'flag' }, 2, {
    operation: 'interactive prompt',
    remediation: 'pass --version',
    stderrExcerpt: 'no human to answer it',
  })

  it('is an OperationError, so handler-level catches pass it through instead of rewrapping it', () => {
    // The whole reason it is not a plain `Error` subclass: `release-remove`, `worktrees-add`,
    // `worktrees-sync` and `release-create` catch and rewrap anything else into a generic
    // OperationError, which would drop the payload and the exit code at exactly the sites this serves.
    expect(error).toBeInstanceOf(OperationError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('StructuredRefusalError')
  })

  it('renders its message through the OperationError formatter, losing nothing human-readable', () => {
    expect(error.message).toBe('failed to interactive prompt — stderr: no human to answer it — try: pass --version')
    expect(error.operation).toBe('interactive prompt')
    expect(error.remediation).toBe('pass --version')
    expect(error.stderrExcerpt).toBe('no human to answer it')
  })

  it('carries the payload and the exit code verbatim', () => {
    expect(error.structuredContent).toEqual({ status: 'argument_required', argument: 'version', agentMode: 'flag' })
    expect(error.exitCode).toBe(2)

    const partial = new StructuredRefusalError({ status: 'partial_failure', failed: ['a'] }, 1, { operation: 'x' })

    expect(partial.exitCode).toBe(1)
    expect(partial.structuredContent.status).toBe('partial_failure')
  })
})
