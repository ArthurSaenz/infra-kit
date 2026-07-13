import { describe, expect, it } from 'vitest'

import { buildTurboWatchFilters } from '../turbo-watch'

describe('buildTurboWatchFilters', () => {
  it('aPI-only: reproduces the historical dep-inclusive `--filter=...<pkg>` vector (byte-identical)', () => {
    expect(buildTurboWatchFilters(['omega-api', 'client-api'], [])).toEqual([
      '--filter=...omega-api',
      '--filter=...client-api',
    ])
  })

  it('uI-only: emits dep-closure-only `<pkg>^...` (never the UI package itself)', () => {
    expect(buildTurboWatchFilters([], ['website-ui', 'backoffice-ui'])).toEqual([
      '--filter=website-ui^...',
      '--filter=backoffice-ui^...',
    ])
  })

  it('mixed: dep-inclusive API filters first, then dep-closure UI filters, order-stable', () => {
    expect(buildTurboWatchFilters(['omega-api'], ['website-ui'])).toEqual([
      '--filter=...omega-api',
      '--filter=website-ui^...',
    ])
  })

  it('empty on both sides → no filters (turbo would watch nothing)', () => {
    expect(buildTurboWatchFilters([], [])).toEqual([])
  })
})
