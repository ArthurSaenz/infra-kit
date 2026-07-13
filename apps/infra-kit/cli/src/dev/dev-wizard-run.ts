/**
 * Impure driver for the interactive `infra-kit dev` wizard: filesystem/config discovery, the inquirer
 * prompt flow (step-0 preset-or-manual, then the manual matrix), the pre-flight proxy audit, and the
 * `commandEcho` teaching line. The pure answer→plan mapping lives in {@link file://./dev-wizard.ts}.
 *
 * Prompts are behind the injectable {@link WizardPrompts} seam so the flow is testable without a TTY.
 * This module is reached ONLY from the bare-invocation TTY branch of the entry point; every flagged /
 * non-TTY / `--json` / MCP invocation bypasses it entirely.
 */
import inquirerCheckbox from '@inquirer/checkbox'
import inquirerConfirm from '@inquirer/confirm'
import inquirerSelect, { Separator } from '@inquirer/select'
import path from 'node:path'
import process from 'node:process'

import { discoverApiApps, discoverUiApps, findMonorepoRoot } from 'src/dev/discovery'
import { commandEcho } from 'src/lib/command-echo'
import { INFRA_KIT_ENV_VAR } from 'src/lib/constants'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import type { DevPreset } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { loadDev } from 'src/lib/vite/vite'

import { deriveManualPlan, equivalentCommand } from './dev-wizard.js'
import type { DerivedPlan, ManualSelection, ProxyBackend, WizardApp, WizardModel } from './dev-wizard.js'
import { validatePresetProxy } from './presets.js'
import type { DiscoveredParts, PresetProxyContext } from './presets.js'

/** A wizard prompt choice — all values are strings, so the seam needs no generics. */
export interface WizardChoice {
  name: string
  value: string
  description?: string
  checked?: boolean
  disabled?: boolean | string
}

/**
 * Injectable prompt seam (a string-valued subset of `@inquirer/*`). The default implementation
 * ({@link defaultPrompts}) delegates to the real prompts, rendering to stderr so the dev-server's
 * stdout stays clean. Tests pass a scripted object.
 */
export interface WizardPrompts {
  select: (cfg: { message: string; choices: (WizardChoice | Separator)[]; default?: string }) => Promise<string>
  checkbox: (cfg: { message: string; choices: WizardChoice[] }) => Promise<string[]>
  confirm: (cfg: { message: string; default?: boolean }) => Promise<boolean>
}

/**
 * Shared `@inquirer/*` context. Rendered to stderr (mirrors the bare-`infra-kit` command palette).
 *
 * `clearPromptOnDone` erases each answered prompt instead of leaving a `✔ <question> <answer>` line
 * behind, so the wizard collapses to nothing once it finishes and the dev-server's ready header lands
 * at the top of a clean screen. The choices are not lost: {@link echoManual} / {@link runPresetBranch}
 * print the equivalent flag command, which is the durable record of what was picked.
 */
const promptContext = { output: process.stderr, clearPromptOnDone: true }

/** Real `@inquirer/*` prompts, rendered to stderr and erased once answered. */
export const defaultPrompts: WizardPrompts = {
  select: (cfg) => {
    return inquirerSelect({ message: cfg.message, choices: cfg.choices, default: cfg.default }, promptContext)
  },
  checkbox: (cfg) => {
    return inquirerCheckbox({ message: cfg.message, choices: cfg.choices }, promptContext)
  },
  confirm: (cfg) => {
    return inquirerConfirm({ message: cfg.message, default: cfg.default }, promptContext)
  },
}

/** What the wizard hands back to the entry point (merged into `DevServerOptions`), or null on cancel. */
export interface WizardResult {
  /** Named preset (preset branch) — passed through as `options.preset`. */
  preset?: string
  /** In-memory preset (manual branch, non-cmux) — passed through as `options.presetDef`. */
  presetDef?: DevPreset
  /**
   * App-name include list for the cmux path only: which discovered API apps get a pane. Paired with
   * `presetDef`, which tells each pane the exact parts to run. An app selected UI-only gets no pane
   * (cmux panes are opened per API app). Unset for the non-cmux manual path.
   */
  include?: string[]
  watch: boolean
  cmux: boolean
}

/** Group one frontend's `dev.proxy.routes` into {@link ProxyBackend}s keyed by backend package. */
const groupBackends = (
  routes: Record<string, { packageName: string; from: readonly string[] }>,
  ownerByPkg: Map<string, string>,
): ProxyBackend[] => {
  const byPkg = new Map<string, ProxyBackend>()

  for (const [route, def] of Object.entries(routes)) {
    const existing = byPkg.get(def.packageName)
    const localCapable = def.from.includes('local')

    if (existing) {
      existing.routes.push(route)
      existing.localCapable = existing.localCapable || localCapable
    } else {
      byPkg.set(def.packageName, {
        packageName: def.packageName,
        routes: [route],
        localCapable,
        ownerApp: ownerByPkg.get(def.packageName),
      })
    }
  }

  return [...byPkg.values()]
}

