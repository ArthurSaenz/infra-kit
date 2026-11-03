import { describe, expect, it } from 'vitest'

import { buildRootBody } from 'src/lib/agent-guidance'
import { ROOT_MARKER_END, ROOT_MARKER_START, ROOT_VERSION_PREFIX } from 'src/lib/agent-guidance/markers'
import { buildManagedBlock } from 'src/lib/managed-block'
import { DEFAULT_RULES } from 'src/lib/package-config'
import type { PackageCheck } from 'src/lib/package-validator'

import { findEmptyRules } from '../empty-rules-check'
import { findFleetDrift } from '../fleet-drift-check'
import type { DependencySite } from '../fleet-drift-check'
import { compareGuidance } from '../guidance-check'

const CURRENT = '0.34.0'

const site = (file: string, name: string, spec: string): DependencySite => {
  return { file, section: 'devDependencies', name, spec }
}

/**
 * One trigger per check, each the smallest input that produces it. Only the checks `--fix` repairs or
 * the author controls fail; drift a CLI release can cause on its own (lockstep, guidance) stays a warn
 * so a release never reddens every consumer's qa.
 */
const TRIGGERS: Record<string, () => PackageCheck[]> = {
  'empty-rules': () => {
    return findEmptyRules({ requiredScripts: [] }, DEFAULT_RULES, 'infra-kit.config.ts')
  },
  'dependency-drift:catalog': () => {
    return findFleetDrift(
      [
        site('a/package.json', '@slip-stream-kit/config', '^0.34.0'),
        site('b/package.json', '@slip-stream-kit/config', '^0.34.1'),
      ],
      { default: {}, named: {} },
      CURRENT,
    )
  },
  'dependency-drift:lockstep': () => {
    return findFleetDrift(
      [site('package.json', '@slip-stream-kit/config', '^0.33.0')],
      { default: {}, named: {} },
      CURRENT,
    )
  },
  'dependency-drift:infra-kit-pin': () => {
    return findFleetDrift([site('package.json', 'infra-kit', '0.13.0')], { default: {}, named: {} }, CURRENT)
  },
  'agent-guidance:drift': () => {
    return [
      compareGuidance({
        content: buildManagedBlock(ROOT_MARKER_START, `${buildRootBody('0.1.0')}\nhand edit`, ROOT_MARKER_END),
        expectedBody: buildRootBody(CURRENT),
        startMarker: ROOT_MARKER_START,
        endMarker: ROOT_MARKER_END,
        versionPrefix: ROOT_VERSION_PREFIX,
        current: CURRENT,
        scope: 'root',
      }),
    ]
  },
}

describe('audit promotion table', () => {
  it.each([
    ['empty-rules', 'fail'],
    ['dependency-drift:catalog', 'fail'],
    ['dependency-drift:lockstep', 'warn'],
    ['dependency-drift:infra-kit-pin', 'warn'],
    ['agent-guidance:drift', 'warn'],
  ] as const)('%s is a %s', (name, status) => {
    const checks = TRIGGERS[name]!()

    expect(
      checks.map((check) => {
        return [check.name, check.status]
      }),
    ).toEqual([[name, status]])
  })
})
