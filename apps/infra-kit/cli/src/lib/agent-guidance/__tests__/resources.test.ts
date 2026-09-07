import fs from 'node:fs'
import path from 'node:path'
import prettier from 'prettier'
import { describe, expect, it } from 'vitest'

import { PACKAGE_TYPES } from '../package-type'
import type { PackageType } from '../package-type'
import { PLACEHOLDERS, RESOURCES } from '../resources'
import type { ResourceKey } from '../resources'
import { RESOURCES_DIR, SENTINELS } from './helpers/resource-sentinels'

const KEYS = Object.keys(RESOURCES) as ResourceKey[]

const filePathFor = (key: ResourceKey): string => {
  return path.join(RESOURCES_DIR, `${key}.md`)
}

const readFile = (key: ResourceKey): string => {
  return fs.readFileSync(filePathFor(key), 'utf8')
}

/** Walk only the three resource directories, so `resources/README.md` is excluded by path. */
const walkResourceFiles = (): string[] => {
  return ['root', 'package', 'design'].flatMap((dir) => {
    return fs
      .readdirSync(path.join(RESOURCES_DIR, dir))
      .filter((entry) => {
        return entry.endsWith('.md')
      })
      .map((entry) => {
        return `${dir}/${entry.replace(/\.md$/, '')}`
      })
  })
}

describe('resources — reconciliation with the exported record', () => {
  it('has exactly one exported entry per file on disk', () => {
    // A path-scoped walk rather than a name-based skip list: an orphan file added to
    // one of these directories has to show up here, where a `!== 'README.md'` filter
    // would silently swallow it.
    expect(walkResourceFiles().sort()).toEqual([...KEYS].sort())
  })

  it('declares placeholders for every key', () => {
    expect(Object.keys(PLACEHOLDERS).sort()).toEqual([...KEYS].sort())
  })

  it('has a resource for every package type, and no type file that is not one', () => {
    const typeKeys = KEYS.filter((key) => {
      return key.startsWith('package/')
    }).map((key) => {
      return key.slice('package/'.length)
    })

    expect(typeKeys.sort()).toEqual([...PACKAGE_TYPES].sort())
  })

  it.each(KEYS)('%s is substantial and is the file its key names', (key) => {
    // "Non-empty" would be near-tautological — prettier gives every file a trailing
    // newline. A byte floor plus a per-file sentinel says it is the right content.
    expect(RESOURCES[key].length).toBeGreaterThanOrEqual(200)
    expect(RESOURCES[key]).toContain(SENTINELS[key])
  })

  it.each(KEYS)('%s carries no version line and no marker string', (key) => {
    expect(RESOURCES[key]).not.toContain('infra-kit:version')
    expect(RESOURCES[key]).not.toContain('infra-kit:package')
  })

  it('uses sentinels the bundle guard can still find after esbuild', () => {
    for (const sentinel of Object.values(SENTINELS)) {
      // ASCII only: esbuild's default charset escapes everything else, and every
      // bullet in these files carries an em dash.
      // eslint-disable-next-line no-control-regex
      expect(sentinel).toMatch(/^[\x00-\x7F]*$/)
      // No backtick: esbuild emits these resources as template literals, so a
      // backtick in the markdown is written as `\``. Measured — an inline code span
      // is the most natural sentinel to reach for and is exactly the one that never
      // matches, which reads as "the resource was not inlined" rather than as a
      // sentinel that cannot be found.
      expect(sentinel).not.toContain('`')
    }
  })
})

describe('resources — prettier is the adversary', () => {
  it.each(KEYS)('%s is byte-identical to its own prettier output', async (key) => {
    const filePath = filePathFor(key)
    // Pass the repo's own config, so this asserts the same formatting `prettier-check`
    // applies rather than prettier's defaults. (Measured: defaults happen to agree
    // today, because `proseWrap: 'preserve'` means `printWidth` never reflows this
    // prose — so a passing run here does not by itself prove the config was read.)
    const onDisk = readFile(key)
    const config = await prettier.resolveConfig(filePath)

    expect(await prettier.format(onDisk, { ...config, filepath: filePath })).toBe(onDisk)
  })

  it.each(KEYS)('%s still contains every placeholder it declares', (key) => {
    for (const placeholder of PLACEHOLDERS[key]) {
      expect(RESOURCES[key]).toContain(placeholder)
    }
  })

  it.each(KEYS)('%s declares no placeholder inside YAML front matter', (key) => {
    const content = RESOURCES[key]

    if (!content.startsWith('---\n')) return

    const closing = content.indexOf('\n---', 4)

    expect(closing).toBeGreaterThan(0)
    // Not "the front matter parses with the expected keys": prettier rewrites
    // `name: {{packageName}}` into `name: { { packageName } }`, which is still valid
    // YAML carrying that key, so a parse-and-check-keys guard passes on the bug.
    expect(content.slice(0, closing)).not.toContain('{')
  })
})

/**
 * Lines that are genuinely this type's own: its `## Rules` bullets, plus the
 * `DESIGN.md` Read-first bullet on the two types that have a visual language.
 *
 * Derived rather than written out as literals on purpose. Listing the rule text
 * here would make editing one sentence of per-type prose a two-file diff — the exact
 * cost moving this prose into markdown exists to remove.
 */
const perTypeLines = (content: string): string[] => {
  const lines = content.split('\n')
  const rulesAt = lines.indexOf('## Rules')

  return [
    ...lines.slice(0, rulesAt).filter((line) => {
      return line.includes('`DESIGN.md`')
    }),
    ...lines.slice(rulesAt + 1).filter((line) => {
      return line.startsWith('- ')
    }),
  ]
}

const sharedLines = (type: PackageType): string[] => {
  const content = RESOURCES[`package/${type}`]
  const own = perTypeLines(content)

  return content.split('\n').filter((line) => {
    return !own.includes(line)
  })
}

describe('resources — shared-region drift across the five type files', () => {
  const SHARED = sharedLines('lib')

  it('anchors the shared region at 18 lines', () => {
    // A stated constant, not an incidental one. The rendered block budget is 25 and
    // three types already render 24, so adding a line here puts them at the ceiling.
    // Whoever changes this number is the person who needs to know that.
    expect(SHARED).toHaveLength(18)
  })

  it.each([...PACKAGE_TYPES])('%s matches the shared region exactly, in order', (type) => {
    // Ordered equality, not set intersection. A set dedupes the seven blank lines to
    // one (cardinality 12, not 18) and is blind in both directions that matter here:
    // adding a shared bullet to one file only, and reordering two `## Checks` bullets,
    // both stay green under an intersection.
    expect(sharedLines(type)).toEqual(SHARED)
  })

  it('keeps the frontend-and-mobile-only lines byte-identical between those two files', () => {
    const designLines = (type: PackageType): string[] => {
      return RESOURCES[`package/${type}`].split('\n').filter((line) => {
        return line.includes('`DESIGN.md`')
      })
    }

    // Two lines, not one: the Read-first bullet and the "use the tokens" rule.
    expect(designLines('frontend')).toHaveLength(2)
    expect(designLines('frontend')).toEqual(designLines('mobile'))
  })

  it('names DESIGN.md in no other type file', () => {
    for (const type of PACKAGE_TYPES.filter((candidate) => {
      return candidate !== 'frontend' && candidate !== 'mobile'
    })) {
      expect(RESOURCES[`package/${type}`]).not.toContain('`DESIGN.md`')
    }
  })
})
