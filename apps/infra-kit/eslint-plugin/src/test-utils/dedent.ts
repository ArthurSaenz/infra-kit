// Tagged template for inline RuleTester `code`/`output` snippets: strips the leading newline, the
// trailing newline + indentation, and the common leading indentation, so a case can be written as
// readable, naturally-indented source while the linted string has no stray indentation. The result
// is byte-identical to the equivalent `[...lines].join('\n')`, which matters for the exact-match
// `output` (autofix) assertions. Blank lines are ignored when computing the common indent and are
// preserved verbatim. Usage:
//   dedent`
//     const Comp = (props) => {
//       const { a } = props
//
//       return a
//     }
//   `
export const dedent = (strings: TemplateStringsArray, ...values: unknown[]): string => {
  const raw = strings.reduce((acc, part, i) => {
    return acc + part + (i < values.length ? String(values[i]) : '')
  }, '')
  const body = raw.replace(/^\n/, '').replace(/\n[ \t]*$/, '')
  const lines = body.split('\n')
  const indents = lines
    .filter((line) => {
      return line.trim() !== ''
    })
    .map((line) => {
      return line.match(/^[ \t]*/)?.[0].length ?? 0
    })
  const common = indents.length > 0 ? Math.min(...indents) : 0

  return lines
    .map((line) => {
      return line.slice(common)
    })
    .join('\n')
}
