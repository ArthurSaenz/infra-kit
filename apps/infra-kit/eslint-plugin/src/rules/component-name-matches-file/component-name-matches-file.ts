import type { Rule, Scope } from 'eslint'
import type * as ESTree from 'estree'
import path from 'node:path'

import { isInScope, isStoryOrTestFile, isUiPackageFile } from '../../utils/component-file-scope'
import type { ExportedComponent } from '../../utils/exported-components'
import { collectExportedComponents } from '../../utils/exported-components'

interface Options {
  paths?: string[]
  ignore?: string[]
}

// Route/page entry files and design-system primitives follow their framework's naming, not the
// feature `*-component` / `*-container` convention.
// Shared libraries (ui-kit, `lib/`) name files by concept, not by component; the convention binds
// feature code and any file that already opts in with the suffix.
export const DEFAULT_PATHS = ['**/features/**', '**/*-component.tsx', '**/*-container.tsx']

export const DEFAULT_IGNORE = ['**/pages/**', '**/routes/**', '**/renderer/**', '**/primitives/**']

const SUFFIX_BY_DIR: Record<string, string> = {
  components: '-component',
  containers: '-container',
}

const toPascalCase = (basename: string): string => {
  return basename
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => {
      return part[0]!.toUpperCase() + part.slice(1)
    })
    .join('')
}

/**
 * The suffix the nearest `components/` or `containers/` folder inside a feature requires, or null elsewhere. Shared
 * `src/components/<name>/<name>.tsx` libraries follow their own folder-per-component layout.
 */
const requiredSuffix = (dirs: readonly string[]): { dir: string; suffix: string } | null => {
  const featureRoot = dirs.indexOf('features') + 2

  const index = dirs.findLastIndex((name, position) => {
    return name in SUFFIX_BY_DIR && featureRoot > 1 && position >= featureRoot
  })

  if (index === -1) {
    return null
  }

  const dir = dirs[index]!

  return { dir, suffix: SUFFIX_BY_DIR[dir]! }
}

const findVariable = (sourceCode: Rule.RuleContext['sourceCode'], component: ExportedComponent) => {
  return sourceCode.getDeclaredVariables(component.declaration!).find((variable) => {
    return variable.name === component.name
  })
}

const renameFix = (variable: Scope.Variable, expected: string): Rule.ReportFixer => {
  return (fixer) => {
    const nodes = [
      ...variable.identifiers,
      ...variable.references.map((reference) => {
        return reference.identifier
      }),
    ]

    // `export { X }` parses local and exported as two nodes over one range; one edit covers both.
    const ranges = new Map(
      nodes.map((node) => {
        return [node.range!.join(':'), node.range!] as const
      }),
    )

    return [...ranges.values()].map((range) => {
      return fixer.replaceTextRange(range, expected)
    })
  }
}

export const componentNameMatchesFile: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    hasSuggestions: true,
    docs: {
      description:
        "Require a `.tsx` file's exported component to be named after the file (`abroad-slider-component.tsx` → `AbroadSliderComponent`), and files under `components/` / `containers/` to end with `-component` / `-container`.",
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#component-name-matches-file',
    },
    schema: [
      {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: `Glob patterns of files to check. Replaces the default (${DEFAULT_PATHS.join(', ')}).`,
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: `Glob patterns of files to skip, even if they also match \`paths\`. Replaces the default (${DEFAULT_IGNORE.join(', ')}).`,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      nameMismatch: 'The exported component in `{{file}}` must be named `{{expected}}`, but it is named `{{actual}}`.',
      wrongSuffix: 'A file under `{{dir}}/` must be named `*{{suffix}}.tsx`, but it is `{{file}}`.',
      renameComponent: 'Rename `{{actual}}` to `{{expected}}`.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const filename = context.filename.split('\\').join('/')
    const file = path.posix.basename(filename)

    if (
      !file.endsWith('.tsx') ||
      file === 'index.tsx' ||
      isStoryOrTestFile(filename) ||
      !isInScope(filename, options.paths ?? DEFAULT_PATHS, options.ignore ?? DEFAULT_IGNORE) ||
      !isUiPackageFile(filename)
    ) {
      return {}
    }

    const basename = file.slice(0, -'.tsx'.length)
    const expected = toPascalCase(basename)

    return {
      Program(program) {
        const suffixRule = requiredSuffix(path.posix.dirname(filename).split('/'))

        if (suffixRule && !basename.endsWith(suffixRule.suffix)) {
          context.report({
            node: program,
            loc: { line: 1, column: 0 },
            messageId: 'wrongSuffix',
            data: { ...suffixRule, file },
          })
        }

        const named = collectExportedComponents(program).filter((component) => {
          return component.name !== null
        })

        // With several exports the intended one is ambiguous; `max-components-per-file` owns that case.
        if (named.length !== 1 || named[0]!.name === expected) {
          return
        }

        const component = named[0]!
        const actual = component.name!
        const variable = findVariable(context.sourceCode, component)
        const moduleScope = context.sourceCode.getScope(program).childScopes[0] ?? context.sourceCode.getScope(program)
        const nameTaken = moduleScope.set.has(expected)

        context.report({
          node: component.id as ESTree.Node,
          messageId: 'nameMismatch',
          data: { file, expected, actual },
          suggest:
            variable && !nameTaken
              ? [{ messageId: 'renameComponent', data: { actual, expected }, fix: renameFix(variable, expected) }]
              : [],
        })
      },
    }
  },
}
