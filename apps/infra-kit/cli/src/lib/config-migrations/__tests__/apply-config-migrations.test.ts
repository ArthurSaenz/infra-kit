import { describe, expect, it } from 'vitest'

import { applyConfigMigrations } from '../apply-config-migrations'
import { CONFIG_MIGRATIONS } from '../registry'

describe('applyConfigMigrations', () => {
  it('folds the registry in its declared order', () => {
    expect(
      CONFIG_MIGRATIONS.map((migration) => {
        return migration.id
      }),
    ).toEqual([
      'drop-ide-key',
      'drop-environments-key',
      'drop-dev-proxy-key',
      'drop-env-auto-load-key',
      'drop-task-manager-key',
      'drop-dev-presets-key',
      'drop-dev-key',
    ])
  })

  it('accumulates one note per changed step, in registry order', () => {
    const { changed, result, notes } = applyConfigMigrations({
      environments: ['dev'],
      devProxy: { port: 4443 },
      envAutoLoad: { enabled: true, config: 'dev' },
      ide: { provider: 'cursor', config: { mode: 'workspace', workspaceConfigPath: 'ws' } },
      worktrees: { openInOrca: true },
    })

    expect(changed).toBe(true)
    expect(result).toEqual({
      worktrees: { openInOrca: true },
    })
    expect(notes).toEqual([
      'the unused "ide" key (worktrees add/remove no longer edit a Cursor .code-workspace)',
      'the retired "environments" key (deploy targets now come from each workflow\'s workflow_dispatch options, auth from the token store)',
      'the retired "devProxy" key (dev URLs are port-free https://<release>.<package>.localhost)',
      'the retired "envAutoLoad" key (env auto-load is gone — run `env-load -c <config>` in the terminal)',
    ])
  })

  it('collects only the notes of the steps that changed something', () => {
    const { notes } = applyConfigMigrations({ dev: { client: { port: 3000 } } })

    expect(notes).toEqual([
      'the unused "dev" key (a dev server port comes from <APP>_PORT / PORT, else the built-in default)',
    ])
  })

  it('returns the same reference, changed:false and no notes for a clean config', () => {
    const parsed = {
      envManagement: { provider: 'doppler', config: { name: 'p' } },
      worktrees: { openInOrca: true },
    }

    const outcome = applyConfigMigrations(parsed)

    expect(outcome).toEqual({ changed: false, result: parsed, notes: [] })
    expect(outcome.result).toBe(parsed)
  })

  it('is idempotent: applying twice equals applying once', () => {
    const once = applyConfigMigrations({
      environments: ['dev'],
      devProxy: {},
      envAutoLoad: {},
      ide: [{ provider: 'zed', config: { mode: 'windows' } }],
      devServersPresets: { shopLocal: {} },
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
