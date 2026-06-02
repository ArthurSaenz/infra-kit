// Characters that must be escaped when embedded literally into a RegExp source.
const REGEX_METACHARS = new Set(['\\', '^', '$', '.', '|', '+', '(', ')', '[', ']', '{', '}'])

/**
 * Convert a glob pattern to an (unanchored) RegExp.
 *
 * - `**` matches any characters, including path separators.
 * - `*` matches any characters except a path separator.
 * - `?` matches a single non-separator character.
 *
 * The result is intentionally unanchored so a pattern matches anywhere in the
 * path (e.g. `features/**` matches `/repo/src/features/x/comp.tsx`).
 */
const globToRegExp = (glob: string): RegExp => {
  let source = ''

  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!

    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += '.*'
        index++

        // Consume a trailing slash so `**/foo` also matches a bare `foo`.
        if (glob[index + 1] === '/') {
          index++
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if (REGEX_METACHARS.has(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }

  return new RegExp(source)
}

/** Whether `filename` matches at least one of the provided glob `patterns`. */
export const matchesAnyGlob = (filename: string, patterns: readonly string[]): boolean => {
  const normalized = filename.split('\\').join('/')

  return patterns.some((pattern) => {
    return globToRegExp(pattern).test(normalized)
  })
}
