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

  it('sTILL fires with --no-ui-health — that flag picks a diagnostic, not a run plan', () => {
    // The trap this guards: folding `--no-ui-health` into the "bare" predicate turns `infra-kit dev
    // --no-ui-health` from "open the picker, and skip the frontend probe" into "silently run EVERY app in
    // the repo". A flag that quietly swaps the interactive picker for a whole-monorepo boot is a far bigger
    // surprise than the one that reasoning was trying to avoid. The wizard carries the flag through instead
    // (see `wizardToOptions`), so the user gets the picker AND the probe stays off.
    expect(shouldRunWizard({ uiHealth: false }, true, false)).toBe(true)
  })
})
