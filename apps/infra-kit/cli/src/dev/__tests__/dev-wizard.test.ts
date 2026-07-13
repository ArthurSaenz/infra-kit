import { describe, expect, it } from 'vitest'

import { deriveManualPlan, equivalentCommand } from '../dev-wizard.js'
import type { ManualSelection, WizardModel } from '../dev-wizard.js'

/** A model with one full-stack app whose frontend proxies `/api` → its own `client-api` backend. */
const CLIENT_MODEL: WizardModel = {
  apps: [
    {
      name: 'client',
      hasApi: true,
      hasUi: true,
      backends: [{ packageName: 'client-api', routes: ['/api'], localCapable: true, ownerApp: 'client' }],
    },
  ],
  presets: [],
  environments: ['dev', 'staging'],
}

const base = (over: Partial<ManualSelection>): ManualSelection => {
  return { targets: [], watch: false, cmux: false, ...over }
}

describe('deriveManualPlan', () => {
  it('full-stack: both parts ticked runs both, frontend proxies local to its own api', () => {
    const plan = deriveManualPlan(base({ targets: ['client/ui', 'client/api'], env: 'dev' }), CLIENT_MODEL)

    expect(plan.targetKeys).toEqual(['client/api', 'client/ui'])
    expect(plan.anyCloudRoute).toBe(false)
    expect(plan.presetDef.apps?.['client/ui']).toEqual({ proxy: { '/api': 'local' } })
  })

  it('frontend-only: api part left unticked routes /api to cloud and flags a cloud route', () => {
    const plan = deriveManualPlan(base({ targets: ['client/ui'], env: 'dev' }), CLIENT_MODEL)

    expect(plan.targetKeys).toEqual(['client/ui'])
    expect(plan.anyCloudRoute).toBe(true)
    expect(plan.presetDef.apps?.['client/ui']).toEqual({ proxy: { '/api': 'cloud' } })
  })

  it('cross-app local backend: ticking another app’s api part makes a frontend proxy local to it', () => {
    const model: WizardModel = {
      apps: [
        {
          name: 'shop',
          hasApi: false,
          hasUi: true,
          backends: [{ packageName: 'payments-api', routes: ['/pay'], localCapable: true, ownerApp: 'payments' }],
        },
        { name: 'payments', hasApi: true, hasUi: false, backends: [] },
      ],
      presets: [],
      environments: ['dev'],
    }

    const plan = deriveManualPlan(base({ targets: ['shop/ui', 'payments/api'], env: 'dev' }), model)

    // shop/ui runs, payments/api runs, and shop's /pay route resolves local because payments/api was ticked.
    expect(plan.targetKeys).toEqual(['payments/api', 'shop/ui'])
    expect(plan.anyCloudRoute).toBe(false)
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

  it('cmux flag flows into the preset def', () => {
    const plan = deriveManualPlan(base({ targets: ['client/ui', 'client/api'], cmux: true }), CLIENT_MODEL)

    expect(plan.presetDef.cmux).toBe(true)
  })
})

describe('equivalentCommand', () => {
  it('exact for a whole-app (full-stack) selection', () => {
    const selection = base({ targets: ['client/ui', 'client/api'], watch: true })
    const plan = deriveManualPlan(selection, CLIENT_MODEL)
    const eq = equivalentCommand(plan, selection, CLIENT_MODEL)

    expect(eq).toEqual({ flags: '--app=client --watch', exact: true })
  })

  it('inexact for a part-level (frontend-only) selection', () => {
    const selection = base({ targets: ['client/ui'], cmux: true })
    const plan = deriveManualPlan(selection, CLIENT_MODEL)
    const eq = equivalentCommand(plan, selection, CLIENT_MODEL)

    // client has an api part not launched → --app=client would over-launch, so it is not exact.
    expect(eq.exact).toBe(false)
    expect(eq.flags).toBe('--app=client --cmux')
  })
})
