import { describe, expect, it } from 'vitest'

import { DEPENDENCY_IDS, DEPENDENCY_SPECS, installOrder, specFor, supportsPlatform } from 'src/lib/dependency-registry'
import type { DependencyId, DependencyManager } from 'src/lib/dependency-registry'

/**
 * The registry is the single source of every name and every argv, so the assertions that matter here
 * are the ones where the FIVE names diverge. A test that only checked "aws has a recipe" would pass
 * just as happily against `brew upgrade aws`, the formula that does not exist.
 */

const MANAGERS: DependencyManager[] = ['npm', 'pnpm', 'yarn', 'bun', 'volta', 'homebrew', 'script', 'unknown']

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
    const update = specFor('aws').updateFor('homebrew')

    expect(update?.steps).toEqual([['brew', 'upgrade', 'awscli']])
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

  it('never marks an update recipe as sudo-requiring or network-fetched', () => {
    for (const id of DEPENDENCY_IDS) {
      for (const manager of MANAGERS) {
        const recipe = specFor(id).updateFor(manager)

        if (recipe === null) continue
        expect({ id, manager, ...recipe }).toMatchObject({ needsSudo: false, fetchesNetworkScript: false })
      }
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
  it.each(DEPENDENCY_IDS)('%s has no update recipe on an unknown layout', (id) => {
    expect(specFor(id).updateFor('unknown')).toBeNull()
  })

  it('will not run the vendor self-updater against a doppler keg', () => {
    const recipe = specFor('doppler').updateFor('homebrew')

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