/** Discover apps + configs and assemble the {@link WizardModel} (backends resolved per frontend). */
export const gatherWizardModel = async (root: string): Promise<WizardModel> => {
  const apiApps = discoverApiApps(root)
  const uiApps = discoverUiApps(root)
  const config = await getInfraKitConfig()

  const ownerByPkg = new Map(
    apiApps.map((a) => {
      return [a.packageName, a.name] as const
    }),
  )
  const apiPkgByName = new Map(
    apiApps.map((a) => {
      return [a.name, a.packageName] as const
    }),
  )
  const uiNames = new Set(
    uiApps.map((a) => {
      return a.name
    }),
  )
  const apiNames = new Set(
    apiApps.map((a) => {
      return a.name
    }),
  )
  const allNames = [...new Set([...apiNames, ...uiNames])].sort()

  const apps: WizardApp[] = await Promise.all(
    allNames.map(async (name): Promise<WizardApp> => {
      const hasUi = uiNames.has(name)
      const routes = hasUi ? (await loadDev(path.join(root, 'apps', name, 'ui')))?.proxy?.routes : undefined

      return {
        name,
        hasApi: apiNames.has(name),
        hasUi,
        apiPackage: apiPkgByName.get(name),
        backends: routes ? groupBackends(routes, ownerByPkg) : [],
      }
    }),
  )

  return { apps, presets: Object.keys(config.devServersPresets ?? {}), environments: config.environments }
}

/**
 * Build the flat `<app>/<part>` checkbox choices, grouped per app as `ui` then `api`. A frontend choice
 * carries a description of the routes it proxies, so ticking the matching api part reads as "run that
 * route locally". This is the checkbox the user directly picks their targets from.
 *
 * Nothing starts checked: the manual branch is opt-in, so a run only ever launches what was explicitly
 * ticked. Pre-checking every part would make the fast path (accept the defaults) boot the whole monorepo
 * — the exact opposite of why someone reached for "Manual" over a preset.
 */
const buildPartChoices = (model: WizardModel): WizardChoice[] => {
  const choices: WizardChoice[] = []

  for (const app of model.apps) {
    if (app.hasUi) {
      const routes = app.backends.flatMap((b) => {
        return b.routes
      })
      const description = routes.length > 0 ? `frontend — proxies ${[...routes].sort().join(', ')}` : 'frontend'

      choices.push({ name: `${app.name}/ui`, value: `${app.name}/ui`, description })
    }
    if (app.hasApi) {
      choices.push({ name: `${app.name}/api`, value: `${app.name}/api`, description: 'backend' })
    }
  }

  return choices
}

/** Build the audit context from the gathered model (no re-reading of configs). */
const buildAuditContext = (model: WizardModel): PresetProxyContext => {
  const discovered: DiscoveredParts = {
    api: model.apps
      .filter((a) => {
        return a.hasApi
      })
      .map((a) => {
        return a.name
      }),
    ui: model.apps
      .filter((a) => {
        return a.hasUi
      })
      .map((a) => {
        return a.name
      }),
  }
  const apiPkgByApp: Record<string, string> = {}
  const routeToPkg = new Map<string, string>()

  for (const app of model.apps) {
    // Map EVERY discovered api app to its own api package — including api-only apps a frontend proxies
    // to cross-app — so `launchedPkgs` in validatePresetProxy is faithful (mirrors preset-proxy-check.ts).
    // Deriving this from proxy backends alone would miss api-only owners and false-positive the audit.
    if (app.apiPackage != null) apiPkgByApp[app.name] = app.apiPackage
    for (const b of app.backends) {
      for (const route of b.routes) {
        routeToPkg.set(`${app.name} ${route}`, b.packageName)
      }
    }
  }

  return {
    discovered,
    apiPkgByApp,
    routePkg: (app, route) => {
      return routeToPkg.get(`${app} ${route}`)
    },
  }
}

/**
 * Run the assembled plan through the SAME proxy-locality rule the root audit uses. Returns issue
 * messages (empty when clean). Catches a `local` override whose backend won't launch — the wizard's
 * derivation launches owners, so a hit means the backend has no discoverable owning app.
 */
export const auditManualPlan = (presetDef: DevPreset, model: WizardModel): string[] => {
  return validatePresetProxy({ __wizard__: presetDef }, buildAuditContext(model)).map((i) => {
    return i.message
  })
}

