import type { Rule } from 'eslint'
import type { CallExpression, Expression, Node, ObjectExpression, SpreadElement } from 'estree'

import { findPackageRoot } from './package-root'
import { resolvePackageType } from './package-type-reader'

export type PlaywrightCallKind = 'test' | 'describe'

// Modifiers that keep a call a test / describe declaration; `step`, `use`, `beforeEach` and the
// rest are not declarations and carry no title or tags of their own.
const TEST_MODIFIERS = new Set(['only', 'skip', 'fixme', 'fail'])
const DESCRIBE_MODIFIERS = new Set(['only', 'skip', 'fixme', 'serial', 'parallel'])

/** `test.describe.serial` → `['test', 'describe', 'serial']`; null for anything but a plain name chain. */
const calleeNames = (callee: Expression | Node): string[] | null => {
  if (callee.type === 'Identifier') {
    return [callee.name]
  }

  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') {
    return null
  }

  const head = calleeNames(callee.object)

  return head === null ? null : [...head, callee.property.name]
}

/**
 * Whether `node` declares a Playwright test or describe block, read from its callee alone.
 *
 * @example
 * playwrightCallKind(parse("test.describe.serial('Checkout', () => {})")) // => 'describe'
 */
export const playwrightCallKind = (node: CallExpression): PlaywrightCallKind | null => {
  const names = calleeNames(node.callee)

  if (names === null || names[0] !== 'test') {
    return null
  }

  const [, second, ...rest] = names

  if (second === undefined) {
    return 'test'
  }

  if (second === 'describe') {
    const isDescribe = rest.every((name) => {
      return DESCRIBE_MODIFIERS.has(name)
    })

    return isDescribe ? 'describe' : null
  }

  return rest.length === 0 && TEST_MODIFIERS.has(second) ? 'test' : null
}

/** The `{ tag, annotation }` details object, present only in the three-argument form. */
export const detailsArgument = (node: CallExpression): ObjectExpression | null => {
  const details: Expression | SpreadElement | undefined = node.arguments[1]

  return node.arguments.length >= 3 && details?.type === 'ObjectExpression' ? details : null
}

/** A title that is a plain string: a literal, or a template without expressions. */
export const staticTitle = (node: CallExpression): string | null => {
  const title = node.arguments[0]

  if (title?.type === 'Literal' && typeof title.value === 'string') {
    return title.value
  }

  if (title?.type === 'TemplateLiteral' && title.expressions.length === 0) {
    return title.quasis[0]?.value.cooked ?? null
  }

  return null
}

/** True when the linted file belongs to a package whose type resolves to `e2e`. */
export const isInE2ePackage = (context: Rule.RuleContext): boolean => {
  const packageRoot = findPackageRoot(context.filename.split('\\').join('/'))

  return packageRoot !== null && resolvePackageType(packageRoot) === 'e2e'
}
