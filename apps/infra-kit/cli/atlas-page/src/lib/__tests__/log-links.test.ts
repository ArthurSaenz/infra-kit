import { describe, expect, it } from 'vitest'

import { makeSnapshot } from '../../testing/snapshot-fixture'
import { runFolderLink, runLogLinks, serviceLogLink } from '../log-links'

describe('log links', () => {
  it('opens an existing service log through its vscode href', () => {
    expect(
      serviceLogLink({
        service: 'shop-api',
        path: '/runs/42/shop-api.log',
        href: 'vscode://file/runs/42/shop-api.log',
        exists: true,
      }),
    ).toEqual({
      label: 'log',
      href: 'vscode://file/runs/42/shop-api.log',
      openId: 'shop-api',
      title: '/runs/42/shop-api.log',
    })
  })

  it('disables a log that has not been written instead of linking to nothing', () => {
    const link = serviceLogLink({
      service: 'admin-ui',
      path: '/runs/42/admin-ui.log',
      href: 'vscode://file/x',
      exists: false,
    })

    expect(link.href).toBeNull()
    expect(link.openId).toBeNull()
    expect(link.title).toContain('not written yet')
  })

  it('disables the log of a backend another runner owns', () => {
    expect(serviceLogLink(null).href).toBeNull()
  })

  it('links the run folder', () => {
    expect(runFolderLink(makeSnapshot().run)).toEqual({
      label: 'run folder',
      href: 'vscode://file/runs/42',
      openId: 'run-folder',
      title: '/runs/42',
    })
  })

  it('lists runner, turbo and watch by name, then the run folder', () => {
    const links = runLogLinks(makeSnapshot())

    expect(
      links.map((link) => {
        return [link.label, link.href !== null]
      }),
    ).toEqual([
      ['runner', true],
      ['turbo', true],
      ['watch', false],
      ['run folder', true],
    ])
  })
})
