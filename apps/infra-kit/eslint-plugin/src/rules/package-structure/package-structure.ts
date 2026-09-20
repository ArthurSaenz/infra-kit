import type { Rule } from 'eslint'

import { dirsUnderSrc, findPackageRoot } from '../../utils/package-root'
import { resolvePackageType } from '../../utils/package-type-reader'
import { matchesAnyGlob } from '../../utils/path-match'

// Declared locally rather than imported: this type reaches the plugin's public `dist/index.d.ts`,
// and a `@slip-stream-kit/config` specifier there would make every consumer's tsc resolve a package
// the plugin does not ship. A unit test binds the members to the config package's PACKAGE_TYPES.
export const PACKAGE_TYPE_VALUES = ['frontend', 'backend', 'lib', 'e2e', 'mobile'] as const

export type PackageType = (typeof PACKAGE_TYPE_VALUES)[number]

export interface LayerEntry {
  /** First-level directories allowed under `src/`. */
  layers: string[]
  /**
   * Allowed directories one level further down, keyed by where they sit: `features/*` means "inside
   * every folder of `features/`" (each folder is a unit of any name), `services` means "directly
   * inside `services/`". A layer without a key is not inspected below its first level.
   */
  segments?: Record<string, string[]>
  /** Skill or doc that owns this layout, appended to the message. `''` or absent → no "See …" sentence. */
  skill?: string
}

export interface Options extends Partial<Record<PackageType, LayerEntry>> {
  /** Globs; the rule is skipped for matching files. */
  ignore?: string[]
}

/**
 * Built-in entries per package type. A present option key replaces the whole entry (layers,
 * segments AND skill) — the same absent→default / set→replace semantics as every other option in
 * the plugin. `mobile` and `lib` have no entry until their layouts settle, so they are silent.
 */
export const DEFAULT_ENTRIES: Partial<Record<PackageType, LayerEntry>> = {
  frontend: {
    layers: ['app', 'features', 'lib', 'components', 'pages', 'routes'],
    segments: {
      'features/*': ['containers', 'components', 'services', '__stories__', '__tests__'],
    },
    skill: '/infra-kit:fe-architect',
  },
  backend: {
    layers: ['controllers', 'services', 'lib', 'config'],
    segments: {
      'services/*': ['__tests__'],
    },
    // The skill does not exist yet; the user adds `plugins/infra-kit/skills/be-architect/SKILL.md`
    // and accepted the dangling pointer until then.
    skill: '/infra-kit:be-architect',
  },
  e2e: {
    layers: ['tests', 'pages', 'fixtures', 'mocks', 'data', 'config', 'lib', 'components'],
    skill: '/infra-kit:e2e-architect',
  },
}

export const resolveEntry = (type: PackageType, options: Options): LayerEntry | undefined => {
  return options[type] ?? DEFAULT_ENTRIES[type]
}

const UNIT_KEY_SUFFIX = '/*'

/**
 * A `segments` key that names a layer outside `layers` can never match a file, so it is a typo in
 * the consumer's config rather than a policy — surfaced as a config error, not silently ignored.
 */
const assertSegmentKeysNameLayers = (type: PackageType, entry: LayerEntry): void => {
  for (const key of Object.keys(entry.segments ?? {})) {
    const layer = key.endsWith(UNIT_KEY_SUFFIX) ? key.slice(0, -UNIT_KEY_SUFFIX.length) : key

    if (!entry.layers.includes(layer)) {
      throw new Error(
        `@wl/package-structure: \`${type}.segments\` key "${key}" names a layer that is not in \`${type}.layers\` (${entry.layers.join(', ')}).`,
      )
    }
  }
}

const LAYER_ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    layers: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      uniqueItems: true,
      description: 'First-level directories allowed under `src/`.',
    },
    segments: {
      type: 'object',
      propertyNames: { pattern: '^[^/]+(/\\*)?$' },
      additionalProperties: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        uniqueItems: true,
      },
      description:
        'Allowed directories one level down, keyed by `<layer>` (directly inside it) or `<layer>/*` (inside each of its folders).',
    },
    skill: {
      type: 'string',
      description: 'Skill or doc that owns this layout, appended to the message; `""` drops the sentence.',
    },
  },
  required: ['layers'],
  additionalProperties: false,
} as const

