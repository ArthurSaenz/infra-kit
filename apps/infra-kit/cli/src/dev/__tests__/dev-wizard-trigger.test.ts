import { describe, expect, it } from 'vitest'

import { shouldRunWizard } from '../../entry/dev-server.js'
import type { DevCliOptions } from '../../entry/dev-server.js'

describe('shouldRunWizard', () => {
  it('fires on a bare invocation in an interactive TTY', () => {
    expect(shouldRunWizard({}, true, false)).toBe(true)
  })

  it('never fires without a TTY (pipes, CI, non-interactive)', () => {
    expect(shouldRunWizard({}, false, false)).toBe(false)
  })

  it('never fires in --json mode even in a TTY', () => {
    expect(shouldRunWizard({}, true, true)).toBe(false)
  })

  it.each<[string, DevCliOptions]>([
    ['preset', { preset: 'full' }],
    ['--app', { app: 'client' }],
    ['--self', { self: true }],
    ['--cmux', { cmux: true }],
    ['--watch', { watch: true }],
    ['--verbose', { verbose: true }],
    ['--routes', { routes: true }],
  ])('never fires when %s is present (runs directly from flags)', (_label, raw) => {
    expect(shouldRunWizard(raw, true, false)).toBe(false)
  })
})
