import { describe, expect, it } from 'vitest'

import { buildPaneCommands } from 'src/dev/cmux-dev'

/**
 * Pure per-pane command construction for `infra-kit dev --cmux`. Each app maps to
 * the single-app primitive `pnpm exec infra-kit dev --app=<name>`, with `--watch`
 * threaded through only when watch mode is on.
 */
describe('buildPaneCommands', () => {
  it('maps each app to the single-app dev primitive (no watch)', () => {
    expect(buildPaneCommands(['client', 'backoffice'], false)).toEqual([
      'pnpm exec infra-kit dev --app=client',
      'pnpm exec infra-kit dev --app=backoffice',
    ])
  })

  it('appends --watch to each command when watch is on', () => {
    expect(buildPaneCommands(['client'], true)).toEqual(['pnpm exec infra-kit dev --app=client --watch'])
  })

  it('returns an empty list for no apps', () => {
    expect(buildPaneCommands([], false)).toEqual([])
  })
})
