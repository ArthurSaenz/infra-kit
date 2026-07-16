import { describe, expect, it } from 'vitest'

import { deriveManualPlan, equivalentCommand } from '../dev-wizard.js'
import type { ManualSelection, WizardModel } from '../dev-wizard.js'

/** A model with one full-stack app whose frontend proxies a two-option `/api` → its own `client-api` backend. */
const CLIENT_MODEL: WizardModel = {
  apps: [
    {
      name: 'client',
      hasApi: true,
      hasUi: true,
      backends: [
        {
          packageName: 'client-api',
          routes: [{ path: '/api', localCapable: true, cloudCapable: true }],
          localCapable: true,
          cloudCapable: true,
          ownerApp: 'client',
        },
      ],
    },
  ],
  presets: [],
  environments: ['dev', 'staging'],
}

const base = (over: Partial<ManualSelection>): ManualSelection => {
  return { targets: [], sources: {}, watch: false, cmux: false, ...over }
}

describe('deriveManualPlan', () => {
  it('full-stack: choosing the frontend + answering its /api local launches both, proxies local', () => {
    const plan = deriveManualPlan(
      base({ targets: ['client/ui'], sources: { 'client/ui /api': 'local' }, env: 'dev' }),
      CLIENT_MODEL,
    )

    expect(plan.targetKeys).toEqual(['client/api', 'client/ui'])
    expect(plan.anyCloudRoute).toBe(false)
    expect(plan.presetDef.apps?.['client/ui']).toEqual({ proxy: { '/api': 'local' } })
    expect(plan.presetDef.apps?.['client/api']).toEqual({})
  })

  it('frontend-with-cloud: answering /api cloud runs only the frontend and flags a cloud route', () => {
    const plan = deriveManualPlan(
      base({ targets: ['client/ui'], sources: { 'client/ui /api': 'cloud' }, env: 'dev' }),
      CLIENT_MODEL,
    )

    expect(plan.targetKeys).toEqual(['client/ui'])
    expect(plan.anyCloudRoute).toBe(true)
    expect(plan.presetDef.apps?.['client/ui']).toEqual({ proxy: { '/api': 'cloud' } })
  })

  it('cross-app local backend: answering a frontend’s route local launches the owning api-only app', () => {
    const model: WizardModel = {
      apps: [
        {
          name: 'shop',
          hasApi: false,
          hasUi: true,
          backends: [
            {
              packageName: 'payments-api',
              routes: [{ path: '/pay', localCapable: true, cloudCapable: true }],
              localCapable: true,
              cloudCapable: true,
              ownerApp: 'payments',
            },
          ],
        },
        { name: 'payments', hasApi: true, hasUi: false, backends: [] },
      ],
      presets: [],
      environments: ['dev'],
    }

    const plan = deriveManualPlan(
      base({ targets: ['shop/ui'], sources: { 'shop/ui /pay': 'local' }, env: 'dev' }),
      model,
    )

    // shop/ui runs, and its /pay local answer launches payments/api via the backend's owner app.
    expect(plan.targetKeys).toEqual(['payments/api', 'shop/ui'])
    expect(plan.anyCloudRoute).toBe(false)
    expect(plan.presetDef.apps?.['shop/ui']).toEqual({ proxy: { '/pay': 'local' } })
  })

  it('backend-only app: ticking an api-only part runs its api with no proxy', () => {
    const model: WizardModel = {
      apps: [{ name: 'worker', hasApi: true, hasUi: false, backends: [] }],
      presets: [],
      environments: ['dev'],
    }

    const plan = deriveManualPlan(base({ targets: ['worker/api'] }), model)

    expect(plan.targetKeys).toEqual(['worker/api'])
    expect(plan.anyCloudRoute).toBe(false)
  })

  it('shared backend: answering one route local reconciles every local-capable route on it to local', () => {
    const model: WizardModel = {
      apps: [
        {
          name: 'client',
          hasApi: true,
          hasUi: true,
          backends: [
            {
              packageName: 'client-api',
              routes: [
                { path: '/api', localCapable: true, cloudCapable: true },
                { path: '/media', localCapable: true, cloudCapable: true },
              ],
              localCapable: true,
              cloudCapable: true,
              ownerApp: 'client',
            },
          ],
        },
      ],
      presets: [],
      environments: ['dev'],
    }

    // /media is individually answered cloud, but /api local pulls the shared backend local → both local.
    const plan = deriveManualPlan(
      base({ targets: ['client/ui'], sources: { 'client/ui /api': 'local', 'client/ui /media': 'cloud' } }),
      model,
    )

    expect(plan.presetDef.apps?.['client/ui']).toEqual({ proxy: { '/api': 'local', '/media': 'local' } })
    expect(plan.anyCloudRoute).toBe(false)
    expect(plan.targetKeys).toEqual(['client/api', 'client/ui'])
  })

  it('single-option route: a cloud-only route is auto-cloud with no source entry', () => {
    const model: WizardModel = {
      apps: [
        {
          name: 'client',
          hasApi: false,
          hasUi: true,
          backends: [
            {
              packageName: 'media-api',
              routes: [{ path: '/media', localCapable: false, cloudCapable: true }],
              localCapable: false,
              cloudCapable: true,
              ownerApp: 'media',
            },
          ],
        },
      ],
      presets: [],
      environments: ['dev'],
    }

    const plan = deriveManualPlan(base({ targets: ['client/ui'] }), model)

    expect(plan.presetDef.apps?.['client/ui']).toEqual({ proxy: { '/media': 'cloud' } })
    expect(plan.anyCloudRoute).toBe(true)
    expect(plan.targetKeys).toEqual(['client/ui'])
  })

  it('cmux flag flows into the preset def', () => {
    const plan = deriveManualPlan(
      base({ targets: ['client/ui'], sources: { 'client/ui /api': 'local' }, cmux: true }),
      CLIENT_MODEL,
    )

    expect(plan.presetDef.cmux).toBe(true)
  })
})

describe('equivalentCommand', () => {
  it('emits --target with every part key for a full-stack (backend-launched) selection', () => {
    const selection = base({ targets: ['client/ui'], sources: { 'client/ui /api': 'local' }, watch: true })
    const plan = deriveManualPlan(selection, CLIENT_MODEL)
    const eq = equivalentCommand(plan, selection)

    // targetKeys are sorted, so api precedes ui.
    expect(eq).toEqual({ flags: '--target=client/api,client/ui --watch' })
  })

  it('emits --target with only the frontend for a cloud-only (no backend) selection', () => {
    const selection = base({ targets: ['client/ui'], sources: { 'client/ui /api': 'cloud' }, cmux: true })
    const plan = deriveManualPlan(selection, CLIENT_MODEL)
    const eq = equivalentCommand(plan, selection)

    // --target is part-level, so a UI-only pick round-trips exactly — no over-launch of client/api.
    expect(eq.flags).toBe('--target=client/ui --cmux')
  })
})
