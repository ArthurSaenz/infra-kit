/**
 * The dependency half of `setup`: bring the six external tools to a working state, or — under
 * `--skip-tools` — report what that would take without running any of it.
 *
 * Both entry points reach the SAME {@link planDependencies}, so the probe is the converge's dry run by
 * construction rather than by agreement. The install-or-update choice is made in exactly one place, and
 * this is not it.
 *
 * This is the only copy of the loop. It began as `commands/setup-dependency`'s, which was deleted with
 * that command once `setup` took over its registrations — the fold happened before either name was ever
 * published, so no alias was owed and none was left behind.
 */
import { runRecipe } from 'src/lib/dependency-install'
import type { InstallOutcome } from 'src/lib/dependency-install'
import { planDependencies } from 'src/lib/dependency-plan'
import type { DependencyPlan } from 'src/lib/dependency-plan'
import type { ProbeDeps } from 'src/lib/dependency-probe'
import type { DependencyId, Recipe } from 'src/lib/dependency-registry'

/** `update` skips a tool that is absent; `converge` installs it. The only difference between the two. */
export type SetupMode = 'converge' | 'update'

export interface ToolResult {
  id: DependencyId
  action: 'installed' | 'updated' | 'skipped' | 'refused' | 'failed'
  before: { present: boolean; onPath: boolean; version: string | null; manager: string }
  commands: string[]
  detail: string
}

export interface ConvergeOptions {
  ids: readonly DependencyId[]
  mode: SetupMode
  /** Probe seams, threaded to {@link planDependencies}. Tests inject fixtures; production omits it. */
  probeDeps?: ProbeDeps
  /** The executor. Injected so a test can assert what WOULD have run without running it. */
  run?: typeof runRecipe
}

const skipped = (plan: DependencyPlan, detail: string): ToolResult => {
  return { ...describeBefore(plan), action: 'skipped', commands: plan.commands, detail }
}

const describeBefore = (plan: DependencyPlan): Pick<ToolResult, 'id' | 'before'> => {
  return {
    id: plan.state.id,
    before: {
      present: plan.state.present,
      onPath: plan.state.onPath,
      version: plan.state.version,
      manager: plan.state.manager,
    },
  }
}

/** What this plan means for THIS mode, before any execution is attempted. */
const preflight = (plan: DependencyPlan, mode: SetupMode): ToolResult | null => {
  if (plan.action === 'none') {
    return skipped(plan, `nothing to do: ${plan.state.manager} installs are not managed from here`)
  }

  // The one behavioural difference between the two modes, stated once.
  if (mode === 'update' && plan.action === 'install') {
    return skipped(plan, 'not installed, and --update only updates — drop the flag to install it')
  }

  if (!plan.executable) {
    return {
      ...describeBefore(plan),
      action: 'refused',
      commands: plan.commands,
      detail: `refused (${plan.refusedBecause.join(', ')}) — run the commands printed below yourself`,
    }
  }

  return null
}

const toResult = (plan: DependencyPlan, outcome: InstallOutcome): ToolResult => {
  if (!outcome.ran) {
    return {
      ...describeBefore(plan),
      action: 'refused',
      commands: outcome.commands,
      detail: `refused (${outcome.refusedBecause.join(', ')}) — run the commands printed below yourself`,
    }
  }

  if (!outcome.ok) {
    return {
      ...describeBefore(plan),
      action: 'failed',
      commands: outcome.commands,
      detail: `${outcome.failedStep ?? 'a step'} ${outcome.detail ?? 'failed'}`,
    }
  }

  return {
    ...describeBefore(plan),
    action: plan.action === 'install' ? 'installed' : 'updated',
    commands: outcome.commands,
    detail: plan.action === 'install' ? 'installed' : 'updated',
  }
}

/** Install what is missing and update what is present, serial and in registry order. */
export const convergeDependencies = async (options: ConvergeOptions): Promise<ToolResult[]> => {
  const run = options.run ?? runRecipe
  const { plans } = await planDependencies(options.ids, options.probeDeps)
  const tools: ToolResult[] = []

  // Serial, in registry order, because the recipes have prerequisites: git, gh and doppler all need brew,
  // and doppler's own two steps must not interleave with another tool's.
  for (const plan of plans) {
    const stop = preflight(plan, options.mode)

    if (stop !== null) {
      tools.push(stop)
      continue
    }

    // `plan.recipe` is non-null here: `preflight` returns a stop for `action: 'none'`, which is the only
    // plan that carries a null recipe.
    // `plan.context`, never a fresh derivation: the executor re-assesses, and a second derivation of
    // `owner` here is exactly the bug that made every install refuse as `manager-mismatch`.
    tools.push(toResult(plan, run(plan.recipe as Recipe, plan.context)))
  }

  return tools
}

/**
 * `--skip-tools`: the same plans, rendered and not run.
 *
 * It never reaches an executor — not a stubbed one, not an injected one, none — which is the whole
 * property the flag exists to carry, so there is deliberately no `run` seam on this path to forget to
 * disable. A plan the risk predicate refuses still reports as `refused`, because its argv is exactly
 * what this mode exists to print.
 */
export const probeDependencies = async (ids: readonly DependencyId[], probeDeps?: ProbeDeps): Promise<ToolResult[]> => {
  const { plans } = await planDependencies(ids, probeDeps)

  return plans.map((plan) => {
    return preflight(plan, 'converge') ?? skipped(plan, `would ${plan.action} — nothing was run (--skip-tools)`)
  })
}
