/**
 * Which recipes may run unattended, decided by computation rather than by a hand-set flag per recipe.
 *
 * This is the control that ships INSIDE the CLI, so it is the one that still holds on a machine with no
 * `.claude/settings.json`, on a Claude Code older than v2.1.199, and on any host that is not Claude Code
 * at all — every place where the `anthropic/requiresUserInteraction` prompt is silently ignored.
 */
import type { DependencyManager, Recipe } from 'src/lib/dependency-registry'
import { shellLine } from 'src/lib/shell-quote'

/** Why a recipe may not run. `printed` is the only outcome an agent ever sees for a refusal. */
export type RefusalReason = 'needs-sudo' | 'fetches-network-script' | 'manager-absent' | 'manager-mismatch'

export type RiskVerdict = { executable: true } | { executable: false; reasons: RefusalReason[] }

/** What the probe already established about the tool this recipe targets. */
export interface RiskContext {
  /** The manager that currently owns the binary, or null when the tool is absent. */
  owner: DependencyManager | null
  /** Managers observed to be present on this host — `brew` for a keg recipe, `npm` for an npm one. */
  present: readonly DependencyManager[]
}

/**
 * Which manager a recipe drives, read from its own first token.
 *
 * Derived from the argv rather than declared beside it, so a recipe cannot claim to be an `npm` one
 * while invoking `brew`. `null` means the recipe drives no package manager at all, and on that answer
 * {@link detectionRefusals} contributes nothing — so a recipe reaching it is judged by the static
 * conjuncts ALONE.
 */
// That is a fail-open default, and what keeps it safe is a property of the registry rather than of this
// file: every recipe that drives no package manager pipes a script fetched over the network, so
// `staticRefusals` already refuses it. It is not "only the two bootstraps" any more — aws's `--system`
// update re-runs the vendor installer through `sudo /bin/bash` and lands here too. The registry's suite
// asserts the property over every recipe it can produce, which is what makes this branch safe to leave
// permissive rather than something to re-derive here.
const managerDriving = (recipe: Recipe): DependencyManager | null => {
  const commands = new Set(
    recipe.steps.map((step) => {
      return step[0]
    }),
  )

  if (commands.has('brew')) return 'homebrew'
  if (commands.has('npm')) return 'npm'

  return null
}

/**
 * The two STATIC conjuncts. Applied UNCONDITIONALLY to whichever recipe was selected — no branch here
 * reads {@link RiskContext}, the manager, or any probe result.
 *
 * That unconditional application is the whole non-circularity argument. Both dangerous recipes fail on
 * these two, so refusing them never depends on detection having been right; detection can then only
 * ever NARROW what executes, never widen it. Making either of these contingent on `identify()` output
 * is the mutation that must redden (`§8 #6`).
 */
const staticRefusals = (recipe: Recipe): RefusalReason[] => {
  const reasons: RefusalReason[] = []

  if (recipe.needsSudo) reasons.push('needs-sudo')
  if (recipe.fetchesNetworkScript) reasons.push('fetches-network-script')

  return reasons
}

/**
 * The two DETECTION conjuncts: the manager this recipe drives must already be present, and it must be
 * the one that currently owns the binary (or the binary must be absent, in which case the recipe's own
 * manager is by construction the canonical one for it).
 */
// `manager-mismatch` is defence in depth rather than a live discriminator. In production the planner
// derives both sides from the same `binRealPath` — `owner` from the probe's `identify`, the recipe from
// the spec's `updateFor`, which calls that same `identify` — so they cannot disagree by construction.
// The tests hand-build the disagreeing pair. It stays because "cannot disagree" is a property of a
// caller, and this module is the one that must not depend on its callers being right.
const detectionRefusals = (recipe: Recipe, context: RiskContext): RefusalReason[] => {
  const manager = managerDriving(recipe)

  if (manager === null) return []

  const reasons: RefusalReason[] = []

  if (!context.present.includes(manager)) reasons.push('manager-absent')
  if (context.owner !== null && context.owner !== manager) reasons.push('manager-mismatch')

  return reasons
}

/**
 * Is this recipe safe to run without a human watching?
 *
 * Every conjunct is derived — none is a per-recipe boolean saying "this one is fine" — so each gets its
 * own mutation test. A four-way conjunction with one dead term is otherwise indistinguishable from a
 * three-way one.
 */
export const assessRecipe = (recipe: Recipe, context: RiskContext): RiskVerdict => {
  const reasons = [...staticRefusals(recipe), ...detectionRefusals(recipe, context)]

  return reasons.length === 0 ? { executable: true } : { executable: false, reasons }
}

/** The argv a refusal prints, one line per step, so the human can run it themselves verbatim. */
// `shellLine`, not `join(' ')`. Both refused bootstraps carry their whole pipeline in one `bash -c`
// argument, and joining on spaces spills it into the outer command line: the printed
// `/bin/bash -c curl -fsSL <url> | bash` runs curl with no URL and pipes its usage text into a shell.
// "Verbatim" is the contract of this function, and unquoted argv does not meet it.
export const formatRecipe = (recipe: Recipe): string[] => {
  return recipe.steps.map(shellLine)
}
