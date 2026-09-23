import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { specFor } from 'src/lib/dependency-registry'
import type { DependencyId } from 'src/lib/dependency-registry'

import type { DependencyDetail } from '../doctor'

/**
 * The probe argv for `gh`, `doppler` and `aws` must exist in exactly ONE module — the registry — with
 * `doctor` consuming it. Two lists that drift is a defect this repo would have to discover twice, once
 * per surface.
 *
 * Asserted against the SOURCE TEXT rather than behaviour on purpose: a behavioural test passes just as
 * happily when `doctor` carries its own identical copy, which is precisely the state this forbids.
 * `tool-command-checks.test.ts` already proves the argv still reach the right binary.
 */

const DOCTOR_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'doctor.ts'), 'utf-8')

/** The five doctor rows whose argv the registry now owns. `brew` and `git` joined them with their own rows. */
const UNIFIED: DependencyId[] = ['brew', 'git', 'gh', 'doppler', 'aws']

/**
 * `K extends keyof T` evaluated at COMPILE time. A needle check catches a name; this catches the
 * capability — widening {@link DependencyDetail} to carry the install report's `action` / `commands`
 * would flip one of these to `true` and fail `tsc`, whatever the field ended up being called in
 * `doctor.ts`'s source text.
 */
type HasKey<T, K extends string> = K extends keyof T ? true : false

describe('probe argv single source', () => {
  it.each(UNIFIED)('doctor holds no literal --version argv for %s', (id) => {
    const literal = `['${specFor(id).binName}', '--version']`

    expect(DOCTOR_SOURCE).not.toContain(literal)
  })

  it.each(UNIFIED)('doctor reads %s’s probe argv from the registry', (id) => {
    expect(DOCTOR_SOURCE).toContain(`specFor('${id}').probeArgv`)
  })

  it('does not let doctor reach the install recipes', () => {
    // One-way seam: the registry owns "how do I ask this tool for its version"; what would FIX a failing
    // row belongs to `setup`. A doctor that could install is `doctor --fix` by another door.
    expect(DOCTOR_SOURCE).not.toContain('bootstrapInstall')
    expect(DOCTOR_SOURCE).not.toContain('updateFor')
    // Added because the seam was once crossed by RELOCATION rather than by import: doctor consumed
    // `setupDependencyStatus()`, whose payload carries `action` and `commands` derived from the install
    // recipes, and the two needles above stayed green because the recipe names had moved one module
    // away. `doctor` composes from `lib/dependency-probe` + `lib/dependency-registry` and stops there.
    expect(DOCTOR_SOURCE).not.toContain('setupDependencyStatus')
    // The IMPORT, not the name: `lib/dependency-plan` is the module that turns a probe into a recipe,
    // and doctor's own comments have to be able to say so.
    expect(DOCTOR_SOURCE).not.toContain("from 'src/lib/dependency-plan'")
  })

  it('keeps `detail` to probe facts — no action, no commands', () => {
    const noAction: HasKey<DependencyDetail, 'action'> = false
    const noCommands: HasKey<DependencyDetail, 'commands'> = false

    // The assertion that bites is the ANNOTATION above, checked by `tsc`; these two lines exist so the
    // constants are read and the intent is visible in a test report rather than only in a type.
    expect([noAction, noCommands]).toEqual([false, false])
  })

  it('leaves `portless installed` alone, because it is not a --version probe', () => {
    // The plan's §5.5 called this a fourth duplicated probe. It is not: doctor resolves portless out of
    // `node_modules` (`resolvePortlessBin`), never off PATH — and portless is never on PATH here, which
    // is why the codebase prints `<node> <abs cli.js>`. Unifying it would silently change what the row
    // means, from "resolvable" to "on PATH", and turn a passing check into a permanent failure.
    expect(DOCTOR_SOURCE).toContain('resolvePortlessBin')
    expect(DOCTOR_SOURCE).not.toContain("specFor('portless')")
  })
})
