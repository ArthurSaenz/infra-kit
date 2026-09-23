import path from 'node:path'

import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { expandTilde } from 'src/lib/vendor/factory-config'
import type { FactoryConfig } from 'src/lib/vendor/factory-config-schema'
import { buildTargetPlan, probeTarget } from 'src/lib/vendor/sync'
import type { SourceFacts, TargetPlan, TargetRef } from 'src/lib/vendor/sync'

/**
 * Resolve the factory targets under `workspaceDir`, narrowed to `requested` when any are named. An unknown
 * name refuses instead of warning: a typo would otherwise sync nothing and exit green.
 *
 * @example
 * selectTargets({ workspaceDir: '~/projects', targets: ['a', 'b'] }, ['b'])
 * // => [{ name: 'b', root: '/Users/me/projects/b' }]
 */
export const selectTargets = (factory: FactoryConfig, requested: readonly string[]): TargetRef[] => {
  const unknown = requested.filter((name) => {
    return !factory.targets.includes(name)
  })

  if (unknown.length > 0) {
    throw new StructuredRefusalError(
      { status: 'refused', reason: 'unknown-target', unknown, valid: factory.targets },
      2,
      {
        operation: `sync vendored files to ${unknown.join(', ')}`,
        stderrExcerpt: `not a target in ~/.infra-kit/vendor.json: ${unknown.join(', ')}`,
        remediation: `name one of: ${factory.targets.join(', ')}`,
      },
    )
  }

  const workspace = expandTilde(factory.workspaceDir)
  const names =
    requested.length > 0
      ? factory.targets.filter((name) => {
          return requested.includes(name)
        })
      : factory.targets

  return names.map((name) => {
    return { name, root: path.join(workspace, name) }
  })
}

const MANIFEST_ONLY_MESSAGE = 'rewrite vendor/README.md and vendor/.sync-manifest.json from the tracked vendor/ files'

/**
 * `--manifest-only` copies nothing, so a checked-out repo is always `changed` and its recovery covers only the
 * two meta files HEAD already tracks.
 */
const manifestOnlyPlan = async (source: SourceFacts, ref: TargetRef): Promise<TargetPlan> => {
  const facts = await probeTarget(source, ref)
  const plan = buildTargetPlan(source, facts)

  if (facts.kind !== 'repo') return plan

  return {
    ...plan,
    status: 'changed',
    message: `${MANIFEST_ONLY_MESSAGE} on ${facts.branch}`,
    notes: [],
    warnings: [],
    branch: facts.branch,
    entries: [],
    legacy: [],
    writeVendorMeta: true,
    recoveryPaths: facts.headVendorMeta,
  }
}

/**
 * Probe and plan every target, one row each; the plan is pure over the probed facts.
 *
 * @example
 * const plans = await planTargets(source, [{ name: 'hulyo', root: '/Users/me/projects/hulyo' }], false)
 */
export const planTargets = async (
  source: SourceFacts,
  refs: readonly TargetRef[],
  manifestOnly: boolean,
): Promise<TargetPlan[]> => {
  return Promise.all(
    refs.map(async (ref) => {
      if (manifestOnly) return manifestOnlyPlan(source, ref)

      return buildTargetPlan(source, await probeTarget(source, ref))
    }),
  )
}
