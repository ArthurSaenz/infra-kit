import type * as ESTree from 'estree'

export type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.FunctionDeclaration | ESTree.FunctionExpression

// Keys that are never child AST nodes (back-reference + source positions + the discriminant).
const NON_CHILD_KEYS = new Set(['parent', 'loc', 'range', 'type'])

const LOOP_TYPES = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'])
const NESTED_FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

// Mutable walk context: the running score plus the enclosing function's name (for recursion).
interface Ctx {
  score: number
  name: string | null
}

const isNode = (value: unknown): value is ESTree.Node => {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

/**
 * The direct child AST nodes of `node`, read generically from its own enumerable
 * properties (skipping `parent`/`loc`/`range`). estree does not model JSX, but JSX
 * nodes still carry a string `type`, so embedded `&&`/ternaries are reached too.
 */
const childrenOf = (node: ESTree.Node): ESTree.Node[] => {
  const children: ESTree.Node[] = []

  for (const key of Object.keys(node)) {
    if (NON_CHILD_KEYS.has(key)) {
      continue
    }

    const value = (node as unknown as Record<string, unknown>)[key]

    if (Array.isArray(value)) {
      children.push(...value.filter(isNode))
    } else if (isNode(value)) {
      children.push(value)
    }
  }

  return children
}

// Flatten a logical chain into its operand leaves while collecting operators in order.
const flattenLogicalOperators = (node: ESTree.Node, operators: string[]): ESTree.Node[] => {
  if (node.type !== 'LogicalExpression') {
    return [node]
  }

  const left = flattenLogicalOperators(node.left, operators)

  operators.push(node.operator)

  const right = flattenLogicalOperators(node.right, operators)

  return [...left, ...right]
}

// Score = number of contiguous runs of the SAME operator (`a && b && c` → 1, `a && b || c` → 2).
const countOperatorRuns = (operators: string[]): number => {
  let runs = 0
  let previous: string | null = null

  for (const operator of operators) {
    if (operator !== previous) {
      runs += 1
      previous = operator
    }
  }

  return runs
}

const recurseChildren = (ctx: Ctx, node: ESTree.Node, nesting: number): void => {
  for (const child of childrenOf(node)) {
    walk(ctx, child, nesting)
  }
}

const handleLogical = (ctx: Ctx, node: ESTree.LogicalExpression, nesting: number): void => {
  const operators: string[] = []
  const operands = flattenLogicalOperators(node, operators)

  ctx.score += countOperatorRuns(operators)

  for (const operand of operands) {
    walk(ctx, operand, nesting)
  }
}

const handleAlternate = (ctx: Ctx, alternate: ESTree.Statement | null | undefined, nesting: number): void => {
  if (!alternate) {
    return
  }

  // `else if` (the alternate IS another `if`): +1 with no nesting bump, processed
  // inline so the chained `if` does not also take its own structural increment.
  if (alternate.type === 'IfStatement') {
    ctx.score += 1
    walk(ctx, alternate.test, nesting)
    walk(ctx, alternate.consequent, nesting + 1)
    handleAlternate(ctx, alternate.alternate, nesting)

    return
  }

  // plain `else`: +1, body nested one level.
  ctx.score += 1
  walk(ctx, alternate, nesting + 1)
}

const handleIf = (ctx: Ctx, node: ESTree.IfStatement, nesting: number): void => {
  ctx.score += 1 + nesting
  walk(ctx, node.test, nesting)
  walk(ctx, node.consequent, nesting + 1)
  handleAlternate(ctx, node.alternate, nesting)
}

const handleTernary = (ctx: Ctx, node: ESTree.ConditionalExpression, nesting: number): void => {
  ctx.score += 1 + nesting
  walk(ctx, node.test, nesting)
  walk(ctx, node.consequent, nesting + 1)
  walk(ctx, node.alternate, nesting + 1)
}

const handleSwitch = (ctx: Ctx, node: ESTree.SwitchStatement, nesting: number): void => {
  ctx.score += 1 + nesting
  walk(ctx, node.discriminant, nesting)

  for (const switchCase of node.cases) {
    if (switchCase.test) {
      walk(ctx, switchCase.test, nesting)
    }

    for (const statement of switchCase.consequent) {
      walk(ctx, statement, nesting + 1)
    }
  }
}

const handleLoop = (ctx: Ctx, node: ESTree.Node, nesting: number): void => {
  ctx.score += 1 + nesting

  const body = (node as { body?: ESTree.Node }).body

  for (const child of childrenOf(node)) {
    // The loop body nests one level; conditions/headers stay at this level.
    walk(ctx, child, child === body ? nesting + 1 : nesting)
  }
}

const handleTry = (ctx: Ctx, node: ESTree.TryStatement, nesting: number): void => {
  walk(ctx, node.block, nesting)

  if (node.handler) {
    ctx.score += 1 + nesting
    walk(ctx, node.handler.body, nesting + 1)
  }

  if (node.finalizer) {
    walk(ctx, node.finalizer, nesting)
  }
}

const handleCall = (ctx: Ctx, node: ESTree.CallExpression, nesting: number): void => {
  if (ctx.name && node.callee.type === 'Identifier' && node.callee.name === ctx.name) {
    ctx.score += 1
  }

  recurseChildren(ctx, node, nesting)
}

function walk(ctx: Ctx, node: ESTree.Node, nesting: number): void {
  const type = node.type as string

  if (type === 'LogicalExpression') {
    handleLogical(ctx, node as ESTree.LogicalExpression, nesting)
  } else if (type === 'IfStatement') {
    handleIf(ctx, node as ESTree.IfStatement, nesting)
  } else if (type === 'ConditionalExpression') {
    handleTernary(ctx, node as ESTree.ConditionalExpression, nesting)
  } else if (type === 'SwitchStatement') {
    handleSwitch(ctx, node as ESTree.SwitchStatement, nesting)
  } else if (LOOP_TYPES.has(type)) {
    handleLoop(ctx, node, nesting)
  } else if (type === 'TryStatement') {
    handleTry(ctx, node as ESTree.TryStatement, nesting)
  } else if (NESTED_FUNCTION_TYPES.has(type)) {
    // Nested functions take no structural increment, but their bodies nest one level.
    walk(ctx, (node as FunctionNode).body, nesting + 1)
  } else if (type === 'CallExpression') {
    handleCall(ctx, node as ESTree.CallExpression, nesting)
  } else {
    recurseChildren(ctx, node, nesting)
  }
}

/**
 * Cognitive complexity of a function per the SonarSource white-paper model.
 *
 * Each `if`/ternary/switch/loop/`catch` adds 1 plus the current nesting level;
 * `else`/`else if` adds 1 with no nesting bump; each run of a logical operator
 * adds 1; recursion (a direct call to the enclosing function by name) adds 1.
 * Nesting deepens inside every branch, loop, switch, `catch`, and nested function.
 *
 * @example
 * cognitiveComplexity(node) // 0 for a flat function, 1 for a single `if`
 */
export const cognitiveComplexity = (fn: FunctionNode, enclosingName?: string | null): number => {
  const fallbackName = fn.type === 'FunctionDeclaration' ? (fn.id?.name ?? null) : null
  const ctx: Ctx = { score: 0, name: enclosingName ?? fallbackName }

  walk(ctx, fn.body, 0)

  return ctx.score
}
