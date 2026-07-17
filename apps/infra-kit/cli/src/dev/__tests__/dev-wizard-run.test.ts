import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from 'src/lib/logger'

import { MANUAL_CHOICE, WIZARD_CMUX_VAR, auditManualPlan, loadBackends, runWizardFlow } from '../dev-wizard-run.js'
import type { WizardChoice, WizardPrompts } from '../dev-wizard-run.js'
import type { WizardModel } from '../dev-wizard.js'

/** One full-stack app whose frontend proxies a two-option `/api` → its own `client-api` backend. */
const model = (presets: string[] = []): WizardModel => {
  return {
    apps: [
      {
        name: 'client',
        hasApi: true,
        hasUi: true,
        apiPackage: 'client-api',
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
    presets,
    environments: ['dev', 'staging'],
  }
}

/** A model with a single standalone api-only app (a backend the checkbox offers directly). */
const apiOnlyModel = (): WizardModel => {
  return {
    apps: [{ name: 'worker', hasApi: true, hasUi: false, apiPackage: 'worker-api', backends: [] }],
    presets: [],
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

/**
 * Scrub the cmux opt-in before every case: it is a real shell escape hatch, so a developer running the
 * suite with it exported would otherwise push the wizard down the cmux branch and throw on the prompt
 * these scripts deliberately do not answer. Forced absent, never merely unset.
 */
beforeEach(() => {
  vi.stubEnv(WIZARD_CMUX_VAR, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Opt back in, for the cases that exercise the (currently disabled) cmux derivation. */
const enableCmuxPrompt = (): void => {
  vi.stubEnv(WIZARD_CMUX_VAR, '1')
}

describe('runWizardFlow — manual branch', () => {
  it('cmux prompt disabled by default: the question is never asked and the plan stays in-process', async () => {
    const result = await runWizardFlow(
      scripted({
        checkbox: [['Which packages', ['client/ui']]],
        select: [['local or cloud', 'local']],
        // No 'cmux' entry: `scripted` throws on an unscripted prompt, so asking at all fails here.
        confirm: [['watch', false]],
      }),
      model(),
    )

    expect(result?.cmux).toBe(false)
    expect(result?.include).toBeUndefined()
  })

  it('full-stack local: frontend + /api answered local → presetDef with both parts, no env prompt', async () => {
    const result = await runWizardFlow(
      scripted({
        checkbox: [['Which packages', ['client/ui']]],
        select: [['local or cloud', 'local']],
        confirm: [['watch', false]],
      }),
      model(),
    )

    expect(result?.presetDef?.apps).toEqual({ 'client/ui': { proxy: { '/api': 'local' } }, 'client/api': {} })
    expect(result?.watch).toBe(false)
    expect(result?.cmux).toBe(false)
  })

  it('frontend cloud: /api answered cloud → cloud env prompt, presetDef drops the backend', async () => {
    const result = await runWizardFlow(
      scripted({
        checkbox: [['Which packages', ['client/ui']]],
        select: [
          ['local or cloud', 'cloud'],
          ['environment', 'staging'],
        ],
        confirm: [['watch', false]],
      }),
      model(),
    )

    expect(Object.keys(result?.presetDef?.apps ?? {})).toEqual(['client/ui'])
    expect(result?.presetDef?.apps?.['client/ui']).toEqual({ proxy: { '/api': 'cloud' } })
    expect(process.env.INFRA_KIT_ENV).toBe('staging')
  })

  it('cmux: returns an include of the launched API apps, PLUS the presetDef that pins the parts of each pane', async () => {
    enableCmuxPrompt()

    const result = await runWizardFlow(
      scripted({
        checkbox: [['Which packages', ['client/ui']]],
        select: [['local or cloud', 'local']],
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

  it('cmux: a standalone api-only selection carries only that backend, so no unticked ui can start', async () => {
    // The bug this pins: without `presetDef` the pane ran `--app=worker`, which resolves to the default
    // star preset (every app, every part) narrowed by app NAME — silently starting parts not ticked here.
    enableCmuxPrompt()

    const result = await runWizardFlow(
      scripted({
        checkbox: [['Which packages', ['worker/api']]],
        confirm: [
          ['watch', false],
          ['cmux', true],
        ],
      }),
      apiOnlyModel(),
    )

    expect(result?.include).toEqual(['worker'])
    expect(Object.keys(result?.presetDef?.apps ?? {})).toEqual(['worker/api'])
  })

  it('cmux with no local backends falls back to in-process (never runs all api apps)', async () => {
    enableCmuxPrompt()

    const result = await runWizardFlow(
      scripted({
        checkbox: [['Which packages', ['client/ui']]],
        select: [
          ['local or cloud', 'cloud'],
          ['environment', 'dev'],
        ],
        confirm: [
          ['watch', false],
          ['cmux', true],
        ],
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

  it('cloud route with no env token loaded backs out cleanly instead of crashing on an empty select', async () => {
    // Regression (B1): with `environments: []`, the real `@inquirer/select` would be handed zero choices and
    // throw `No selectable choices` — a raw stack on first run. The guard must return null BEFORE the env
    // prompt: this script deliberately omits an 'environment' answer, so if the select were reached the
    // scripted seam would throw `unscripted prompt`. A clean null therefore proves the guard fired first.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const noEnvModel: WizardModel = { ...model(), environments: [] }

    const result = await runWizardFlow(
      scripted({
        checkbox: [['Which packages', ['client/ui']]],
        select: [['local or cloud', 'cloud']],
        confirm: [['watch', false]],
      }),
      noEnvModel,
    )

    expect(result).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('env-load'))
    warn.mockRestore()
  })

  it('offers only the frontend (full-stack api is launched via a route, not the checkbox), unchecked', async () => {
    // Manual is opt-in: pre-checking meant the fast path (hit enter) booted the whole monorepo — the
    // opposite of why someone picks "Manual" over a preset. A full-stack `client/api` is NOT a checkbox
    // choice; it launches by answering a route local. This seam answers the checkbox the way inquirer
    // does — with the pre-checked choices — so the default is what's asserted.
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
    ).toEqual(['client/ui'])
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
        select: [
          ['Start from a preset', MANUAL_CHOICE],
          ['local or cloud', 'local'],
        ],
        checkbox: [['Which packages', ['client/ui']]],
        confirm: [['watch', false]],
      }),
      model(['full']),
    )

    expect(result?.presetDef?.apps?.['client/api']).toEqual({})
  })
})

describe('loadBackends', () => {
  const tmpDirs: string[] = []

  const makeUiDir = (config: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-loadbackends-'))

    tmpDirs.push(dir)
    fs.writeFileSync(path.join(dir, 'infra-kit.config.ts'), config)

    return dir
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()

      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades a throwing config to zero backends with a named warning, rather than rejecting', async () => {
    // Regression (B2): a real `infra-kit.config.ts` whose default throws at load time (an import-time error,
    // the same class as a schema-invalid config). A NON-mocked fixture — loadDev really imports it — so this
    // is not a false-green spy. The wizard's gather must catch this per-app; without the guard the whole
    // `Promise.all` rejects and every OTHER app in the monorepo becomes unreachable.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const dir = makeUiDir('export default () => { throw new Error("boom-config") }')

    const backends = await loadBackends(dir, 'broken', new Map())

    expect(backends).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken'))
    warn.mockRestore()
  })

  it('returns backends for a valid config (guard does not swallow the happy path)', async () => {
    const dir = makeUiDir(
      'export default { dev: { proxy: { templates: { local: "http://{package}.localhost", cloud: "https://{env}.acme.dev" }, routes: { "/api": { packageName: "acme-api", from: ["local"] } } } } }',
    )

    const backends = await loadBackends(dir, 'acme', new Map([['acme-api', 'acme']]))

    expect(backends).toEqual([
      {
        packageName: 'acme-api',
        routes: [{ path: '/api', localCapable: true, cloudCapable: false, default: undefined }],
        localCapable: true,
        cloudCapable: false,
        ownerApp: 'acme',
      },
    ])
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
          backends: [
            {
              packageName: 'ghost-api',
              routes: [{ path: '/api', localCapable: true, cloudCapable: false }],
              localCapable: true,
              cloudCapable: false,
              ownerApp: undefined,
            },
          ],
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
