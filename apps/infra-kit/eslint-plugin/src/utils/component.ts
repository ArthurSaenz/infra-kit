import type * as ESTree from 'estree'

export type ComponentFunction = ESTree.ArrowFunctionExpression | ESTree.FunctionDeclaration | ESTree.FunctionExpression

// Minimal structural view over the `parent` back-reference ESLint adds to every node.
interface WithParent {
  parent?: ESTree.Node
}

// Calls that wrap a component while preserving its identity (memo, forwardRef, observer, ...).
const COMPONENT_WRAPPER_CALLEES = new Set(['memo', 'forwardRef', 'observer', 'React.memo', 'React.forwardRef'])

// Node types that introduce a new function scope — their returns are not the outer component's.
const NESTED_SCOPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

const isPascalCase = (name: string): boolean => {
  return /^[A-Z]/.test(name)
}

export const isJsxNode = (node: ESTree.Node | null | undefined): boolean => {
  if (!node) {
    return false
  }

  const type = node.type as string

  return type === 'JSXElement' || type === 'JSXFragment'
}

const getParent = (node: ESTree.Node | undefined): ESTree.Node | undefined => {
  return (node as (WithParent & ESTree.Node) | undefined)?.parent
}

/** Best-effort name of a call's callee: `memo` for `memo(...)`, `React.memo` for `React.memo(...)`. */
const getCalleeName = (callee: ESTree.CallExpression['callee']): string | null => {
  if (callee.type === 'Identifier') {
    return callee.name
  }

  if (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.property.type === 'Identifier'
  ) {
    return `${callee.object.name}.${callee.property.name}`
  }

  return null
}

/**
 * Resolve the declared name of a function, looking through component wrappers
 * such as `memo`/`forwardRef` so that `const Comp = memo(({ a }) => ...)` is
 * still recognised by its PascalCase variable name.
 */
export const getComponentName = (node: ComponentFunction): string | null => {
  if (node.type === 'FunctionDeclaration') {
    return node.id?.name ?? null
  }

  let current = getParent(node)

  // Walk through wrapping call expressions (memo, forwardRef, React.memo, ...).
  while (current?.type === 'CallExpression') {
    const calleeName = getCalleeName(current.callee)

    if (!calleeName || !COMPONENT_WRAPPER_CALLEES.has(calleeName)) {
      break
    }

    current = getParent(current)
  }

  if (current?.type === 'VariableDeclarator' && current.id.type === 'Identifier') {
    return current.id.name
  }

  return null
}

/**
 * Collect every *own* return argument of a function — the expression of each
 * `return <expr>` reachable without entering a nested function scope, plus the
 * implicit-return body of an expression-bodied arrow.
 *
 * Bare `return;` (a null argument) contributes nothing, so callers never receive
 * a null and can safely walk each result. This is the multi-return counterpart
 * to the boolean `returnsJsx`, which is defined in terms of it; the deliberate
 * "skip nested scopes" behaviour answers *which* returns belong to this function
 * (a `return` inside an inline `.map`/IIFE callback is that callback's return,
 * not this one's).
 */
export const collectOwnReturnArguments = (node: ComponentFunction): ESTree.Expression[] => {
  if (node.body.type !== 'BlockStatement') {
    return [node.body]
  }

  const args: ESTree.Expression[] = []

  const visit = (current: ESTree.Node | null | undefined): void => {
    if (!current || NESTED_SCOPES.has(current.type)) {
      return
    }

    if (current.type === 'ReturnStatement') {
      if (current.argument) {
        args.push(current.argument)
      }

      return
    }

    if (current.type === 'IfStatement') {
      visit(current.consequent)
      visit(current.alternate)

      return
    }

    if (current.type === 'BlockStatement') {
      current.body.forEach(visit)

      return
    }

    if (current.type === 'SwitchStatement') {
      for (const switchCase of current.cases) {
        switchCase.consequent.forEach(visit)
      }

      return
    }

    if (current.type === 'TryStatement') {
      visit(current.block)
      visit(current.handler?.body)
      visit(current.finalizer)

      return
    }

    if (
      current.type === 'ForStatement' ||
      current.type === 'ForInStatement' ||
      current.type === 'ForOfStatement' ||
      current.type === 'WhileStatement' ||
      current.type === 'DoWhileStatement'
    ) {
      visit(current.body)
    }
  }

  node.body.body.forEach(visit)

  return args
}

/** Whether a function returns JSX, scanning its own body without descending into nested functions. */
const returnsJsx = (node: ComponentFunction): boolean => {
  return collectOwnReturnArguments(node).some(isJsxNode)
}

/** A function is treated as a React component when it is PascalCase-named or returns JSX. */
export const isComponent = (node: ComponentFunction): boolean => {
  const name = getComponentName(node)

  if (name && isPascalCase(name)) {
    return true
  }

  return returnsJsx(node)
}

const isComponentFunctionNode = (node: ESTree.Node): node is ComponentFunction => {
  return (
    node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration'
  )
}

/**
 * Extract the component function from an expression, unwrapping a single layer of
 * component wrappers (`memo(fn)`, `forwardRef(fn)`, `React.memo(fn)`, ...). Returns
 * null when no function is found.
 */
