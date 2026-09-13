import { describe, expect, it } from 'vitest'

import { assessRecipe, formatRecipe } from 'src/lib/dependency-install/risk-predicate'
import { DEPENDENCY_IDS, DEPENDENCY_SPECS, installOrder, specFor, supportsPlatform } from 'src/lib/dependency-registry'
import type { DependencyId, DependencyManager, Recipe } from 'src/lib/dependency-registry'

/**
 * The registry is the single source of every name and every argv, so the assertions that matter here
 * are the ones where the FIVE names diverge. A test that only checked "aws has a recipe" would pass
 * just as happily against `brew upgrade aws`, the formula that does not exist.
 */

/**
 * aws's four real layouts. The two SCRIPT ones take different argv, which is why `updateFor` reads the
 * path — and both macOS shapes are here because `/usr/local/aws-cli/aws` is the literal path on the
 * machine whose `setup` run reported `aws update exited 252`.
 */
const AWS_KEG = '/opt/homebrew/Cellar/awscli/2.17.0/bin/aws'
const AWS_SYSTEM_MACOS = '/usr/local/aws-cli/aws'
const AWS_SYSTEM_LINUX = '/usr/local/aws-cli/v2/2.17.0/dist/aws'
const AWS_USER_LOCAL = '/Users/x/.local/share/aws-cli/v2/2.17.0/dist/aws'
const AWS_SYSTEM_LAYOUTS = [AWS_SYSTEM_MACOS, AWS_SYSTEM_LINUX]
const AWS_SCRIPT_LAYOUTS = [...AWS_SYSTEM_LAYOUTS, AWS_USER_LOCAL]

const AWS_INSTALL_URL = 'https://awscli.amazonaws.com/v2/install.sh'

/**
 * A layout per id that its own `identify` recognises, plus one it does not.
 *
 * The sweeps below range over PATHS rather than over `DependencyManager` values: since `updateFor`
 * derives the manager from the path with the spec's own `identify`, a manager string is no longer
 * something a caller can supply, and sweeping the ones no `identify` can return proved nothing.
 */
const LAYOUTS: Record<DependencyId, { owned: string; foreign: string }> = {
  brew: { owned: '/opt/homebrew/bin/brew', foreign: '/somewhere/odd/brew' },
  aws: { owned: AWS_KEG, foreign: '/somewhere/odd/aws' },
  gh: { owned: '/opt/homebrew/Cellar/gh/2.60.0/bin/gh', foreign: '/somewhere/odd/gh' },
  doppler: { owned: '/opt/homebrew/Cellar/doppler/3.68.0/bin/doppler', foreign: '/somewhere/odd/doppler' },
  portless: {
    owned: '/usr/local/lib/node_modules/portless/dist/cli.js',
    foreign: '/repo/node_modules/portless/dist/cli.js',
  },
}

describe('the five name fields do not collapse', () => {
  it('keeps aws’s binary and formula distinct', () => {
    const aws = specFor('aws')

    expect(aws.binName).toBe('aws')
    expect(aws.brewFormula).toBe('awscli')
    expect(aws.kegName).toBe('awscli')
  })

  it('keeps doppler’s tap-qualified install spec distinct from its keg', () => {
    const doppler = specFor('doppler')

    expect(doppler.brewInstallSpec).toBe('dopplerhq/cli/doppler')
    // The keg is named for the formula. `dopplerhq` is the tap and would miss every real install.
    expect(doppler.kegName).toBe('doppler')
  })

  it('never emits a formula that does not exist', () => {
    const update = specFor('aws').updateFor(AWS_KEG)

    expect(update?.steps).toEqual([['brew', 'upgrade', 'awscli']])
  })
})

/**
 * The subcommand this row claimed to have. AWS CLI v2 answers `argument command: Found invalid choice
 * 'update'` and exits 252, so `setup` reported a failure on every machine with a script-installed aws
 * and could not stop. Nothing pinned the recipe, which is why it survived; these tests are the pin.
 */
describe('a script-installed aws is updated by re-running the vendor installer', () => {
  it('never invokes the aws binary as its own updater', () => {
    for (const path of AWS_SCRIPT_LAYOUTS) {
      const steps = specFor('aws').updateFor(path)?.steps ?? []

      expect({ path, steps }).toMatchObject({ steps: expect.not.arrayContaining([['aws', 'update']]) })
    }
  })

  it('elevates and passes --system for the /usr/local layout, on both platforms’ shapes', () => {
    for (const path of AWS_SYSTEM_LAYOUTS) {
      const recipe = specFor('aws').updateFor(path)

      expect({ path, ...recipe }).toMatchObject({ needsSudo: true, fetchesNetworkScript: true })
      expect({ path, sudo: recipe?.steps[0]?.[0] }).toEqual({ path, sudo: 'sudo' })
      expect(recipe?.steps.flat().join(' ')).toContain('--system')
    }
  })

  it('stays user-scope for the XDG layout, which would otherwise gain a second shadowing aws', () => {
    const recipe = specFor('aws').updateFor(AWS_USER_LOCAL)

    expect(recipe).toMatchObject({ needsSudo: false, fetchesNetworkScript: true })
    expect(recipe?.steps.flat().join(' ')).not.toContain('--system')
  })

  it('refuses every layout rather than running it, and prints a line a shell accepts', () => {
    for (const path of AWS_SCRIPT_LAYOUTS) {
      const recipe = specFor('aws').updateFor(path) as Recipe
      const verdict = assessRecipe(recipe, { owner: 'script', present: ['homebrew', 'npm'] })

      expect({ path, executable: verdict.executable }).toEqual({ path, executable: false })
      // Quoted, so the pipeline stays inside the `bash -c` argument the recipe put it in.
      expect(formatRecipe(recipe)[0]).toContain(`'curl -fsSL ${AWS_INSTALL_URL}`)
    }
  })
})

