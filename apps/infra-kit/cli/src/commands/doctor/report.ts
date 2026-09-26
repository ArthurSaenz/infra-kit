// Imported from the leaf module, not the `src/lib/infra-kit-config` barrel, because this is read at
// module scope (below) and 22 suites partially mock that barrel — a partial mock drops every export it
// does not name, so a barrel import here makes an unrelated suite fail the moment anything imports
// `report.ts`. Nothing mocks the leaf. The render and assert-never imports are leaves for the same reason.
import { assertNever } from 'src/lib/assert-never/assert-never'
import { DEFAULT_DEV_PROXY_PORT } from 'src/lib/infra-kit-config/infra-kit-config'
import { formatRunReport, printRunReport, resolveReportCapabilities } from 'src/lib/render/run-report'
import type {
  PrintRunReportDeps,
  RunReport,
  RunReportOptions,
  RunRow,
  RunSection,
  RunStatus,
} from 'src/lib/render/run-report'

import type { CheckResult } from './doctor'

/**
 * @fileoverview
 *
 * Doctor's knowledge of its own report: which section each check belongs to, the canonical check
 * inventory, which checks `--fix` resolves, and how a `CheckResult` maps onto a shared row. The
 * rendering itself (glyphs, rollups, wrapping, colour) lives in `src/lib/render/run-report.ts`,
 * shared with `infra-kit setup`.
 *
 * REDACTION INVARIANT — read before adding a check message: these lines are written straight to
 * stderr, which BYPASSES pino's `REDACT_PATHS` backstop (see `lib/logger`). Every doctor message is
 * pre-redacted by construction (`describeEntries` reports a token's SOURCE, never its value). Any
 * new check message must hold to that.
 */

/** A named group of checks, in the order they are printed. */
export interface DoctorSection {
  label: string
  checks: CheckResult[]
}

const SECTION_TOOLS = 'Tools & CLIs'
const SECTION_SHELL = 'Shell & integration'
const SECTION_CONFIG = 'Project config'
const SECTION_TOKENS = 'Doppler env tokens'
const SECTION_PROXY = 'Dev proxy (portless)'
const SECTION_PLUGIN = 'Claude Code plugin'

/**
 * The `portless serving TLS on :443` check builds its name by interpolating the proxy port, so this
 * key is derived from the SAME constant. A frozen `':443'` literal would silently drop the check into
 * `Other` the day that port changes.
 */
const PORTLESS_SERVING_NAME = `portless serving TLS on :${DEFAULT_DEV_PROXY_PORT}`

/**
 * Which section each check belongs to, in print order. Keyed by check `name` rather than carried as a
 * `category` field on `CheckResult` so the 24 check functions (and their tests) stay untouched — the
 * grouping knowledge lives in exactly one place instead of being smeared across `doctor.ts`.
 *
 * A name that is missing here is NOT dropped: it falls into `Other` at runtime (see {@link groupChecks}).
 * The drift is caught by tests instead — `report.test.ts` asserts every name in
 * {@link DOCTOR_CHECK_NAMES} maps to a non-`Other` section, and that the inventory itself still equals
 * what a real `doctor()` run produces.
 */
const SECTION_MEMBERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    SECTION_TOOLS,
    [
      // First in the section because it is first in prerequisite order: `git`, `gh` and `doppler` are all
      // installed THROUGH brew here, so a reader scanning a failing report reads the cause above the
      // effects.
      'brew installed',
      'git installed',
      'gh installed',
      'gh authenticated',
      'doppler installed',
      'aws installed',
      'package manager installed',
      'typescript-language-server installed',
      'orca installed',
      'ide installed',
    ],
  ],
  [SECTION_SHELL, ['zshrc init block', 'zshenv session block', 'pnpm enableGlobalVirtualStore', 'CLAUDE.md block']],
  [
    SECTION_CONFIG,
    ['infra-kit config valid', 'user override path', 'legacy user-global config', 'merge-dev resolutions'],
  ],
  [SECTION_TOKENS, ['tokens.json present', 'env tokens configured', 'tokens.json perms']],
  [
    SECTION_PROXY,
    [
      'portless installed',
      'portless node',
      'portless service target',
      PORTLESS_SERVING_NAME,
      'portless CA chain valid',
      'portless CA trusted',
      'portless routes',
    ],
  ],
  [
    SECTION_PLUGIN,
    [
      'claude CLI',
      'marketplace registered',
      'plugin installed',
      'plugin version',
      'plugin MCP server',
      'CLI version',
      // The two agent rows close the section: how this shell would be classified, and whether the
      // repo's allowlist would let an agent bypass the `--yes` re-run on a mutating command.
      'Agent mode',
      'Agent allowlist',
    ],
  ],
]

