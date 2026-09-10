import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { runRecipe } from 'src/lib/dependency-install/dependency-install'
import { assessRecipe } from 'src/lib/dependency-install/risk-predicate'
import type { RiskContext } from 'src/lib/dependency-install/risk-predicate'
import { specFor } from 'src/lib/dependency-registry'

/**
 * @fileoverview
 *
 * Mutation checks for the risk predicate and the executor's two guards.
 *
 * An assertion that stays green when the thing it guards is removed is worse than no assertion: it
 * reports safety it is not checking. Each case here neuters one mechanism and asserts the
 * corresponding assertion in `risk-predicate.test.ts` / `dependency-install.test.ts` THEN FAILS.
 *
 * NO RUNTIME BACKDOOR. The source mutations are esbuild transforms that exist only inside this file's
 * build; shipped source has no flag, env var or branch that can disable any of it.
 */

const OUT_DIR = mkdtempSync(path.join(tmpdir(), 'ik-risk-mutation-'))

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true })
})

const SOURCE = path.resolve(__dirname, '..', 'risk-predicate.ts')

/**
 * Builds `risk-predicate.ts` with one textual mutation applied, and imports the result.
 *
 * The replacement is asserted to have changed something. Without that, renaming the mutated construct
 * would silently build an UNMUTATED module, the invariant would hold, and this file would report
 * success while checking nothing — the exact failure mode it exists to prevent.
 */
const buildMutant = async (name: string, mutate: (source: string) => string) => {
  const outfile = path.join(OUT_DIR, `${name}.mjs`)

  await build({
    entryPoints: [SOURCE],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    plugins: [
      {
        name: 'mutate',
        setup(pluginBuild) {
          pluginBuild.onLoad({ filter: /risk-predicate\.ts$/ }, async (args) => {
            const original = await import('node:fs/promises').then((fs) => {
              return fs.readFile(args.path, 'utf8')
            })
            const mutated = mutate(original)

            expect({ file: args.path, changed: mutated !== original }).toEqual({ file: args.path, changed: true })

            return { contents: mutated, loader: 'ts' }
          })
        },
      },
    ],
  })

  return (await import(outfile)) as { assessRecipe: typeof assessRecipe }
}

/** Everything present, nothing owned — so any refusal is the recipe's own, not the detection conjuncts. */
const PERMISSIVE: RiskContext = { owner: null, present: ['homebrew', 'npm', 'script'] }

describe('mutation: the static conjuncts must be applied unconditionally', () => {
  it('reddens when `needsSudo` is made contingent on detection', async () => {
    // NOT a reorder: a pure conjunction is order-independent, so reordering is a no-op that could never
    // redden and would be a false green. The real mutation is making a static conjunct conditional.
    const mutant = await buildMutant('needs-sudo-conditional', (source) => {
      return source.replace(
        "if (recipe.needsSudo) reasons.push('needs-sudo')",
        "if (recipe.needsSudo && false) reasons.push('needs-sudo')",
      )
    })

    // Real code refuses the Homebrew bootstrap for BOTH reasons; the mutant loses one of them.
    const real = assessRecipe(specFor('brew').bootstrapInstall, PERMISSIVE)
    const mutated = mutant.assessRecipe(specFor('brew').bootstrapInstall, PERMISSIVE)

    expect(real.executable === false && real.reasons).toContain('needs-sudo')
    expect(mutated.executable === false && mutated.reasons).not.toContain('needs-sudo')
  })

  it('reddens when `fetchesNetworkScript` is made contingent on detection', async () => {
    const mutant = await buildMutant('network-conditional', (source) => {
      return source.replace(
        "if (recipe.fetchesNetworkScript) reasons.push('fetches-network-script')",
        "if (recipe.fetchesNetworkScript && false) reasons.push('fetches-network-script')",
      )
    })

    // aws's first install fails ONLY on the network conjunct, so losing it makes the mutant execute a
    // `curl … | bash` — the single worst outcome this design exists to prevent. Swept over every
    // manager classification, since the claim is that no detection result can reach these.
    for (const owner of ['homebrew', 'npm', 'script', 'unknown', null] as const) {
      const context = { owner, present: PERMISSIVE.present }

      expect(assessRecipe(specFor('aws').bootstrapInstall, context).executable).toBe(false)
    }

    expect(mutant.assessRecipe(specFor('aws').bootstrapInstall, PERMISSIVE).executable).toBe(true)
  })
})