export const getComponentFunction = (node: ESTree.Node | null | undefined): ComponentFunction | null => {
  if (!node) {
    return null
  }

  if (isComponentFunctionNode(node)) {
    return node
  }

  if (node.type === 'CallExpression') {
    for (const argument of node.arguments) {
      if (argument.type === 'SpreadElement') {
        continue
      }

      const found = getComponentFunction(argument)

      if (found) {
        return found
      }
    }
  }

  return null
}

// TS-only nodes are not modelled by estree. A parameter's `typeAnnotation` wraps the type node;
// for a named type that inner node is a `TSTypeReference` whose `typeName` is the referenced
// identifier (`Props`, `ButtonProps`, ...). Inline object types, qualified names (`NS.Props`) and
// generics surface a different `typeName` shape and are intentionally left unresolved.
interface TypeReferenceNode {
  type?: string
  typeName?: { type?: string; name?: string }
}

interface AnnotatedParam {
  typeAnnotation?: {
    typeAnnotation?: TypeReferenceNode
  }
}

/**
 * The parameter that actually carries the props type annotation. A default value wraps the
 * parameter in an `AssignmentPattern` (`(props: Props = {})`), moving the annotation onto its
 * `.left`; unwrap one layer so the annotation is found either way.
 */
export const getAnnotatedParam = (param: ESTree.Pattern): ESTree.Pattern => {
  return param.type === 'AssignmentPattern' ? param.left : param
}

/** The named type referenced by a component function's first parameter (`Props`), or null. */
export const getPropsTypeNameFromFunction = (node: ComponentFunction): string | null => {
  const firstParam = node.params[0]

  if (!firstParam) {
    return null
  }

  const inner = (getAnnotatedParam(firstParam) as AnnotatedParam).typeAnnotation?.typeAnnotation

  if (inner?.type !== 'TSTypeReference' || inner.typeName?.type !== 'Identifier') {
    return null
  }

  return inner.typeName.name ?? null
}

/**
 * Resolve the props type name a component *uses* — the named type on its first parameter —
 * looking through component wrappers (`memo`/`forwardRef`). Returns null when the component is
 * anonymous of props (no parameter) or its props type is not a simple named reference (inline
 * object, qualified name, generic). Mirrors `getDeclaredComponentName`'s node dispatch so a
 * `const`-declared arrow component resolves through its `init`, not the `VariableDeclaration`.
 */
export const getComponentPropsTypeName = (node: ESTree.Node | null): string | null => {
  if (!node) {
    return null
  }

  if (node.type === 'FunctionDeclaration') {
    return isComponent(node) ? getPropsTypeNameFromFunction(node) : null
  }

  if (node.type === 'VariableDeclaration') {
    for (const declaration of node.declarations) {
      const fn = getComponentFunction(declaration.init)

      if (fn && isComponent(fn)) {
        return getPropsTypeNameFromFunction(fn)
      }
    }

    return null
  }

  const fn = getComponentFunction(node)

  return fn && isComponent(fn) ? getPropsTypeNameFromFunction(fn) : null
}

/** Unwrap an `export ...` statement to the declaration it wraps (or the statement itself). */
export const unwrapExport = (statement: ESTree.Statement | ESTree.ModuleDeclaration): ESTree.Node | null => {
  if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration') {
    return (statement.declaration as ESTree.Node | null) ?? null
  }

  return statement
}

/** Whether a single top-level declaration declares a React component. */
export const declaresComponent = (node: ESTree.Node | null): boolean => {
  if (!node) {
    return false
  }

  if (node.type === 'FunctionDeclaration') {
    return isComponent(node)
  }

  if (node.type === 'VariableDeclaration') {
    return node.declarations.some((declaration) => {
      const fn = getComponentFunction(declaration.init)

      return fn ? isComponent(fn) : false
    })
  }

  const fn = getComponentFunction(node)

  return fn ? isComponent(fn) : false
}

/**
 * Resolve the name of the React component declared by a single top-level declaration,
 * or null when the declaration is not a component or the component is anonymous
 * (e.g. `export default () => <div />`). Mirrors `declaresComponent`'s node dispatch and
 * resolves the name through component wrappers (`memo`/`forwardRef`).
 */
export const getDeclaredComponentName = (node: ESTree.Node | null): string | null => {
  if (!node) {
    return null
  }

  if (node.type === 'FunctionDeclaration') {
    return isComponent(node) ? getComponentName(node) : null
  }

  if (node.type === 'VariableDeclaration') {
    for (const declaration of node.declarations) {
      const fn = getComponentFunction(declaration.init)

      if (fn && isComponent(fn)) {
        return getComponentName(fn)
      }
    }

    return null
  }

  const fn = getComponentFunction(node)

  return fn && isComponent(fn) ? getComponentName(fn) : null
}

/** Whether any top-level statement in a program body declares a React component. */
export const bodyDeclaresComponent = (body: Array<ESTree.Statement | ESTree.ModuleDeclaration>): boolean => {
  return body.some((statement) => {
    return declaresComponent(unwrapExport(statement))
  })
}