describe('static risk literals', () => {
  it('marks the two bootstrap recipes as network-fetched, and brew’s as needing sudo', () => {
    expect(specFor('brew').bootstrapInstall).toMatchObject({ needsSudo: true, fetchesNetworkScript: true })
    // The AWS user-scope installer needs no sudo, but it is still a piped remote script.
    expect(specFor('aws').bootstrapInstall).toMatchObject({ needsSudo: false, fetchesNetworkScript: true })
  })

  it('marks every package-manager recipe as neither', () => {
    for (const id of ['gh', 'doppler', 'portless'] as DependencyId[]) {
      expect(specFor(id).bootstrapInstall).toMatchObject({ needsSudo: false, fetchesNetworkScript: false })
    }
  })

  // aws's script layouts are the ONE exception, and they are an exception on purpose: the vendor ships
  // no updater but its own installer, so the honest recipe is a piped remote script, and declaring that
  // is what gets it refused and printed instead of run. Every other row stays a plain manager call.
  it('marks no update recipe outside aws’s script layouts as sudo-requiring or network-fetched', () => {
    for (const id of DEPENDENCY_IDS) {
      for (const path of [LAYOUTS[id].owned, LAYOUTS[id].foreign]) {
        const recipe = specFor(id).updateFor(path)

        if (recipe === null) continue
        expect({ id, path, ...recipe }).toMatchObject({ needsSudo: false, fetchesNetworkScript: false })
      }
    }
  })
})

/**
 * The property `risk-predicate`'s null branch depends on, asserted here because this is the module that
 * can violate it. `managerDriving` returns null for a recipe that invokes no package manager, and on
 * null the detection conjuncts contribute NOTHING — so such a recipe is judged by the static conjuncts
 * alone. Adding a row whose recipe drives neither `brew` nor `npm` and declares neither risk literal
 * would make it executable under every classification, silently.
 */
describe('no recipe escapes both the static and the detection conjuncts', () => {
  it('either drives a package manager the predicate knows, or declares a static risk', () => {
    const everyRecipe = DEPENDENCY_IDS.flatMap((id) => {
      const spec = specFor(id)
      const paths = [LAYOUTS[id].owned, LAYOUTS[id].foreign, ...AWS_SCRIPT_LAYOUTS]

      return [spec.bootstrapInstall, ...paths.map(spec.updateFor)].filter((recipe): recipe is Recipe => {
        return recipe !== null
      })
    })

    // A sweep that silently enumerated nothing would pass forever, and one that happened to collect
    // only plain manager calls would never reach the branch this is about.
    expect(everyRecipe.length).toBeGreaterThan(DEPENDENCY_IDS.length)
    expect(
      everyRecipe.filter((recipe) => {
        return recipe.fetchesNetworkScript
      }).length,
    ).toBeGreaterThan(0)

    // Asked of `assessRecipe` itself rather than of a hand copy of `managerDriving`: a test that
    // restated the predicate would keep asserting a property of a function that had since changed.
    for (const recipe of everyRecipe) {
      const permissive = { owner: null, present: ['homebrew', 'npm', 'script'] as DependencyManager[] }
      const risky = recipe.needsSudo || recipe.fetchesNetworkScript

      expect({ steps: recipe.steps, executable: assessRecipe(recipe, permissive).executable }).toMatchObject({
        executable: !risky,
      })
    }
  })
})

describe('identify', () => {
  it.each([
    ['aws', '/opt/homebrew/Cellar/awscli/2.17.0/bin/aws', 'homebrew'],
    // The PM-2 case: the script layout must NOT read as a keg, or an "update" installs a second aws.
    ['aws', '/Users/x/.local/share/aws-cli/v2/2.17.0/dist/aws', 'script'],
    ['aws', '/somewhere/odd/aws', 'unknown'],
    ['gh', '/opt/homebrew/Cellar/gh/2.60.0/bin/gh', 'homebrew'],
    // An `npm i -g` under a node keg is not a brew install of gh.
    ['gh', '/opt/homebrew/Cellar/node/24.0.0/lib/node_modules/gh/bin/gh', 'unknown'],
    ['doppler', '/opt/homebrew/Cellar/doppler/3.68.0/bin/doppler', 'homebrew'],
    ['portless', '/usr/local/lib/node_modules/portless/dist/cli.js', 'npm'],
    ['portless', '/repo/node_modules/portless/dist/cli.js', 'unknown'],
  ] as [DependencyId, string, DependencyManager][])('%s at %s -> %s', (id, binPath, expected) => {
    expect(specFor(id).identify(binPath)).toBe(expected)
  })
})