describe('mutation: each detection conjunct is load-bearing', () => {
  it('reddens when the manager-present conjunct is dropped', async () => {
    const mutant = await buildMutant('manager-present-dropped', (source) => {
      return source.replace(
        "if (!context.present.includes(manager)) reasons.push('manager-absent')",
        "if (false) reasons.push('manager-absent')",
      )
    })
    const noBrew: RiskContext = { owner: null, present: ['npm'] }

    expect(assessRecipe(specFor('gh').bootstrapInstall, noBrew).executable).toBe(false)
    expect(mutant.assessRecipe(specFor('gh').bootstrapInstall, noBrew).executable).toBe(true)
  })

  it('reddens when the manager-owns-this-binary conjunct is dropped', async () => {
    const mutant = await buildMutant('manager-mismatch-dropped', (source) => {
      return source.replace(
        "if (context.owner !== null && context.owner !== manager) reasons.push('manager-mismatch')",
        "if (false) reasons.push('manager-mismatch')",
      )
    })
    // A script-installed aws handed `brew upgrade awscli`: the split-brain that installs a second aws.
    const recipe = specFor('aws').updateFor('homebrew')
    const scriptOwned: RiskContext = { owner: 'script', present: ['homebrew', 'script'] }

    expect(assessRecipe(recipe as never, scriptOwned).executable).toBe(false)
    expect(mutant.assessRecipe(recipe as never, scriptOwned).executable).toBe(true)
  })
})

describe('mutation: the executor’s two guards are independent, not one guard written twice', () => {
  const spawnSpy = () => {
    const calls: string[][] = []

    return {
      calls,
      spawn: ((command: string, args: string[]) => {
        calls.push([command, ...args])

        return { status: 0, signal: null, error: undefined }
      }) as never,
    }
  }

  it('neutering the MCP guard alone still does not run a dangerous recipe', () => {
    const { calls, spawn } = spawnSpy()
    // `mcpMode: () => false` IS the neutered guard. The recipe verdict is what refuses here, so the two
    // guards genuinely stop different things — if they were redundant, this would spawn.
    const outcome = runRecipe(specFor('brew').bootstrapInstall, PERMISSIVE, {
      spawnSync: spawn,
      mcpMode: () => {
        return false
      },
    })

    expect(outcome.ran).toBe(false)
    expect(calls).toEqual([])
  })

  it('a safe recipe with the MCP guard neutered DOES run, proving the guard was what stopped it', () => {
    const { calls, spawn } = spawnSpy()
    const outcome = runRecipe(specFor('gh').bootstrapInstall, PERMISSIVE, {
      spawnSync: spawn,
      mcpMode: () => {
        return false
      },
    })

    expect(outcome.ran).toBe(true)
    expect(calls).toEqual([['brew', 'install', 'gh']])
  })
})

describe('mutation: there is no confirmation bypass to honour', () => {
  it('reads no confirmation field, so `--yes` cannot reach a dangerous recipe', () => {
    // PM-4 is closed structurally: `runRecipe` has no `confirm` / `confirmedCommand` parameter, so there
    // is nothing a caller could set. Asserted against the REAL module source and the REAL arity — an
    // earlier version of this test built its own literal and asserted its own keys, which would have
    // stayed green the day someone added a `confirm` field to `InstallDeps`.
    const source = readFileSync(path.resolve(__dirname, '..', 'dependency-install.ts'), 'utf8')

    expect(source).not.toContain('confirm')
    expect(source).not.toContain('confirmedCommand')

    // The seam bag is where a bypass would arrive, so pin its exact field set. Arity is NOT a useful
    // guard here: `deps` is defaulted, so `runRecipe.length` is 2 and would stay 2 after any optional
    // parameter was added — which is precisely the shape a confirmation flag would take.
    const declared = /export interface InstallDeps \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    const fields = [...declared.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => {
      return match[1]
    })

    expect(fields.sort()).toEqual(['env', 'mcpMode', 'spawnSync'])
  })
})
