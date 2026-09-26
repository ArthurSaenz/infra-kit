/**
 * Pins the RESOLVED `no-restricted-imports` options, because this repo's eslint config has already
 * lost a rule to silent replacement once.
 *
 * Flat config does not merge rule options: when two config objects both set `no-restricted-imports`
 * and both match a file, the later one REPLACES the earlier wholesale. A zx-`question` fence was
 * added with `files: ['src/**\/*.ts']` — a strict superset of the machine-path globs — and thereby
 * deleted the entire ink/react boundary for every `.ts` file under `src/`. Nothing failed: a rule
 * that stops existing emits no error, `pnpm run qa` stayed green, and the hand-maintained allowlist
 * in `tui/__tests__/no-react-boundary.test.ts` covers nine named files rather than sweeping.
 *
 * Asserting on the resolved config is the only thing that catches that class, so it is asserted
 * here rather than trusted to review.
 */
import { ESLint } from 'eslint'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PROJECT = path.resolve(__dirname, '..')

const eslint = new ESLint({ cwd: PROJECT })

const restrictedFor = async (file: string): Promise<{ names: string[]; groups: string[] }> => {
  const config = await eslint.calculateConfigForFile(path.join(PROJECT, file))
  const [, options] = (config.rules?.['no-restricted-imports'] ?? []) as [
    unknown,
    { paths?: { name: string }[]; patterns?: { group: string[] }[] } | undefined,
  ]

  return {
    names: (options?.paths ?? []).map((entry) => {
      return entry.name
    }),
    groups: (options?.patterns ?? []).flatMap((entry) => {
      return entry.group
    }),
  }
}

/**
 * 30s, against a default of 5s. Do NOT tune this down.
 *
 * The first `calculateConfigForFile` pays a one-time ~1048ms cold resolution of the whole flat
 * config — `@wl/eslint-config` pulls in typescript-eslint, sonarjs and unicorn. Every call after it
 * is ~35ms, so the budget is dominated by that single cold load, NOT by the number of assertions.
 * In isolation the file runs in ~1.2s; under the full suite it competes for CPU with the
 * process-spawning dev-server and turbo tests and was measured at 6504ms — over the default, which
 * made `pnpm run qa` intermittently red.
 *
 * Reusing one `ESLint` instance does NOT fix this (measured: 34ms reused vs 35ms fresh) — the cold
 * load happens once per process either way. A timeout is the right lever; a refactor is not.
 */
const COLD_CONFIG_LOAD_BUDGET_MS = 30_000

describe('eslint no-restricted-imports survives config composition', () => {
  it(
    'keeps BOTH the no-React boundary and the zx fence on a machine path',
    async () => {
      // The exact file the regression made unguarded.
      const { names, groups } = await restrictedFor('src/commands/release-create/release-create.ts')

      expect(names).toContain('react')
      expect(names).toContain('ink')
      expect(names).toContain('zx')
      expect(groups).toContain('src/tui')
    },
    COLD_CONFIG_LOAD_BUDGET_MS,
  )

  it(
    'applies the zx fence outside the machine paths too',
    async () => {
      const { names } = await restrictedFor('src/dev/dev-server.ts')

      expect(names).toContain('zx')
    },
    COLD_CONFIG_LOAD_BUDGET_MS,
  )

  it(
    'does not apply the no-React boundary to the TUI itself',
    async () => {
      // The other direction: `src/tui/*` legitimately imports ink and react, so the fences must not
      // have widened onto it. Guards the opposite failure from the one above — an over-broad
      // `ignores`/`files` edit that makes the TUI unbuildable rather than unguarded.
      const { names } = await restrictedFor('src/tui/boot.tsx')

      expect(names).not.toContain('react')
      expect(names).not.toContain('ink')
    },
    COLD_CONFIG_LOAD_BUDGET_MS,
  )
})
