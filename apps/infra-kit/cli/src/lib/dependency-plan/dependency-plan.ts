/**
 * What each of the six tools needs, decided once and shared by every surface.
 *
 * `setup --skip-tools` renders these plans and stops; flagless `setup` runs them. Both reach the SAME
 * function, so the report is literally the dry run of the converge rather than a second implementation
 * that agrees with it until it does not.
 */
import { assessRecipe, formatRecipe } from 'src/lib/dependency-install/risk-predicate'
import type { RefusalReason, RiskContext } from 'src/lib/dependency-install/risk-predicate'
import { defaultProbeDeps, probeAll } from 'src/lib/dependency-probe'
import type { DependencyState, ProbeDeps } from 'src/lib/dependency-probe'
import { DEPENDENCY_IDS, installOrder, specFor } from 'src/lib/dependency-registry'
import type { DependencyId, DependencyManager, Recipe } from 'src/lib/dependency-registry'

/** What would happen to one tool, and whether we are allowed to do it. */
export interface DependencyPlan {
  state: DependencyState
  /** `install` when absent, `update` when present, `none` when this manager must not be touched by us. */
  action: 'install' | 'update' | 'none'
  recipe: Recipe | null
  executable: boolean
  refusedBecause: RefusalReason[]
  /**
   * The EXACT context this plan's verdict was reached under, carried so the executor re-assesses against
   * the same thing rather than re-deriving `owner` itself.
   *
   * It was derived twice, and the two derivations disagreed: an absent tool has `manager: 'unknown'`, so
   * passing `state.manager` as the owner made every install refuse as `manager-mismatch` while the plan
   * said it was executable. Install was unreachable, and injecting a fake executor in the tests hid it.
   */
  context: RiskContext
  /** The argv, one runnable line per step — printed whether or not we may run it ourselves. */
  commands: string[]
}

/**
 * The managers observed present, derived from the probe results rather than asked for separately.
 *
 * Only managers some recipe actually DRIVES belong here. `script` is not one: no recipe invokes the aws
 * binary as its own updater any more — that was `aws update`, a subcommand AWS CLI v2 does not have —
 * and the installer re-run that replaced it drives `/bin/bash`, which drives no package manager at all.
 */
export const presentManagers = (states: readonly DependencyState[]): DependencyManager[] => {
  const present: DependencyManager[] = []
  const brewPresent = states.some((state) => {
    return state.id === 'brew' && state.present
  })

  // `brew` present at all means the homebrew manager is available, whoever owns the individual tools.
  if (brewPresent) present.push('homebrew')
  // npm ships with the node running this process, so it is present by construction.
  present.push('npm')

  return present
}

/** Install when absent, update when present. The single place that choice is made. */
const remediationFor = (state: DependencyState): Recipe | null => {
  const spec = specFor(state.id)

  // The PATH, not `state.manager`: the spec re-derives the manager with the same `identify` the probe
  // used, and it is the only thing that can tell aws's two script layouts apart.
  return state.present ? spec.updateFor(state.binRealPath) : spec.bootstrapInstall
}

const planFor = (state: DependencyState, context: RiskContext): DependencyPlan => {
  const recipe = remediationFor(state)

  // `owner` is per-tool; the shared context carries only which managers exist on the box. An ABSENT tool
  // has no owner — `manager: 'unknown'` means "no layout we recognise", not "owned by someone else" —
  // and conflating the two is what would refuse every install as a mismatch.
  const toolContext: RiskContext = { ...context, owner: state.present ? state.manager : null }

  if (recipe === null) {
    return {
      state,
      action: 'none',
      recipe: null,
      executable: false,
      refusedBecause: [],
      commands: [],
      context: toolContext,
    }
  }

  const verdict = assessRecipe(recipe, toolContext)

  return {
    state,
    action: state.present ? 'update' : 'install',
    recipe,
    executable: verdict.executable,
    refusedBecause: verdict.executable ? [] : verdict.reasons,
    commands: formatRecipe(recipe),
    context: toolContext,
  }
}

/** Probe every requested tool and decide what each needs. Reads only — nothing here spawns an installer. */
export const planDependencies = async (
  ids: readonly DependencyId[] = DEPENDENCY_IDS,
  deps: ProbeDeps = defaultProbeDeps(),
): Promise<{ plans: DependencyPlan[]; context: RiskContext }> => {
  // Probing only the requested ids would hide `brew` from `presentManagers`, so a `--tools gh` run would
  // decide brew is absent and refuse a recipe it should have run. Probe all, plan the subset.
  const states = await probeAll(DEPENDENCY_IDS, deps)
  const context: RiskContext = { owner: null, present: presentManagers(states) }
  // Prerequisite order, not declaration order: `git`, `gh` and `doppler` all need `brew`, and today that
  // happens to hold only because `brew` is declared first in the registry. Reordering two rows there
  // would otherwise break installs silently.
  const ordered = installOrder(ids)
  const byId = new Map(
    states.map((state) => {
      return [state.id, state]
    }),
  )
  const plans = ordered
    .filter((id) => {
      return ids.includes(id)
    })
    .map((id) => {
      return planFor(byId.get(id) as DependencyState, context)
    })

  return { plans, context }
}
