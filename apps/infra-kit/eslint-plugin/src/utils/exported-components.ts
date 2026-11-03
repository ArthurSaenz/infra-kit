import type * as ESTree from 'estree'

import type { ComponentFunction } from './component'
import { getComponentFunction, isComponent } from './component'

export interface ExportedComponent {
  /** Local (declared) name, or null for an anonymous default export. */
  name: string | null
  /** The identifier that declares the name, or null for an anonymous default export. */
  id: ESTree.Identifier | null
  /** The node a variable lookup resolves the declaration from (`getDeclaredVariables`). */
  declaration: ESTree.FunctionDeclaration | ESTree.VariableDeclarator | null
  fn: ComponentFunction
}

type TopLevelStatement = ESTree.Statement | ESTree.ModuleDeclaration

const fromFunctionDeclaration = (node: ESTree.FunctionDeclaration): ExportedComponent | null => {
  if (!isComponent(node)) {
    return null
  }

  return { name: node.id?.name ?? null, id: node.id ?? null, declaration: node.id ? node : null, fn: node }
}

const fromVariableDeclaration = (node: ESTree.VariableDeclaration): ExportedComponent[] => {
  return node.declarations.flatMap((declarator) => {
    const fn = getComponentFunction(declarator.init)

    if (!fn || declarator.id.type !== 'Identifier' || !isComponent(fn)) {
      return []
    }

    return [{ name: declarator.id.name, id: declarator.id, declaration: declarator, fn }]
  })
}

const fromDeclaration = (node: ESTree.Node | null | undefined): ExportedComponent[] => {
  if (node?.type === 'FunctionDeclaration') {
    const component = fromFunctionDeclaration(node)

    return component ? [component] : []
  }

  if (node?.type === 'VariableDeclaration') {
    return fromVariableDeclaration(node)
  }

  return []
}

/** Top-level, non-exported component declarations by name, for resolving `export { X }`. */
const collectLocalComponents = (body: TopLevelStatement[]): Map<string, ExportedComponent> => {
  const local = new Map<string, ExportedComponent>()

  for (const statement of body) {
    for (const component of fromDeclaration(statement)) {
      if (component.name !== null) {
        local.set(component.name, component)
      }
    }
  }

  return local
}

const fromDefaultExport = (
  declaration: ESTree.ExportDefaultDeclaration['declaration'],
  local: Map<string, ExportedComponent>,
): ExportedComponent[] => {
  if (declaration.type === 'Identifier') {
    const component = local.get(declaration.name)

    return component ? [component] : []
  }

  const node = declaration as ESTree.Node

  if (node.type === 'FunctionDeclaration' && node.id) {
    return fromDeclaration(node)
  }

  const fn = getComponentFunction(node)

  return fn && isComponent(fn) ? [{ name: null, id: null, declaration: null, fn }] : []
}

const fromStatement = (statement: TopLevelStatement, local: Map<string, ExportedComponent>): ExportedComponent[] => {
  if (statement.type === 'ExportDefaultDeclaration') {
    return fromDefaultExport(statement.declaration, local)
  }

  if (statement.type !== 'ExportNamedDeclaration') {
    return []
  }

  if (statement.declaration) {
    return fromDeclaration(statement.declaration)
  }

  // `export { X } from './x'` is declared in another module.
  if (statement.source) {
    return []
  }

  return statement.specifiers.flatMap((specifier) => {
    const component = specifier.local.type === 'Identifier' ? local.get(specifier.local.name) : undefined

    return component ? [component] : []
  })
}

/**
 * The React components a module exports: `export const X = ...`, `export function X`,
 * `export default function X`, and `export { X }` / `export default X` of a local component.
 */
export const collectExportedComponents = (program: ESTree.Program): ExportedComponent[] => {
  const local = collectLocalComponents(program.body)

  const found = program.body.flatMap((statement) => {
    return fromStatement(statement, local)
  })

  return [...new Set(found)]
}
