import { describe, expect, it } from 'vitest'

import { OperationError } from '../operation-error'

describe('operationError', () => {
  it('formats a minimal message from operation alone', () => {
    const err = new OperationError(new Error('boom'), { operation: 'do the thing' })

    expect(err).toBeInstanceOf(OperationError)
    expect(err.message).toBe('failed to do the thing')
    expect(err.cause).toBeInstanceOf(Error)
    expect(err.operation).toBe('do the thing')
  })

  it('appends a remediation hint when provided', () => {
    const err = new OperationError(new Error('boom'), {
      operation: 'do the thing',
      remediation: 'check the docs',
    })

    expect(err.message).toBe('failed to do the thing — try: check the docs')
    expect(err.remediation).toBe('check the docs')
  })

  it('extracts a stderr excerpt from a zx ProcessOutput-shaped cause', () => {
    const zxLike = { stderr: 'fatal: not a git repository\n(more lines...)' }
    const err = new OperationError(zxLike, { operation: 'run git' })

    expect(err.message).toContain('stderr: fatal: not a git repository')
  })

  it('truncates oversized stderr excerpts', () => {
    const huge = 'X'.repeat(5000)
    const err = new OperationError({ stderr: huge }, { operation: 'run git' })

    expect(err.message.length).toBeLessThan(300)
  })

  it('prefers an explicit stderrExcerpt over the cause stderr', () => {
    const err = new OperationError(
      { stderr: 'raw zx output' },
      { operation: 'run git', stderrExcerpt: 'curated excerpt' },
    )

    expect(err.message).toContain('stderr: curated excerpt')
    expect(err.message).not.toContain('raw zx output')
  })

  it('preserves the original cause', () => {
    const cause = new Error('underlying')
    const err = new OperationError(cause, { operation: 'do thing' })

    expect(err.cause).toBe(cause)
  })

  it('handles non-Error causes', () => {
    const err = new OperationError('a string', { operation: 'do thing' })

    expect(err.message).toBe('failed to do thing')
    expect(err.cause).toBe('a string')
  })
})
