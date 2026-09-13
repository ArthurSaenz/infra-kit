import { describe, expect, it } from 'vitest'

import { assessRecipe, formatRecipe } from 'src/lib/dependency-install/risk-predicate'
import type { RiskContext } from 'src/lib/dependency-install/risk-predicate'
import { DEPENDENCY_IDS, specFor } from 'src/lib/dependency-registry'
import type { DependencyId, DependencyManager, Recipe } from 'src/lib/dependency-registry'

/**
 * The predicate decides what may run unattended, so the assertions that matter are the ones proving
 * each conjunct is load-bearing. A four-way conjunction with one dead term behaves exactly like a
 * three-way one until the dead term is the only thing standing between an agent and `curl | bash`.
 */

const ALL_MANAGERS: DependencyManager[] = ['npm', 'pnpm', 'yarn', 'bun', 'volta', 'homebrew', 'script', 'unknown']

/** Everything present, nothing owned yet — the permissive context, so refusals here are the recipe's own. */
const fresh = (present: DependencyManager[]): RiskContext => {
  return { owner: null, present }
}

const EVERYTHING: DependencyManager[] = ['homebrew', 'npm', 'script']

/**
 * One layout per id that the spec's own `identify` claims, plus aws's `/usr/local` script layout.
 *
 * `updateFor` now reads the PATH and derives the manager itself, so a test cannot hand it a manager —
 * which is the point: it can no longer be asked about a pair that the probe could never produce.
 */
const OWNED_LAYOUT: Record<DependencyId, string> = {
  brew: '/opt/homebrew/bin/brew',
  aws: '/opt/homebrew/Cellar/awscli/2.17.0/bin/aws',
  gh: '/opt/homebrew/Cellar/gh/2.60.0/bin/gh',
  doppler: '/opt/homebrew/Cellar/doppler/3.68.0/bin/doppler',
  portless: '/usr/local/lib/node_modules/portless/dist/cli.js',
}

const UNOWNED_LAYOUT: Record<DependencyId, string> = {
  brew: '/somewhere/odd/brew',
  aws: '/somewhere/odd/aws',
  gh: '/somewhere/odd/gh',
  doppler: '/somewhere/odd/doppler',
  portless: '/repo/node_modules/portless/dist/cli.js',
}

const AWS_SCRIPT_LAYOUT = '/usr/local/aws-cli/aws'

describe('the two bootstrap recipes are refused on the STATIC conjuncts alone', () => {
  it('refuses the Homebrew bootstrap for both sudo and the piped remote script', () => {
    const verdict = assessRecipe(specFor('brew').bootstrapInstall, fresh(EVERYTHING))

    expect(verdict.executable).toBe(false)
    expect(verdict.executable === false && verdict.reasons).toEqual(
      expect.arrayContaining(['needs-sudo', 'fetches-network-script']),
    )
  })

  it('refuses the aws first install for the piped remote script, though it needs no sudo', () => {
    const verdict = assessRecipe(specFor('aws').bootstrapInstall, fresh(EVERYTHING))

    expect(verdict.executable === false && verdict.reasons).toEqual(['fetches-network-script'])
  })

  it('refuses them under EVERY manager classification, because detection cannot reach them', () => {
    // This is the non-circularity property stated as a test: the static conjuncts are applied
    // unconditionally, so no detection result — right or wrong — can promote these into the
    // executable set. Sweeping every manager is what makes that claim falsifiable.
    for (const owner of [...ALL_MANAGERS, null]) {
      for (const bootstrap of [specFor('brew').bootstrapInstall, specFor('aws').bootstrapInstall]) {
        expect(assessRecipe(bootstrap, { owner, present: ALL_MANAGERS }).executable).toBe(false)
      }
    }
  })
})

