import { describe, expect, it } from 'vitest'

import { MANUAL_CHOICE, auditManualPlan, runWizardFlow } from '../dev-wizard-run.js'
import type { WizardChoice, WizardPrompts } from '../dev-wizard-run.js'
import type { WizardModel } from '../dev-wizard.js'

/** One full-stack app whose frontend proxies `/api` → its own `client-api` backend. */
const model = (presets: string[] = []): WizardModel => {
  return {
    apps: [
      {
        name: 'client',
        hasApi: true,
        hasUi: true,
        apiPackage: 'client-api',
        backends: [{ packageName: 'client-api', routes: ['/api'], localCapable: true, ownerApp: 'client' }],
      },
    ],
    presets,
    environments: ['dev', 'staging'],
  }
}

/** A scripted prompt seam that answers by matching a substring of the prompt message. */
const scripted = (script: {
  select?: [string, string][]
  checkbox?: [string, string[]][]
  confirm?: [string, boolean][]
}): WizardPrompts => {
  const pick = <T>(pairs: [string, T][] | undefined, message: string): T => {
    const hit = pairs?.find(([key]) => {
      return message.includes(key)
    })

    if (!hit) throw new Error(`unscripted prompt: ${message}`)

    return hit[1]
  }

  return {
    select: (cfg) => {
      return Promise.resolve(pick(script.select, cfg.message))
    },
    checkbox: (cfg) => {
      return Promise.resolve(pick(script.checkbox, cfg.message))
    },
    confirm: (cfg) => {
      return Promise.resolve(pick(script.confirm, cfg.message))
    },
  }
}

describe('runWizardFlow — manual branch', () => {
  it('full-stack: both parts ticked → presetDef with both parts, no env prompt', async () => {
    const result = await runWizardFlow(
      scripted({
        checkbox: [['Which packages', ['client/ui', 'client/api']]],
        confirm: [
          ['watch', false],
          ['cmux', false],
        ],
      }),
      model(),
    )

    expect(result?.presetDef?.apps).toEqual({ 'client/ui': { proxy: { '/api': 'local' } }, 'client/api': {} })
    expect(result?.watch).toBe(false)
    expect(result?.cmux).toBe(false)
  })

  it('frontend-only: api part unticked → cloud env prompt, presetDef drops /api', async () => {
    const result = await runWizardFlow(
      scripted({
        checkbox: [['Which packages', ['client/ui']]],
        confirm: [
          ['watch', false],
          ['cmux', false],
        ],
        select: [['environment', 'staging']],
      }),
      model(),
    )

    expect(Object.keys(result?.presetDef?.apps ?? {})).toEqual(['client/ui'])
    expect(process.env.INFRA_KIT_ENV).toBe('staging')
  })

  it('cmux: returns an include of the selected API apps, PLUS the presetDef that pins the parts of each pane', async () => {
    const result = await runWizardFlow(
      scripted({
        checkbox: [['Which packages', ['client/ui', 'client/api']]],
        confirm: [
          ['watch', false],
          ['cmux', true],
        ],
      }),
      model(),
    )

    // `include` chooses which apps get a pane; `presetDef` pins the parts each pane runs.
    expect(result?.include).toEqual(['client'])
    expect(result?.cmux).toBe(true)
    expect(Object.keys(result?.presetDef?.apps ?? {}).sort()).toEqual(['client/api', 'client/ui'])
  })

  it('cmux: an api-only selection carries client/api alone, so the pane cannot start the unticked ui', async () => {
    // The bug this pins: without `presetDef` the pane ran `--app=client`, which resolves to the default
    // star preset (every app, every part) narrowed by app NAME — silently starting the UI just unticked here.
    const result = await runWizardFlow(
      scripted({
        checkbox: [['Which packages', ['client/api']]],
        confirm: [
          ['watch', false],
          ['cmux', true],
        ],
      }),
      model(),
    )

    expect(result?.include).toEqual(['client'])
    expect(Object.keys(result?.presetDef?.apps ?? {})).toEqual(['client/api'])
  })

  it('cmux with no local backends falls back to in-process (never runs all api apps)', async () => {
    const result = await runWizardFlow(
      scripted({
        checkbox: [['Which packages', ['client/ui']]],
        confirm: [
          ['watch', false],
          ['cmux', true],
        ],
        select: [['environment', 'dev']],
      }),
      model(),
    )

    // frontend-only + cmux → no backend panes → in-process presetDef, cmux disabled, no empty include.
    expect(result?.cmux).toBe(false)
    expect(result?.include).toBeUndefined()
    expect(Object.keys(result?.presetDef?.apps ?? {})).toEqual(['client/ui'])
  })

  it('empty package selection returns null (clean back-out)', async () => {
    const result = await runWizardFlow(scripted({ checkbox: [['Which packages', []]] }), model())

    expect(result).toBeNull()
  })

  it('offers every part unchecked, so accepting the defaults launches nothing', async () => {
    // Manual is opt-in: pre-checking every part meant the fast path (hit enter) booted the whole
    // monorepo — the opposite of why someone picks "Manual" over a preset. This seam answers the
    // checkbox the way inquirer does — with the pre-checked choices — so the default is what's asserted.
    const offered: WizardChoice[] = []
    const prompts: WizardPrompts = {
      ...scripted({}),
      checkbox: (cfg) => {
        offered.push(...cfg.choices)

        return Promise.resolve(
          cfg.choices
            .filter((c) => {
              return c.checked === true
            })
            .map((c) => {
              return c.value
            }),
        )
      },
    }

    const result = await runWizardFlow(prompts, model())

    expect(
      offered.map((c) => {
        return c.value
      }),
    ).toEqual(['client/ui', 'client/api'])
    expect(
      offered.some((c) => {
        return c.checked === true
      }),
    ).toBe(false)
    expect(result).toBeNull()
  })
})

