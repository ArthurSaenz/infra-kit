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
import { loadDev } from '@slip-stream-kit/config/internal'
import path from 'node:path'
import process from 'node:process'

import { discoverApiApps, discoverUiApps, findMonorepoRoot } from 'src/dev/discovery'
import { commandEcho } from 'src/lib/command-echo'
import { INFRA_KIT_ENV_VAR } from 'src/lib/constants'
import { readTokenStore } from 'src/lib/env-tokens'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import type { DevPreset, ProxySource } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { withEscape } from 'src/lib/prompts/escapable-context'

import { deriveManualPlan, equivalentCommand } from './dev-wizard.js'
import type { DerivedPlan, ManualSelection, ProxyBackend, RouteCap, WizardApp, WizardModel } from './dev-wizard.js'
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

/**
 * Real `@inquirer/*` prompts, rendered to stderr and erased once answered.
 *
 * Every one goes through {@link withEscape}, which binds Esc to cancellation. The wrap is here rather
 * than around the {@link WizardPrompts} seam so the scripted prompts the tests inject stay untouched:
 * the seam is the test boundary, `defaultPrompts` is the only implementation that talks to a terminal.
 *
 * Esc rejects with an `AbortPromptError`, which `entry/cli.ts` catches as a cancellation → exit 0. The
 * wizard therefore needs no cancel branch of its own: a cancelled prompt never returns here at all, so
 * no server is started.
 */
