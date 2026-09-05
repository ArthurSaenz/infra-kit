import path from 'node:path'

// Deep `agent-guidance` paths, never the `src/lib/agent-guidance` barrel: that barrel
// re-exports `adoption.ts`, which imports the package-validator loader, and this module is
// itself reached from the package-validator barrel. `inspect.ts`, `markers.ts` and
// `read-guidance-file.ts` import nothing from package-validator, so these runtime edges
// cannot close a cycle. The `AdoptionState` reference is `import type`, so it adds no edge at all.
import type { AdoptionState } from 'src/lib/agent-guidance/adoption'
import { inspectPackageGuidance } from 'src/lib/agent-guidance/inspect'
import type { GuidanceState } from 'src/lib/agent-guidance/inspect'
import { PACKAGE_MARKER_END, PACKAGE_MARKER_START, ROOT_MARKER_START } from 'src/lib/agent-guidance/markers'
import { readGuidanceFile } from 'src/lib/agent-guidance/read-guidance-file'

import type { PackageCheck } from '../types'

/** Stable check name, identical in both adoption states so one grep finds every report. */
const CHECK_NAME = 'agent-guidance'

/** The per-package guidance file this check validates. */
const GUIDANCE_FILE = 'CLAUDE.md'

/** Tail of every non-`ok` message — one command repairs all four broken states. */
const FIX_HINT = '— run: infra-kit audit --fix'

/**
 * The state-naming half of each message. Package-relative by design: this check gets an
 * absolute `packageDir` and has no repo-relative frame of its own, and the audit printer
 * already supplies the identity as `[FAIL] <packageName> <check>: <message>`.
 */
const STATE_MESSAGES: Record<Exclude<GuidanceState, 'ok'>, string> = {
  missing: `${GUIDANCE_FILE} missing`,
  'no-block': `${GUIDANCE_FILE} has no infra-kit block (expected ${PACKAGE_MARKER_START} … ${PACKAGE_MARKER_END})`,
  malformed: `${GUIDANCE_FILE} block is malformed (end marker precedes start, or body is empty)`,
  'foreign-block': `${GUIDANCE_FILE} carries the ROOT infra-kit block (${ROOT_MARKER_START}); a package needs the package block`,
}

/**
 * The adopting evidence, repo-relative, or `''` when the workspace has not adopted. This is
 * the one path in the message that must be repo-relative, because it names a *different*
 * package than the one being reported — hence `AdoptionState` carrying `workspaceRoot`.
 */
const evidenceSuffix = (adoption: AdoptionState): string => {
  if (!adoption.adopted) return ''

  return ` (workspace adopted: ${path.relative(adoption.workspaceRoot, adoption.evidencePath)} carries a package block)`
}

/**
 * Validate one package's `CLAUDE.md` guidance block.
 *
 * The structural predicate is the same in every workspace; what adoption changes is whether a
 * broken structure is allowed to fail. Before adoption — no package anywhere carries a
 * well-formed block — every non-`ok` state reports `pass` with the message prefixed
 * `not yet adopted — `, so a CLI upgrade alone can never redden a consumer's CI. After
 * adoption the same four states `fail`, and the `missing` message names the package whose
 * block switched enforcement on.
 *
 * @example
 * checkAgentGuidance('/repo/packages/lib-a', { adopted: false, workspaceRoot: '/repo' })
 * // => status 'pass', 'not yet adopted — CLAUDE.md missing — run: infra-kit audit --fix'
 * @example
 * checkAgentGuidance('/repo/packages/lib-b',
 *   { adopted: true, workspaceRoot: '/repo', evidencePath: '/repo/packages/lib-a/CLAUDE.md' })
 * // => status 'fail', 'CLAUDE.md missing — run: infra-kit audit --fix
 * //    (workspace adopted: packages/lib-a/CLAUDE.md carries a package block)'
 */
export const checkAgentGuidance = (packageDir: string, adoption: AdoptionState): PackageCheck => {
  const inspection = inspectPackageGuidance(readGuidanceFile(path.join(packageDir, GUIDANCE_FILE)))

  if (inspection.state === 'ok') {
    // Both fields come off the block on disk, not off the running CLI: a block written by a
    // newer release can name a version and a type this CLI does not know.
    const version = inspection.version ?? 'unknown'
    const type = inspection.type ?? 'unknown'

    return { name: CHECK_NAME, status: 'pass', message: `present (block from infra-kit ${version}, type ${type})` }
  }

  const detail = `${STATE_MESSAGES[inspection.state]} ${FIX_HINT}`
  const message = inspection.state === 'missing' ? `${detail}${evidenceSuffix(adoption)}` : detail

  if (adoption.adopted) {
    return { name: CHECK_NAME, status: 'fail', message }
  }

  return { name: CHECK_NAME, status: 'pass', message: `not yet adopted — ${message}` }
}