/** The manual-branch flow: app + per-app proxy + env + watch + cmux → audited plan → echo. */
const runManualBranch = async (prompts: WizardPrompts, model: WizardModel): Promise<WizardResult | null> => {
  if (model.apps.length === 0) {
    logger.warn('No apps discovered to run.')

    return null
  }

  const selectedTargets = await prompts.checkbox({ message: '📦 Which packages?', choices: buildPartChoices(model) })

  if (selectedTargets.length === 0) {
    logger.warn('No packages selected.')

    return null
  }

  const watch = await prompts.confirm({ message: '👀 Rebuild & restart on save (watch)?', default: false })
  const cmux = await prompts.confirm({ message: '🧩 Run each app in its own cmux pane?', default: false })

  const selection: ManualSelection = { targets: selectedTargets, watch, cmux }
  const plan = deriveManualPlan(selection, model)

  if (plan.anyCloudRoute) {
    selection.env = await prompts.select({
      message: '☁️  Point cloud routes at which environment?',
      choices: model.environments.map((e) => {
        return { name: e, value: e }
      }),
    })
    process.env[INFRA_KIT_ENV_VAR] = selection.env
  }

  const issues = auditManualPlan(plan.presetDef, model)

  if (issues.length > 0) {
    logger.warn('⚠️  Proxy audit found issues with this selection:')
    for (const issue of issues) {
      logger.warn(`   • ${issue}`)
    }

    return null
  }

  echoManual(plan, selection, model)

  // cmux opens one pane per selected API app. `include` picks WHICH apps get a pane; `presetDef` tells
  // each pane exactly which of its parts to run. Without the latter a pane runs `--app=<name>`, which
  // expands to every part the app has — silently starting a UI the user just unticked.
  const apiApps = plan.targetKeys
    .filter((k) => {
      return k.endsWith('/api')
    })
    .map((k) => {
      return k.split('/')[0]!
    })

  // An empty include would collapse to `null` in `normalizeAppInclude` and make cmux run EVERY api app,
  // so a cmux run with no selected backends (e.g. an all-frontend selection) falls back to in-process.
  if (cmux && apiApps.length > 0) {
    return { include: apiApps, presetDef: plan.presetDef, watch, cmux: true }
  }

  if (cmux) {
    logger.info('ℹ️  cmux needs at least one local backend (panes are backend-only) — running in-process instead.')
  }

  return { presetDef: plan.presetDef, watch, cmux: false }
}

/** Print the equivalent flag command (and, for a part-level selection, the save-as-preset hint). */
const echoManual = (plan: DerivedPlan, selection: ManualSelection, model: WizardModel): void => {
  commandEcho.start('dev')
  commandEcho.setInteractive()

  const eq = equivalentCommand(plan, selection, model)

  commandEcho.addOption(eq.flags, true)
  commandEcho.print()

  if (!eq.exact) {
    logger.info('ℹ️  This part-level selection has no exact single-flag form — save it as a devPreset to reproduce it.')
  }
}

/** The preset-branch flow: run a named preset, asking only whether to watch (presets can't encode it). */
const runPresetBranch = async (prompts: WizardPrompts, preset: string): Promise<WizardResult> => {
  const watch = await prompts.confirm({ message: '👀 Rebuild & restart on save (watch)?', default: false })

  commandEcho.start('dev')
  commandEcho.setInteractive()
  commandEcho.addOption(preset, true)
  if (watch) commandEcho.addOption('--watch', true)
  commandEcho.print()

  return { preset, watch, cmux: false }
}

/** Sentinel value for the "Manual (custom)" step-0 choice (a preset name can never be empty). */
export const MANUAL_CHOICE = ' manual'

/**
 * Drive the wizard's branch flow over an ALREADY-gathered model (no disk/config access). Split from
 * {@link runDevWizard} so the flow is unit-testable with scripted prompts + a fixture model.
 */
export const runWizardFlow = async (prompts: WizardPrompts, model: WizardModel): Promise<WizardResult | null> => {
  if (model.presets.length === 0) {
    return runManualBranch(prompts, model)
  }

  const choice = await prompts.select({
    message: '🚀 Start from a preset, or configure manually?',
    choices: [
      ...model.presets.map((p) => {
        return { name: p, value: p }
      }),
      new Separator(' '),
      { name: 'Manual (custom)…', value: MANUAL_CHOICE },
    ],
  })

  return choice === MANUAL_CHOICE ? runManualBranch(prompts, model) : runPresetBranch(prompts, choice)
}

/**
 * Gather the model from disk/config, then drive the wizard flow, returning the resolved run options (or
 * null on cancel / empty selection). The entry point calls this on a bare TTY `infra-kit dev`.
 */
export const runDevWizard = async (
  prompts: WizardPrompts = defaultPrompts,
  root: string = findMonorepoRoot(process.cwd()),
): Promise<WizardResult | null> => {
  return runWizardFlow(prompts, await gatherWizardModel(root))
}