export const defaultPrompts: WizardPrompts = {
  select: (cfg) => {
    return withEscape((context) => {
      return inquirerSelect({ message: cfg.message, choices: cfg.choices, default: cfg.default }, context)
    }, promptContext)
  },
  checkbox: (cfg) => {
    return withEscape((context) => {
      return inquirerCheckbox({ message: cfg.message, choices: cfg.choices }, context)
    }, promptContext)
  },
  confirm: (cfg) => {
    return withEscape((context) => {
      return inquirerConfirm({ message: cfg.message, default: cfg.default }, context)
    }, promptContext)
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
  routes: Record<string, { packageName: string; from: readonly string[]; default?: 'local' | 'cloud' }>,
  ownerByPkg: Map<string, string>,
): ProxyBackend[] => {
  const byPkg = new Map<string, ProxyBackend>()

  for (const [route, def] of Object.entries(routes)) {
    const cap: RouteCap = {
      path: route,
      localCapable: def.from.includes('local'),
      cloudCapable: def.from.includes('cloud'),
      default: def.default,
    }
    const existing = byPkg.get(def.packageName)

    if (existing) {
      existing.routes.push(cap)
      existing.localCapable = existing.localCapable || cap.localCapable
      existing.cloudCapable = existing.cloudCapable || cap.cloudCapable
    } else {
      byPkg.set(def.packageName, {
        packageName: def.packageName,
        routes: [cap],
        localCapable: cap.localCapable,
        cloudCapable: cap.cloudCapable,
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

  // The cloud-env choices are the envs we hold a token for — the same authority as `env-load`, because
  // it is the same question. This picker writes INFRA_KIT_ENV, which `@slip-stream-kit/config/vite`
  // reads to build the cloud backend's URL, and whose only other writer is `env-load` (which cannot run
  // without a Doppler token). Sourcing it from the workflow options instead would put `prod` in the list
  // for everyone — including a developer holding no prod credential — and point a local UI at
  // production. No token, no entry.
  const store = await readTokenStore()

  return {
    apps,
    presets: Object.keys(config.devServersPresets ?? {}),
    environments: Object.keys(store?.envs ?? {}).sort(),
  }
}

/**
 * Build the checkbox choices: one `<app>/ui` per frontend, plus `<app>/api` ONLY for api-only apps
 * (an api with no ui). A full-stack `<app>/api` is deliberately NOT offered — a full-stack backend is
 * launched by choosing `local` for one of its frontend's routes (asked per-route afterwards), so the
 * checkbox stays a pick of frontends + standalone backends.
 *
 * Nothing starts checked: the manual branch is opt-in, so a run only ever launches what was explicitly
 * ticked. Pre-checking every part would make the fast path (accept the defaults) boot the whole monorepo
 * — the exact opposite of why someone reached for "Manual" over a preset.
 */
const buildPartChoices = (model: WizardModel): WizardChoice[] => {
  const choices: WizardChoice[] = []

  for (const app of model.apps) {
    if (app.hasUi) {
      const paths = app.backends.flatMap((b) => {
        return b.routes.map((r) => {
          return r.path
        })
      })
      const description = paths.length > 0 ? `frontend — proxies ${[...paths].sort().join(', ')}` : 'frontend'

      choices.push({ name: `${app.name}/ui`, value: `${app.name}/ui`, description })
    }
    if (app.hasApi && !app.hasUi) {
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
        routeToPkg.set(`${app.name} ${route.path}`, b.packageName)
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

/**
 * Opt back into the cmux question: set to exactly `'1'`. The prompt is temporarily off — the manual
 * branch always runs in-process — but the derivation below is kept whole for when it returns. `--cmux`
 * on the command line is a separate path and stays live either way.
 */
export const WIZARD_CMUX_VAR = 'INFRA_KIT_DEV_WIZARD_CMUX'

const asksCmux = (): boolean => {
  return process.env[WIZARD_CMUX_VAR] === '1'
}

/**
 * Ask, per selected frontend, an EXPLICIT local/cloud choice for every TWO-OPTION route (its `from`
 * lists both). Single-option routes are auto-picked in the pure mapping, so they are never prompted.
 * The answers are keyed `${app}/ui ${routePath}` to match {@link ManualSelection.sources}; the select's
 * default seeds from the route's declared `default` when it has one.
 */
const promptRouteSources = async (
  prompts: WizardPrompts,
  model: WizardModel,
  uiKeys: string[],
): Promise<Record<string, ProxySource>> => {
  const apps = new Map(
    model.apps.map((a) => {
      return [a.name, a] as const
    }),
  )
  const sources: Record<string, ProxySource> = {}

  for (const key of uiKeys) {
    const app = apps.get(key.split('/')[0]!)

    for (const backend of app?.backends ?? []) {
      for (const route of backend.routes) {
        if (!route.localCapable || !route.cloudCapable) continue

        const answer = await prompts.select({
          message: `🔀 ${key} ${route.path} → local or cloud?`,
          choices: [
            { name: 'local (this machine)', value: 'local' },
            { name: 'cloud', value: 'cloud' },
          ],
          default: route.default ?? 'local',
        })

        sources[`${key} ${route.path}`] = answer as ProxySource
      }
    }
  }

  return sources
}

/** Look up a frontend route's capability in the model (for the recap's "only option" annotation). */
const findRouteCap = (model: WizardModel, app: string, routePath: string): RouteCap | undefined => {
  return model.apps
    .find((a) => {
      return a.name === app
    })
    ?.backends.flatMap((b) => {
      return b.routes
    })
    .find((r) => {
      return r.path === routePath
    })
}

/**
 * Print a one-line-per-route recap of what each frontend route resolved to, so the chosen sources are
 * visible before launch. A single-option route is annotated `(only option)` — it was auto-picked, not
 * asked. This is in addition to {@link echoManual}'s pasteable `--target` command.
 */
const recapSources = (plan: DerivedPlan, model: WizardModel): void => {
  const lines: string[] = []

  for (const [key, cfg] of Object.entries(plan.presetDef.apps ?? {})) {
    if (!key.endsWith('/ui') || !cfg.proxy) continue

    const app = key.split('/')[0]!

    for (const [routePath, source] of Object.entries(cfg.proxy)) {
      const cap = findRouteCap(model, app, routePath)
      const suffix = cap && cap.localCapable && cap.cloudCapable ? '' : ' (only option)'

      lines.push(`  ${key} ${routePath} → ${source}${suffix}`)
    }
  }

  if (lines.length === 0) return
  logger.info('Resolved routes:')
  for (const line of [...lines].sort()) {
    logger.info(line)
  }
}

/** The manual-branch flow: frontends + per-route source + env + watch + cmux → audited plan → recap → echo. */
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

  const uiKeys = selectedTargets.filter((t) => {
    return t.endsWith('/ui')
  })
  const sources = await promptRouteSources(prompts, model, uiKeys)

  const watch = await prompts.confirm({ message: '👀 Rebuild & restart on save (watch)?', default: false })
  const cmux = asksCmux()
    ? await prompts.confirm({ message: '🧩 Run each app in its own cmux pane?', default: false })
    : false

  const selection: ManualSelection = { targets: selectedTargets, sources, watch, cmux }
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

  recapSources(plan, model)
  echoManual(plan, selection)

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

/** Print the equivalent (`--target=…`) flag command, plus a save-as-preset ergonomics hint. */
const echoManual = (plan: DerivedPlan, selection: ManualSelection): void => {
  commandEcho.setInteractive()

  const eq = equivalentCommand(plan, selection)

  commandEcho.addOption(eq.flags, true)
  commandEcho.print()

  // The `--target=…` line reproduces the selection exactly; the preset is pure convenience — a short,
  // memorable name instead of retyping the target keys.
  logger.info('ℹ️  Prefer a short name? Save this selection as a devPreset and run `infra-kit dev <name>`.')
}

/** The preset-branch flow: run a named preset, asking only whether to watch (presets can't encode it). */
const runPresetBranch = async (prompts: WizardPrompts, preset: string): Promise<WizardResult> => {
  const watch = await prompts.confirm({ message: '👀 Rebuild & restart on save (watch)?', default: false })

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
