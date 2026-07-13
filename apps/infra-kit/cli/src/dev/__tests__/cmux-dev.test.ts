import { describe, expect, it } from 'vitest'

import { buildPaneCommands, paneTargetsByApp } from 'src/dev/cmux-dev'

/**
 * Pure per-pane command construction for `infra-kit dev --cmux`. A pane with no explicit targets maps to
 * the single-app primitive `pnpm exec infra-kit dev --app=<name>`; a pane carrying targets maps to the
 * part-level `--target=<app>/<part>,…`. `--watch` is threaded through only when watch mode is on.
 */
describe('buildPaneCommands', () => {
  it('maps each app to the single-app dev primitive (no watch)', () => {
    expect(buildPaneCommands([{ app: 'client' }, { app: 'backoffice' }], false)).toEqual([
      'pnpm exec infra-kit dev --app=client',
      'pnpm exec infra-kit dev --app=backoffice',
    ])
  })

  it('appends --watch to each command when watch is on', () => {
    expect(buildPaneCommands([{ app: 'client' }], true)).toEqual(['pnpm exec infra-kit dev --app=client --watch'])
  })

  it('returns an empty list for no apps', () => {
    expect(buildPaneCommands([], false)).toEqual([])
  })

  it('emits --target for a pane with explicit parts, so an unticked part never starts', () => {
    // `--app=client` expands to EVERY part client has. A wizard selection of `client/api` alone must not
    // silently start `client/ui` in that pane — the whole reason `--target` exists.
    expect(buildPaneCommands([{ app: 'client', targets: ['client/api'] }], false)).toEqual([
      'pnpm exec infra-kit dev --target=client/api',
    ])
  })

  it('joins multiple parts of the same app into one --target', () => {
    expect(buildPaneCommands([{ app: 'client', targets: ['client/api', 'client/ui'] }], true)).toEqual([
      'pnpm exec infra-kit dev --target=client/api,client/ui --watch',
    ])
  })

  it('falls back to --app when the targets list is empty (not merely absent)', () => {
    expect(buildPaneCommands([{ app: 'client', targets: [] }], false)).toEqual(['pnpm exec infra-kit dev --app=client'])
  })
})

describe('paneTargetsByApp', () => {
  it('groups concrete target keys by their app', () => {
    const byApp = paneTargetsByApp({ apps: { 'client/api': {}, 'client/ui': {}, 'backoffice/api': {} } })

    expect(byApp.get('client')).toEqual(['client/api', 'client/ui'])
    expect(byApp.get('backoffice')).toEqual(['backoffice/api'])
  })

  it('skips a glob key, which names no single app and cannot address a pane', () => {
    const byApp = paneTargetsByApp({ apps: { '*/api': {}, 'client/ui': {} } })

    expect(byApp.has('*')).toBe(false)
    expect([...byApp.keys()]).toEqual(['client'])
  })

  it('returns an empty map for an absent preset (a plain --cmux run)', () => {
    expect(paneTargetsByApp(undefined).size).toBe(0)
  })
})