describe('the safe recipes execute', () => {
  it.each([
    ['gh', 'homebrew'],
    ['doppler', 'homebrew'],
    ['portless', 'npm'],
  ] as [DependencyId, DependencyManager][])('%s bootstraps under a present %s', (id, manager) => {
    expect(assessRecipe(specFor(id).bootstrapInstall, fresh([manager])).executable).toBe(true)
  })

  // aws's SCRIPT layout is deliberately absent: there is no safe unattended update for one, because the
  // vendor ships no updater other than its own network installer. Its refusal is asserted below.
  it.each([
    ['gh', 'homebrew'],
    ['doppler', 'homebrew'],
    ['aws', 'homebrew'],
    ['portless', 'npm'],
    ['brew', 'homebrew'],
  ] as [DependencyId, DependencyManager][])('%s updates under %s when that manager owns it', (id, manager) => {
    const recipe = specFor(id).updateFor(OWNED_LAYOUT[id])

    expect(recipe).not.toBeNull()
    expect(assessRecipe(recipe as Recipe, { owner: manager, present: [manager] }).executable).toBe(true)
  })
})

describe('the detection conjuncts', () => {
  it('refuses when the manager the recipe drives is not present', () => {
    const verdict = assessRecipe(specFor('gh').bootstrapInstall, { owner: null, present: ['npm'] })

    expect(verdict.executable === false && verdict.reasons).toContain('manager-absent')
  })

  it('refuses when another manager already owns the binary (the split-brain case)', () => {
    // A script-installed aws with `brew upgrade awscli` selected: running it installs a SECOND aws and
    // leaves PATH order to decide which one answers.
    const recipe = specFor('aws').updateFor(OWNED_LAYOUT.aws) as Recipe
    const verdict = assessRecipe(recipe, { owner: 'script', present: ['homebrew', 'script'] })

    expect(verdict.executable === false && verdict.reasons).toContain('manager-mismatch')
  })

  it('allows an absent binary, since the recipe’s own manager is canonical for it', () => {
    expect(assessRecipe(specFor('gh').bootstrapInstall, { owner: null, present: ['homebrew'] }).executable).toBe(true)
  })
})

describe('every unknown classification is refused', () => {
  it.each(DEPENDENCY_IDS)('%s has no executable recipe on an unknown owner', (id) => {
    const spec = specFor(id)

    // An unrecognised layout yields no update recipe at all, and a bootstrap whose manager is not
    // `unknown` mismatches.
    expect(spec.updateFor(UNOWNED_LAYOUT[id])).toBeNull()

    const verdict = assessRecipe(spec.bootstrapInstall, { owner: 'unknown', present: ALL_MANAGERS })

    expect(verdict.executable).toBe(false)
  })
})

// aws's user-scope update reaches this sweep only because `AWS_USER_INSTALL` is the same object as its
// `bootstrapInstall`; `AWS_SCRIPT_LAYOUT` here is the `/usr/local` one. Should those ever diverge, add
// the XDG layout to the list below rather than relying on the identity.
describe('the full sweep: five tools x every layout x every owner classification', () => {
  it('never reports a sudo-requiring or network-fetched recipe as executable, under any classification', () => {
    for (const id of DEPENDENCY_IDS) {
      const spec = specFor(id)
      const recipes: Recipe[] = [spec.bootstrapInstall]

      for (const path of [OWNED_LAYOUT[id], UNOWNED_LAYOUT[id], AWS_SCRIPT_LAYOUT]) {
        const update = spec.updateFor(path)

        if (update !== null) recipes.push(update)
      }

      for (const recipe of recipes) {
        for (const owner of [...ALL_MANAGERS, null]) {
          const verdict = assessRecipe(recipe, { owner, present: ALL_MANAGERS })

          if (recipe.needsSudo || recipe.fetchesNetworkScript) {
            expect({ id, owner, executable: verdict.executable }).toMatchObject({ executable: false })
          }
        }
      }
    }
  })
})

describe('formatRecipe', () => {
  it('prints one runnable line per step', () => {
    expect(formatRecipe(specFor('doppler').bootstrapInstall)).toEqual([
      'brew install gnupg',
      'brew install dopplerhq/cli/doppler',
    ])
  })
})