/** The bucket for any check name not in {@link SECTION_MEMBERS} — a safety net, never a destination. */
export const OTHER_SECTION = 'Other'

/** The section order used for printing. */
const SECTION_ORDER: readonly string[] = SECTION_MEMBERS.map(([label]) => {
  return label
})

/** name → section label. */
const SECTION_BY_NAME = new Map<string, string>(
  SECTION_MEMBERS.flatMap(([label, names]) => {
    return names.map((name): [string, string] => {
      return [name, label]
    })
  }),
)

/**
 * Every check name `doctor()` can produce. This is the inventory the coverage test asserts the section
 * map covers, and that a deterministic `doctor()` run is reconciled against — so a new check that
 * updates neither this list nor {@link SECTION_MEMBERS} fails CI instead of quietly landing in `Other`.
 */
export const DOCTOR_CHECK_NAMES: readonly string[] = SECTION_MEMBERS.flatMap(([, names]) => {
  return names
})

/**
 * The checks `infra-kit doctor --fix` can actually resolve — stale portless routes
 * ({@link import('./doctor').pruneStalePortlessRoutes}) and loose token-store modes
 * ({@link import('./doctor').checkTokenStorePerms}). The summary's remediation hint is driven by this
 * set rather than by matching message text, so it cannot drift from the real `--fix` code paths.
 */
export const FIXABLE_NAMES: ReadonlySet<string> = new Set(['portless routes', 'tokens.json perms'])

/**
 * Group checks into printable sections. NON-MUTATING by contract: `structuredContent.checks` is built
 * from the same array in `doctor()`, and its order is part of that payload's compatibility surface, so
 * this must never sort or splice the input.
 *
 * A check that cannot run is still a row: it arrives as a `skip`, never as an absence, because an
 * omitted row reads as "nothing to report" when it means "never looked". Empty sections are omitted,
 * but only a section with no member rows at all can be empty. Any unmapped name lands in a trailing
 * {@link OTHER_SECTION} rather than disappearing.
 *
 * @example
 * groupChecks([{ name: 'gh installed', status: 'pass', message: '…' }])
 * // => [{ label: 'Tools & CLIs', checks: [ … ] }]
 */
export const groupChecks = (checks: readonly CheckResult[]): DoctorSection[] => {
  const buckets = new Map<string, CheckResult[]>()

  for (const check of checks) {
    const label = SECTION_BY_NAME.get(check.name) ?? OTHER_SECTION
    const bucket = buckets.get(label)

    if (bucket) bucket.push(check)
    else buckets.set(label, [check])
  }

  const ordered = [...SECTION_ORDER, OTHER_SECTION]

  return ordered.flatMap((label): DoctorSection[] => {
    const bucket = buckets.get(label)

    return bucket && bucket.length > 0 ? [{ label, checks: bucket }] : []
  })
}

export { resolveReportCapabilities }

/** Doctor's four verdicts are a subset of the shared statuses; a new verdict must pick its row status here. */
const toRunStatus = (status: CheckResult['status']): RunStatus => {
  switch (status) {
    case 'pass':
      return 'ok'
    case 'fail':
      return 'fail'
    case 'warn':
      return 'warn'
    case 'skip':
      return 'skipped'
    default:
      return assertNever(status)
  }
}

/** Doctor's report as shared rows, with a `--fix` hint only when a FAILING check is actually fixable. */
const toRunReport = (checks: readonly CheckResult[]): RunReport => {
  const fixable = checks.filter((check) => {
    return check.status === 'fail' && FIXABLE_NAMES.has(check.name)
  }).length

  return {
    title: 'infra-kit doctor',
    emptyMessage: 'No checks ran.',
    sections: groupChecks(checks).map((section): RunSection => {
      return {
        label: section.label,
        rows: section.checks.map((check): RunRow => {
          return { name: check.name, status: toRunStatus(check.status), message: check.message }
        }),
      }
    }),
    hints: fixable > 0 ? [`${fixable} fixable — run \`infra-kit doctor --fix\``] : [],
  }
}

/**
 * Render the whole doctor report through the shared {@link formatRunReport}. Pure, like it.
 *
 * @example
 * formatDoctorReport([{ name: 'gh installed', status: 'pass', message: 'installed' }], { color: false })
 * // => ['infra-kit doctor', '', '  Tools & CLIs …', '    ✓ gh installed  installed', …]
 */
export const formatDoctorReport = (checks: readonly CheckResult[], options: RunReportOptions = {}): string[] => {
  return formatRunReport(toRunReport(checks), options)
}

/** Write the doctor report to stderr in ONE write (see {@link printRunReport}). */
export const printDoctorReport = (checks: readonly CheckResult[], deps: PrintRunReportDeps = {}): void => {
  printRunReport(toRunReport(checks), deps)
}
