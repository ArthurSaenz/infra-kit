/**
 * Variables substituted into a guidance resource. Every value is a string; an
 * empty one is meaningful (it is what removes a conditional bullet).
 */
type TemplateVars = Readonly<Record<string, string>>

/** Matches `{{name}}` anywhere in the template. */
const PLACEHOLDER = /\{\{(\w+)\}\}/g

/** Matches a list item whose entire content is one placeholder: `- {{readmeBullet}}`. */
const LONE_LIST_ITEM = /^- \{\{(\w+)\}\}$/

const collectPlaceholders = (template: string): Set<string> => {
  return new Set(
    [...template.matchAll(PLACEHOLDER)].map((match) => {
      return match[1] as string
    }),
  )
}

/**
 * Reject a supplied variable the template never mentions. Without this a renamed
 * placeholder would silently drop its value rather than failing — the caller
 * keeps passing `readmeBullet`, the file now says `{{readmeText}}`, and the
 * bullet renders as its own literal placeholder.
 */
const assertNoUnusedVars = (used: Set<string>, vars: TemplateVars): void => {
  const unused = Object.keys(vars).filter((name) => {
    return !used.has(name)
  })

  if (unused.length > 0) {
    throw new Error(`renderTemplate: variable(s) never used by the template: ${unused.join(', ')}`)
  }
}

const assertNoUnknownPlaceholders = (used: Set<string>, vars: TemplateVars): void => {
  const unknown = [...used].filter((name) => {
    return !(name in vars)
  })

  if (unknown.length > 0) {
    throw new Error(
      `renderTemplate: placeholder(s) with no variable: ${unknown
        .map((n) => {
          return `{{${n}}}`
        })
        .join(', ')}`,
    )
  }
}

/**
 * Drop a `- {{x}}` line whose value is empty, newline included.
 *
 * Evaluated on the **template**, never on the rendered result. On the result the
 * rule would also match the intentional blank-line-separated bullets under
 * `## Checks` once a value happened to render empty, and would eat structural
 * blank lines that carry no placeholder at all.
 *
 * The rule is deliberately marker-aware (`- ` required) rather than a general
 * "lone placeholder line" primitive. The general form — a bare `{{x}}` line — is
 * a markdown *paragraph* sitting next to a *list*, and prettier separates block
 * elements with a blank line, so it rewrites the resource on every format run.
 */
const dropEmptyListItems = (lines: readonly string[], vars: TemplateVars): string[] => {
  return lines.filter((line) => {
    const match = LONE_LIST_ITEM.exec(line)

    return match === null || vars[match[1] as string] !== ''
  })
}

/**
 * A multi-line value is only safe where the placeholder starts the line: anywhere
 * else its second and subsequent lines lose the prefix they were indented under,
 * which markdown reads as a different block. Fail rather than mis-indent.
 */
const assertMultilinePlaceholdersAtColumnZero = (lines: readonly string[], vars: TemplateVars): void => {
  for (const line of lines) {
    for (const match of line.matchAll(PLACEHOLDER)) {
      const value = vars[match[1] as string]

      if (value !== undefined && value.includes('\n') && match.index !== 0) {
        throw new Error(
          `renderTemplate: multi-line value for {{${match[1]}}} must start its line (found at column ${match.index})`,
        )
      }
    }
  }
}

/**
 * Substitute `{{name}}` placeholders in a guidance resource.
 *
 * Substitution is **single-pass**: the whole template is scanned once and each
 * match replaced from `vars`, so a `{{…}}` sequence appearing inside an injected
 * value is left alone. That matters because `packageName` comes from a
 * `package.json` on disk — successive `replaceAll` calls would re-substitute it.
 *
 * Throws in both directions (unknown placeholder, unused variable) so a resource
 * and its call site cannot drift apart silently.
 *
 * @example
 * renderTemplate('# {{packageName}}\n- {{readmeBullet}}', { packageName: '@x/y', readmeBullet: '' })
 * // => '# @x/y'
 */
export const renderTemplate = (template: string, vars: TemplateVars): string => {
  const used = collectPlaceholders(template)

  assertNoUnknownPlaceholders(used, vars)
  assertNoUnusedVars(used, vars)

  const lines = dropEmptyListItems(template.split('\n'), vars)

  assertMultilinePlaceholdersAtColumnZero(lines, vars)

  return lines.join('\n').replace(PLACEHOLDER, (_match, name: string) => {
    return vars[name] as string
  })
}