interface Violation {
  messageId: 'unknownLayer' | 'unknownSegment'
  /** The offending directory name. */
  name: string
  /** Where it sits, as the message names it: the layer, or `features/<unit>`. */
  scope: string
  allowed: string[]
}

/**
 * The directory `dirs[1]` or `dirs[2]` that `entry.segments` forbids, or null. Files directly inside
 * a layer or a unit (`features/<unit>/index.ts`) are not a segment and are never reported.
 */
const findSegmentViolation = (dirs: string[], entry: LayerEntry): Violation | null => {
  const [layer, second, third] = dirs
  const segments = entry.segments ?? {}
  const perUnit = segments[`${layer}${UNIT_KEY_SUFFIX}`]

  if (perUnit !== undefined) {
    return second !== undefined && third !== undefined && !perUnit.includes(third)
      ? { messageId: 'unknownSegment', name: third, scope: `${layer}/${second}`, allowed: perUnit }
      : null
  }

  const direct = segments[layer!]

  if (direct !== undefined && second !== undefined && !direct.includes(second)) {
    return { messageId: 'unknownSegment', name: second, scope: layer!, allowed: direct }
  }

  return null
}

const findViolation = (dirs: string[], entry: LayerEntry): Violation | null => {
  const layer = dirs[0]!

  if (!entry.layers.includes(layer)) {
    return { messageId: 'unknownLayer', name: layer, scope: 'src', allowed: entry.layers }
  }

  return findSegmentViolation(dirs, entry)
}

/** The violation `filename` commits under its package's entry, or null when exempt or allowed. */
const inspect = (
  filename: string,
  options: Options,
): { violation: Violation; type: PackageType; entry: LayerEntry } | null => {
  const packageRoot = findPackageRoot(filename)

  if (packageRoot === null) {
    return null
  }

  const dirs = dirsUnderSrc(packageRoot, filename)

  if (dirs === null || dirs.length === 0) {
    return null
  }

  const type = resolvePackageType(packageRoot)
  const entry = resolveEntry(type, options)

  if (entry === undefined) {
    return null
  }

  assertSegmentKeysNameLayers(type, entry)

  const violation = findViolation(dirs, entry)

  return violation === null ? null : { violation, type, entry }
}

export const packageStructure: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Allow only the `src/` layers, and the segments inside them, that belong to the package type.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#package-structure',
    },
    schema: [
      {
        type: 'object',
        properties: {
          frontend: LAYER_ENTRY_SCHEMA,
          backend: LAYER_ENTRY_SCHEMA,
          lib: LAYER_ENTRY_SCHEMA,
          e2e: LAYER_ENTRY_SCHEMA,
          mobile: LAYER_ENTRY_SCHEMA,
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional globs; the rule is skipped for matching files.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unknownLayer:
        '`{{name}}` is not an allowed `src/` layer for package type `{{type}}` (allowed: {{allowed}}).{{seeSkill}}',
      unknownSegment:
        '`{{name}}` is not an allowed segment of `{{scope}}` for package type `{{type}}` (allowed: {{allowed}}).{{seeSkill}}',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const ignore = options.ignore ?? []

    if (ignore.length > 0 && matchesAnyGlob(context.filename, ignore)) {
      return {}
    }

    const found = inspect(context.filename, options)

    if (found === null) {
      return {}
    }

    const { violation, type, entry } = found

    return {
      // Reported on Program so the IDE marks the file from line 1: every file under the offending
      // directory carries the same message, which is how a "red folder" surfaces in the explorer.
      Program(program) {
        context.report({
          node: program,
          messageId: violation.messageId,
          data: {
            name: violation.name,
            scope: violation.scope,
            type,
            allowed: violation.allowed.join(', '),
            // Message templates have no conditionals, so the optional sentence is assembled here.
            seeSkill: entry.skill ? ` See ${entry.skill} for the ${type} layout.` : '',
          },
        })
      },
    }
  },
}