describe('updateFor returns null rather than a guess', () => {
  it.each(DEPENDENCY_IDS)('%s has no update recipe on a layout it does not recognise', (id) => {
    expect(specFor(id).updateFor(LAYOUTS[id].foreign)).toBeNull()
  })

  it.each(DEPENDENCY_IDS)('%s has no update recipe when no binary could be resolved', (id) => {
    expect(specFor(id).updateFor(null)).toBeNull()
  })

  /**
   * The redundancy that made this parameter one too many: `updateFor` and `identify` are two answers
   * about ONE path, and a `(manager, path)` signature let a caller state a third. Deriving it here means
   * `('script', <a brew keg>)` is not merely wrong, it is unwritable.
   */
  it.each(DEPENDENCY_IDS)('%s agrees with its own identify about every layout', (id) => {
    const spec = specFor(id)

    for (const path of [LAYOUTS[id].owned, LAYOUTS[id].foreign, ...AWS_SCRIPT_LAYOUTS]) {
      const hasRecipe = spec.updateFor(path) !== null

      expect({ id, path, hasRecipe }).toEqual({ id, path, hasRecipe: spec.identify(path) !== 'unknown' })
    }
  })

  it('will not run the vendor self-updater against a doppler keg', () => {
    const recipe = specFor('doppler').updateFor(LAYOUTS.doppler.owned)

    expect(recipe?.steps).toEqual([['brew', 'upgrade', 'doppler']])
    expect(recipe?.steps.flat()).not.toContain('update')
  })
})

describe('platform gating', () => {
  it('refuses the brew-backed tools on win32 and allows the npm-backed one', () => {
    for (const id of ['brew', 'aws', 'gh', 'doppler'] as DependencyId[]) {
      expect(supportsPlatform(specFor(id), 'win32')).toBe(false)
    }
    expect(supportsPlatform(specFor('portless'), 'win32')).toBe(true)
  })

  it('allows every tool on darwin', () => {
    for (const id of DEPENDENCY_IDS) expect(supportsPlatform(specFor(id), 'darwin')).toBe(true)
  })
})

describe('installOrder', () => {
  it('puts brew before the tools that need it', () => {
    const ordered = installOrder(['doppler', 'gh'])

    expect(ordered.indexOf('brew')).toBeLessThan(ordered.indexOf('gh'))
    expect(ordered.indexOf('brew')).toBeLessThan(ordered.indexOf('doppler'))
  })

  it('leaves the prerequisite-free tools alone', () => {
    expect(installOrder(['aws', 'portless'])).toEqual(['aws', 'portless'])
  })

  it('emits each id once even when several share a prerequisite', () => {
    const ordered = installOrder(DEPENDENCY_IDS)

    expect(new Set(ordered).size).toBe(ordered.length)
    expect(ordered).toHaveLength(DEPENDENCY_IDS.length)
  })

  it('orders gnupg as a STEP of the doppler recipe, not as a dependency id', () => {
    // gnupg has no spec of its own: its binary (`gpg`) and formula (`gnupg`) diverge, and it exists here
    // only to make doppler's signature verification work. Ordered, not assumed.
    expect(DEPENDENCY_IDS).not.toContain('gnupg')
    expect(specFor('doppler').bootstrapInstall.steps[0]).toEqual(['brew', 'install', 'gnupg'])
  })
})

describe('probe argv', () => {
  it('asks every tool for its version and nothing else', () => {
    for (const id of DEPENDENCY_IDS) {
      const spec = specFor(id)

      expect(spec.probeArgv[0]).toBe(spec.binName)
      expect(spec.probeArgv).toHaveLength(2)
    }
  })

  it('parses a version out of real --version output', () => {
    expect(specFor('gh').versionFrom('gh version 2.60.1 (2026-08-01)')).toBe('2.60.1')
    expect(specFor('aws').versionFrom('aws-cli/2.17.0 Python/3.12.6 Darwin/25.2.0')).toBe('2.17.0')
    expect(specFor('brew').versionFrom('no digits here')).toBeNull()
  })
})

describe('the registry is exhaustive', () => {
  it('exposes exactly the five tools, each keyed by its own id', () => {
    // Copy before sorting: `DEPENDENCY_IDS` is the module's own array, and an in-place sort here would
    // silently reorder it for every later test in the file.
    expect([...DEPENDENCY_IDS].sort()).toEqual(['aws', 'brew', 'doppler', 'gh', 'portless'])
    for (const id of DEPENDENCY_IDS) expect(DEPENDENCY_SPECS[id].id).toBe(id)
  })
})
