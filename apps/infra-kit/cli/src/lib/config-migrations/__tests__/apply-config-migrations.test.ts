import { describe, expect, it } from 'vitest'

import { applyConfigMigrations } from '../apply-config-migrations'
import { CONFIG_MIGRATIONS } from '../registry'

describe('applyConfigMigrations', () => {
  it('folds the registry in its declared order', () => {
    expect(
      CONFIG_MIGRATIONS.map((migration) => {
        return migration.id
      }),
    ).toEqual(['strip-legacy-ide-mode', 'strip-retired-zed-ide', 'drop-environments-key', 'drop-dev-proxy-key'])
  })

  it('accumulates one note per changed step, in registry order', () => {
    const { changed, result, notes } = applyConfigMigrations({
      environments: ['dev'],
      devProxy: { port: 4443 },
      ide: { provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: 'ws' } },
      worktrees: { openInOrca: true },
    })

    expect(changed).toBe(true)
    expect(result).toEqual({
      ide: { provider: 'cursor', config: { workspaceConfigPath: 'ws' } },
      worktrees: { openInOrca: true },
    })
    expect(notes).toEqual([
      'legacy "mode"',
      'the retired "environments" key (deploy targets now come from each workflow\'s workflow_dispatch options, auth from the token store)',
      'the retired "devProxy" key (dev URLs are port-free https://<release>.<package>.localhost)',
    ])
  })

  it('collects only the notes of the steps that changed something', () => {
    const { notes } = applyConfigMigrations({ ide: { provider: 'zed', config: {} } })

    expect(notes).toEqual(['the retired "zed" provider'])
  })

  it('returns the same reference, changed:false and no notes for a clean config', () => {
    const parsed = {
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      ide: { provider: 'cursor', config: { workspaceConfigPath: 'ws' } },
    }

    const outcome = applyConfigMigrations(parsed)

    expect(outcome).toEqual({ changed: false, result: parsed, notes: [] })
    expect(outcome.result).toBe(parsed)
  })

  it('is idempotent: applying twice equals applying once', () => {
    const once = applyConfigMigrations({
      environments: ['dev'],
      devProxy: {},
      ide: [{ provider: 'zed', config: { mode: 'windows' } }],
    })
    const twice = applyConfigMigrations(once.result)

    expect(once.changed).toBe(true)
    expect(once.result).toEqual({})
    expect(twice).toEqual({ changed: false, result: once.result, notes: [] })
    expect(twice.result).toBe(once.result)
  })

  it('never mutates the input', () => {
    const parsed = { environments: ['dev'], ide: { provider: 'zed', config: {} } }
    const snapshot = structuredClone(parsed)

    applyConfigMigrations(parsed)

    expect(parsed).toEqual(snapshot)
  })
})
