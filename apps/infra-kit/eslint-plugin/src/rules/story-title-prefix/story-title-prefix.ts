import type { Rule } from 'eslint'
import type { Expression, Node, ObjectExpression, Program, Property } from 'estree'

import { dirsUnderSrc, findPackageRoot } from '../../utils/package-root'
import { resolvePackageType } from '../../utils/package-type-reader'
import { matchesAnyGlob } from '../../utils/path-match'

export interface Options {
  /** Globs; the rule is skipped for matching files. */
  ignore?: string[]
}

const STORY_FILE = /\.stories\.[cm]?[jt]sx?$/
const FEATURES = 'features'
const SHARED = 'components'

/** The `src/` directories of `filename`, or null outside `src/`. Virtual paths fall back to the last `src` segment. */
const srcDirs = (packageRoot: string | null, filename: string): string[] | null => {
  if (packageRoot !== null) {
    return dirsUnderSrc(packageRoot, filename)
  }

  const dirs = filename.split('/').slice(0, -1)
  const srcIndex = dirs.lastIndexOf('src')

  return srcIndex >= 0 ? dirs.slice(srcIndex + 1) : null
}

/**
 * The first title segment(s) a story must carry: `features/<name>` inside a feature, otherwise the
 * `src/` layer in a frontend package and `components` in a lib package (which has no layers).
 * Null when the rule does not apply.
 */
export const expectedPrefix = (filename: string): string | null => {
  const packageRoot = findPackageRoot(filename)
  // Virtual filenames (tests, editors' unsaved buffers) have no package to read; judge them as frontend.
  const type = packageRoot === null ? 'frontend' : resolvePackageType(packageRoot)

  if (type !== 'frontend' && type !== 'lib') {
    return null
  }

  const dirs = srcDirs(packageRoot, filename)

  if (dirs === null) {
    return null
  }

  const [layer, unit] = dirs

  if (layer === FEATURES && unit !== undefined) {
    return `${FEATURES}/${unit}`
  }

  // `src/__stories__/` and files directly in `src/` belong to no layer.
  if (type === 'lib' || layer === undefined || layer.startsWith('__')) {
    return SHARED
  }

  return layer
}

const TS_WRAPPERS = new Set(['TSSatisfiesExpression', 'TSAsExpression'])

// estree's `Node` union has no TS node types, so the wrappers are matched by their type string.
const unwrap = (node: Node | null | undefined): Node | null | undefined => {
  let current = node

  while (current !== null && current !== undefined && TS_WRAPPERS.has(current.type)) {
    current = (current as unknown as { expression: Node }).expression
  }

  return current
}

/** The object literal behind `export default`, directly or through a top-level `const meta = { … }`. */
const findMeta = (program: Program): ObjectExpression | null => {
  const exported = program.body.find((statement) => {
    return statement.type === 'ExportDefaultDeclaration'
  })

  if (exported?.type !== 'ExportDefaultDeclaration') {
    return null
  }

  let target = unwrap(exported.declaration as Node)

  if (target?.type === 'Identifier') {
    const name = target.name

    for (const statement of program.body) {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

      if (declaration?.type !== 'VariableDeclaration') {
        continue
      }

      const declarator = declaration.declarations.find((candidate) => {
        return candidate.id.type === 'Identifier' && candidate.id.name === name
      })

      if (declarator !== undefined) {
        target = unwrap(declarator.init)
        break
      }
    }
  }

  return target?.type === 'ObjectExpression' ? target : null
}

const findTitle = (meta: ObjectExpression): Property | undefined => {
  return meta.properties.find((property): property is Property => {
    return (
      property.type === 'Property' &&
      !property.computed &&
      ((property.key.type === 'Identifier' && property.key.name === 'title') ||
        (property.key.type === 'Literal' && property.key.value === 'title'))
    )
  })
}

/** A static string value, or null for anything computed (which the rule cannot judge). */
const staticString = (value: Expression): string | null => {
  if (value.type === 'Literal' && typeof value.value === 'string') {
    return value.value
  }

  if (value.type === 'TemplateLiteral' && value.expressions.length === 0) {
    return value.quasis[0]?.value.cooked ?? null
  }

  return null
}

/** Swaps the title's wrong prefix for `prefix`: `features/<x>/` counts as two segments, anything else as one. */
const retitle = (title: string, prefix: string): string => {
  const segments = title.split('/')

  if (segments.length === 1) {
    return `${prefix}/${title}`
  }

  return [prefix, ...segments.slice(segments[0] === FEATURES && segments.length > 2 ? 2 : 1)].join('/')
}

const quote = (value: Expression, text: string): string => {
  const mark = value.type === 'TemplateLiteral' ? '`' : (((value as { raw?: string }).raw ?? "'")[0] ?? "'")
  const escaped = text.split('\\').join('\\\\').split(mark).join(`\\${mark}`)

  return `${mark}${escaped}${mark}`
}

export const storyTitlePrefix: Rule.RuleModule = {
  meta: {
    type: 'problem',
    hasSuggestions: true,
    docs: {
      description:
        'Require a Storybook title to start with the story’s place in `src/`: `features/<name>/` inside a feature, `components/` for shared components.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#story-title-prefix',
    },
    schema: [
      {
        type: 'object',
        properties: {
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
      wrongPrefix:
        'Story title `{{title}}` must start with `{{prefix}}/` — the first title segment mirrors where the story sits in `src/` (`features/<name>/` for a feature, `components/` for shared components).',
      missingTitle:
        'Story meta has no `title`. Set one starting with `{{prefix}}/` — the first title segment mirrors where the story sits in `src/`.',
      usePrefix: 'Rename to `{{title}}`.',
    },
  },

  create(context) {
    const filename = context.filename.split('\\').join('/')
    const options = (context.options[0] ?? {}) as Options
    const ignore = options.ignore ?? []

    if (!STORY_FILE.test(filename) || (ignore.length > 0 && matchesAnyGlob(filename, ignore))) {
      return {}
    }

    const prefix = expectedPrefix(filename)

    if (prefix === null) {
      return {}
    }

    return {
      Program(program) {
        const meta = findMeta(program)

        if (meta === null) {
          return
        }

        const titleProperty = findTitle(meta)

        if (titleProperty === undefined) {
          context.report({ node: meta, messageId: 'missingTitle', data: { prefix } })

          return
        }

        const value = titleProperty.value as Expression
        const title = staticString(value)

        if (title === null || title.startsWith(`${prefix}/`)) {
          return
        }

        const fixed = retitle(title, prefix)

        context.report({
          node: value,
          messageId: 'wrongPrefix',
          data: { title, prefix },
          suggest: [
            {
              messageId: 'usePrefix',
              data: { title: fixed },
              fix: (fixer) => {
                return fixer.replaceText(value, quote(value, fixed))
              },
            },
          ],
        })
      },
    }
  },
}
