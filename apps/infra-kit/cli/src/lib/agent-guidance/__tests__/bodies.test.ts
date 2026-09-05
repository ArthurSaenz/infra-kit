import { describe, expect, it } from 'vitest'

import { extractVersion } from 'src/lib/managed-block'

import { buildDesignSkeleton } from '../bodies/design-skeleton'
import { buildPackageBody } from '../bodies/package-body'
import { buildRootBody } from '../bodies/root-body'
import { TYPE_RULES } from '../bodies/type-rules'
import {
  PACKAGE_MARKER_END,
  PACKAGE_MARKER_START,
  PACKAGE_VERSION_PREFIX,
  ROOT_MARKER_END,
  ROOT_MARKER_START,
  ROOT_VERSION_PREFIX,
} from '../markers'
import { PACKAGE_TYPES } from '../package-type'
import type { PackageType } from '../package-type'

const VERSION = '0.4.0'
const PACKAGE_NAME = '@hulyo/client-ui'
const REL_DIR = 'apps/client/ui'

const body = (type: PackageType, overrides: { hasReadme?: boolean; hasDesign?: boolean } = {}): string => {
  return buildPackageBody({
    version: VERSION,
    type,
    packageName: PACKAGE_NAME,
    relDir: REL_DIR,
    hasReadme: overrides.hasReadme ?? true,
    hasDesign: overrides.hasDesign ?? false,
  })
}

describe('buildPackageBody — every type', () => {
  it.each([...PACKAGE_TYPES])('%s renders at most 25 lines', (type) => {
    expect(body(type).split('\n').length).toBeLessThanOrEqual(25)
  })

  it.each([...PACKAGE_TYPES])('%s names the package, its directory and its type', (type) => {
    const rendered = body(type)

    expect(rendered).toContain(`# ${PACKAGE_NAME}`)
    expect(rendered).toContain(`\`${REL_DIR}\``)
    expect(rendered).toContain(`**${TYPE_RULES[type].label}**`)
  })

  it.each([...PACKAGE_TYPES])('%s puts the version line first and round-trips through extractVersion', (type) => {
    const rendered = body(type)

    expect(rendered.split('\n')[0]).toBe(`${PACKAGE_VERSION_PREFIX}${VERSION} ${type} -->`)
    expect(extractVersion(rendered, PACKAGE_VERSION_PREFIX)).toBe(VERSION)
  })

  it.each([...PACKAGE_TYPES])('%s contains no marker string of either pair', (type) => {
    const rendered = body(type)

    for (const marker of [PACKAGE_MARKER_START, PACKAGE_MARKER_END, ROOT_MARKER_START, ROOT_MARKER_END]) {
      expect(rendered).not.toContain(marker)
    }
  })

  it.each([...PACKAGE_TYPES])('%s renders its own Rules bullets', (type) => {
    const rendered = body(type)

    for (const rule of TYPE_RULES[type].rules) {
      expect(rendered).toContain(rule)
    }
  })

  it('renders a different body per type', () => {
    const bodies = PACKAGE_TYPES.map((type) => {
      return body(type)
    })

    expect(new Set(bodies).size).toBe(PACKAGE_TYPES.length)
  })
})

describe('buildPackageBody — conditional bullets', () => {
  it.each([...PACKAGE_TYPES])('%s omits the README bullet when the file is absent', (type) => {
    expect(body(type, { hasReadme: false })).not.toContain('`README.md`')
    expect(body(type, { hasReadme: true })).toContain('`README.md`')
  })

  it.each([...PACKAGE_TYPES])('%s names DESIGN.md only when it is a frontend or mobile package', (type) => {
    const namesDesign = body(type).includes('`DESIGN.md`')

    expect(namesDesign).toBe(type === 'frontend' || type === 'mobile')
  })

  it('tells the agent to ask rather than invent a missing DESIGN.md', () => {
    expect(body('frontend')).toContain('ask before inventing one')
  })
})

describe('buildRootBody', () => {
  const rendered = buildRootBody(VERSION)

  it('puts the version line first and round-trips through extractVersion', () => {
    expect(rendered.split('\n')[0]).toBe(`${ROOT_VERSION_PREFIX}${VERSION} -->`)
    expect(extractVersion(rendered, ROOT_VERSION_PREFIX)).toBe(VERSION)
  })

  it('contains no marker string of either pair', () => {
    for (const marker of [ROOT_MARKER_START, ROOT_MARKER_END, PACKAGE_MARKER_START, PACKAGE_MARKER_END]) {
      expect(rendered).not.toContain(marker)
    }
  })

  it('documents the fix writer, the init refresh and the per-package convention', () => {
    expect(rendered).toContain('`ik audit --fix`')
    expect(rendered).toContain(
      '`ik init` — re-runs shell integration **and** refreshes every guidance block in the repo.',
    )
    expect(rendered).toContain('Every workspace package has its own CLAUDE.md with package-scoped rules')
  })

  it('keeps the pre-existing command and convention text', () => {
    expect(rendered).toContain('# infra-kit')
    expect(rendered).toContain('`ik env-load -c <config>`')
    expect(rendered).toContain('`ik release merge-dev`')
    expect(rendered).toContain('Tickets are prefixed by area')
  })
})

describe('buildDesignSkeleton', () => {
  const rendered = buildDesignSkeleton(PACKAGE_NAME)

  it('opens with YAML front matter carrying every spec key', () => {
    expect(rendered.startsWith('---\n')).toBe(true)

    for (const key of ['name:', 'description:', 'colors:', 'typography:', 'rounded:', 'spacing:', 'components:']) {
      expect(rendered).toContain(key)
    }

    expect(rendered).toContain(`name: ${PACKAGE_NAME}`)
  })

  it('renders the prose sections in spec order', () => {
    const sections = [
      'Overview',
      'Colors',
      'Typography',
      'Layout',
      'Elevation & Depth',
      'Shapes',
      'Components',
      "Do's and Don'ts",
    ]
    const positions = sections.map((section) => {
      return rendered.indexOf(`## ${section}`)
    })

    expect(
      positions.every((position) => {
        return position !== -1
      }),
    ).toBe(true)
    expect(
      [...positions].sort((a, b) => {
        return a - b
      }),
    ).toEqual(positions)
  })
})
