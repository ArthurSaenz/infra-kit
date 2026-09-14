import { describe, expect, it } from 'vitest'

import { extractVersion } from 'src/lib/managed-block'
import { MCP_TOOL_PREFIX } from 'src/mcp/tool-prefix'

import { buildDesignSkeleton } from '../bodies/design-skeleton'
import { buildPackageBody } from '../bodies/package-body'
import { buildRootBody } from '../bodies/root-body'
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

/**
 * Rendered line count per type, with a `README.md`; one fewer without it.
 *
 * Exact numbers rather than a `<= 25` budget, and this is the primary guard on the
 * markdown resources. Prettier's characteristic damage to those files is to leave
 * every token in place and insert a line *beside* one — which a placeholder-presence
 * check cannot see, and which `prettier-check` cannot see either once `prettier-fix`
 * has written the damage into the file. A count fails loudly on exactly that class.
 *
 * Headroom is one line: `managed-block` wraps these in markers and the block budget
 * is 25. Adding a line to the shared region of the five resource files puts three
 * types at the ceiling.
 */
const LINE_COUNTS: Readonly<Record<PackageType, number>> = {
  frontend: 24,
  backend: 23,
  lib: 24,
  e2e: 24,
  mobile: 24,
}

describe('buildPackageBody — every type', () => {
  it.each([...PACKAGE_TYPES])('%s renders exactly its expected line count', (type) => {
    expect(body(type).split('\n')).toHaveLength(LINE_COUNTS[type])
    expect(body(type, { hasReadme: false }).split('\n')).toHaveLength(LINE_COUNTS[type] - 1)
  })

  it.each([...PACKAGE_TYPES])('%s names the package, its directory and its type', (type) => {
    const rendered = body(type)

    expect(rendered).toContain(`# ${PACKAGE_NAME}`)
    expect(rendered).toContain(`\`${REL_DIR}\``)
    expect(rendered).toContain(`**${type}**`)
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

  // The per-rule `toContain` loop that stood here is deliberately gone. With the
  // rules now living in `resources/package/<type>.md`, its only possible source is
  // the same file the renderer reads, so it could only ever assert that a parse
  // equals itself. The characterization snapshot in `bodies-snapshot.test.ts` is
  // its replacement and is a genuine literal-string contract.

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

  it('documents the fix writer, the setup command and the per-package convention', () => {
    expect(rendered).toContain('`ik audit --fix`')
    expect(rendered).toContain(
      '`ik setup` — set up infra-kit on this machine: shell integration, the Claude Code plugin (which serves the infra-kit MCP server), and the external CLIs (brew, aws, gh, doppler, portless).',
    )
    expect(rendered).toContain('Every workspace package has its own CLAUDE.md with package-scoped rules')
  })

  // The two halves of a split that is easy to collapse and expensive to collapse wrongly.
  // `audit --fix --root` WRITES this block; `setup` installs. Naming `setup` as the generator
  // would print "regenerating documentation means running the installer" into every consumer's
  // committed CLAUDE.md — and `pnpm run setup` (a different, also-mutating command) exists in all
  // of them, so a wrong guess succeeds at the wrong thing instead of erroring.
  it('names `audit --fix --root` as its own generator, never `setup`', () => {
    expect(rendered).toContain('This block is generated by `ik audit --fix --root`')
    expect(rendered).not.toContain('generated by `ik setup`')
    expect(rendered).not.toContain('generated by `infra-kit setup`')
  })

  // I-8. `init` no longer exists, and nothing this CLI generates may name it: a consumer's committed
  // block is rewritten only when someone runs the regenerating command inside that repo, so an
  // instruction naming a removed command is exactly the text that cannot self-heal — it would sit
  // there failing at the parser until a human noticed.
  it('renders no `ik init` / `infra-kit init` instruction', () => {
    expect(rendered).not.toContain('ik init')
    expect(rendered).not.toContain('infra-kit init')
  })

  it('renders exactly 28 lines', () => {
    // Same net as the per-type counts, extended to the two resources `PACKAGE_TYPES`
    // does not reach. The root body carries one placeholder (the MCP tool prefix)
    // today, so the prettier-inserts-a-line class is reachable through it — this is
    // defence in depth, and the only alternative backstop is a snapshot whose update
    // path is `vitest -u`.
    expect(rendered.split('\n')).toHaveLength(28)
  })

  it('keeps the pre-existing command and convention text', () => {
    expect(rendered).toContain('# infra-kit')
    expect(rendered).toContain('`ik env-load -c <config>`')
    expect(rendered).toContain('`ik release merge-dev`')
    expect(rendered).toContain('Tickets are prefixed by area')
  })

  it('tells the agent to relaunch at the repository root when plugin tools are absent, spelling the MCP prefix through tool-prefix.ts', () => {
    expect(rendered).toContain(
      `Launch Claude Code at the repository root: the infra-kit plugin (skills, \`/infra-kit:*\` commands, the \`${MCP_TOOL_PREFIX}*\` MCP server) and this repo's \`.claude/settings.json\` hooks load only from there. If those tools are absent, this is a subdirectory session — restart Claude Code at the root.`,
    )
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

  it('injects the package name at both points, front matter and heading', () => {
    // Two points, two mechanisms: the front matter carries a static `name: TODO`
    // replaced by exact match (prettier destroys `{{ }}` inside front matter), the
    // heading an ordinary placeholder. Asserting only the first would ship a literal
    // `# Design — {{packageName}}` heading into every scaffolded file.
    expect(rendered).toContain(`# Design — ${PACKAGE_NAME}`)
    expect(rendered).not.toContain('name: TODO')
    expect(rendered).not.toContain('{{')
  })

  it('renders exactly 70 lines and ends with a single newline', () => {
    expect(rendered.split('\n')).toHaveLength(70)
    // Unlike the two block bodies this one is written as a whole file, so its single
    // trailing newline is part of the contract rather than an artefact.
    expect(rendered.endsWith('\n')).toBe(true)
    expect(rendered.endsWith('\n\n')).toBe(false)
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