describe('runWizardFlow — step-0 + preset branch', () => {
  it('picks a named preset and asks only about watch', async () => {
    const result = await runWizardFlow(
      scripted({ select: [['preset', 'full']], confirm: [['watch', true]] }),
      model(['full']),
    )

    expect(result).toEqual({ preset: 'full', watch: true, cmux: false })
  })

  it('choosing Manual at step-0 enters the manual matrix', async () => {
    const result = await runWizardFlow(
      scripted({
        select: [['preset', MANUAL_CHOICE]],
        checkbox: [['Which packages', ['client/ui', 'client/api']]],
        confirm: [
          ['watch', false],
          ['cmux', false],
        ],
      }),
      model(['full']),
    )

    expect(result?.presetDef?.apps?.['client/api']).toEqual({})
  })
})

describe('auditManualPlan', () => {
  it('flags a local override whose backend has no discoverable owner app', () => {
    const ghostModel: WizardModel = {
      apps: [
        {
          name: 'client',
          hasApi: false,
          hasUi: true,
          backends: [{ packageName: 'ghost-api', routes: ['/api'], localCapable: true, ownerApp: undefined }],
        },
      ],
      presets: [],
      environments: ['dev'],
    }

    const issues = auditManualPlan({ apps: { 'client/ui': { proxy: { '/api': 'local' } } } }, ghostModel)

    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]).toContain('ghost-api')
  })

  it('passes a cross-app local backend whose owner is an api-only app (no false positive)', () => {
    // Regression: buildAuditContext must map EVERY api app (incl api-only `payments`) to its package,
    // else validatePresetProxy false-reports the launched `payments-api` as not launched and aborts.
    const crossAppModel: WizardModel = {
      apps: [
        {
          name: 'shop',
          hasApi: false,
          hasUi: true,
          backends: [{ packageName: 'payments-api', routes: ['/pay'], localCapable: true, ownerApp: 'payments' }],
        },
        { name: 'payments', hasApi: true, hasUi: false, apiPackage: 'payments-api', backends: [] },
      ],
      presets: [],
      environments: ['dev'],
    }

    const issues = auditManualPlan(
      { apps: { 'shop/ui': { proxy: { '/pay': 'local' } }, 'payments/api': {} } },
      crossAppModel,
    )

    expect(issues).toEqual([])
  })

  it('passes a clean full-stack selection', () => {
    const issues = auditManualPlan({ apps: { 'client/ui': { proxy: { '/api': 'local' } }, 'client/api': {} } }, model())

    expect(issues).toEqual([])
  })
})
