import tsParser from '@typescript-eslint/parser'
import type * as ESTree from 'estree'
import { describe, expect, it } from 'vitest'

import { dedent } from '../../test-utils/dedent'
import { collectOwnReturnArguments, isJsxNode } from '../component'
import type { ComponentFunction } from '../component'

// Parse a snippet and return the first function node found via a shallow walk —
// enough for these fixtures, which each declare a single top-level function.
const firstFunction = (code: string): ComponentFunction => {
  const { ast } = tsParser.parseForESLint(code, {
    ecmaFeatures: { jsx: true },
    ecmaVersion: 'latest',
    sourceType: 'module',
  })

  let found: ComponentFunction | null = null

  const visit = (node: unknown): void => {
    if (found || typeof node !== 'object' || node === null) {
      return
    }

    const candidate = node as ESTree.Node

    if (
      candidate.type === 'ArrowFunctionExpression' ||
      candidate.type === 'FunctionDeclaration' ||
      candidate.type === 'FunctionExpression'
    ) {
      found = candidate

      return
    }

    for (const value of Object.values(candidate as unknown as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        value.forEach(visit)
      } else {
        visit(value)
      }
    }
  }

  visit(ast)

  if (!found) {
    throw new Error('no function node found in fixture')
  }

  return found
}

const returnTypes = (code: string): string[] => {
  return collectOwnReturnArguments(firstFunction(code)).map((node) => {
    return node.type as string
  })
}

describe('collectOwnReturnArguments', () => {
  // U1 — implicit-return arrow: the body itself is the single return argument.
  it('returns the implicit-return body of an expression-bodied arrow', () => {
    expect(returnTypes('const Foo = () => <div />')).toEqual(['JSXElement'])
  })

  // U2 — block with multi-branch `if`: both branch returns collected, in source order.
  it('collects both branches of an if/else, top to bottom', () => {
    const types = returnTypes(dedent`
      function Foo(flag) {
        if (flag) {
          return <a />
        }

        return <b />
      }
    `)

    expect(types).toEqual(['JSXElement', 'JSXElement'])
  })

  // U3 — control-flow arms inherited from returnsJsx: switch + try.
  it('collects returns inside switch cases and try blocks', () => {
    const switchTypes = returnTypes(dedent`
      function Foo(kind) {
        switch (kind) {
          case 'a':
            return <a />
          default:
            return <b />
        }
      }
    `)

    expect(switchTypes).toEqual(['JSXElement', 'JSXElement'])

    const tryTypes = returnTypes(dedent`
      function Foo() {
        try {
          return <a />
        } catch (error) {
          return <b />
        } finally {
          return <c />
        }
      }
    `)

    expect(tryTypes).toEqual(['JSXElement', 'JSXElement', 'JSXElement'])
  })

  // U4 — nested function scopes are skipped: an inline callback's return is NOT
  // this function's own return. This is the collection-side half of the invariant.
  it('skips returns inside nested function scopes', () => {
    const types = returnTypes(dedent`
      function Foo(items) {
        const renderItem = () => {
          return <li />
        }

        return <ul />
      }
    `)

    expect(types).toEqual(['JSXElement'])
  })

  // U5 — bare `return;` (null argument) contributes nothing.
  it('excludes bare return statements with no argument', () => {
    const types = returnTypes(dedent`
      function Foo(data) {
        if (!data) {
          return
        }

        return <div />
      }
    `)

    expect(types).toEqual(['JSXElement'])
  })

  // U6 — non-JSX returns are still collected (by node type), just not JSX.
  it('collects non-JSX return arguments', () => {
    const types = returnTypes(dedent`
      function helper() {
        return 1
      }
    `)

    expect(types).toEqual(['Literal'])
    expect(returnTypes('const helper = () => 1')).toEqual(['Literal'])
  })
})

describe('returnsJsx equivalence (the refactor contract)', () => {
  // U7 — for every fixture, returnsJsx === collectOwnReturnArguments(fn).some(isJsxNode).
  const cases: Array<{ name: string; code: string; expected: boolean }> = [
    { name: 'implicit-return JSX arrow', code: 'const Foo = () => <div />', expected: true },
    { name: 'implicit-return non-JSX arrow', code: 'const Foo = () => 1', expected: false },
    {
      name: 'block with a JSX return',
      code: dedent`
        function Foo() {
          return <div />
        }
      `,
      expected: true,
    },
    {
      name: 'block with only non-JSX returns',
      code: dedent`
        function helper() {
          return 1
        }
      `,
      expected: false,
    },
    {
      name: 'JSX only inside a nested callback',
      code: dedent`
        function Foo() {
          const render = () => <li />

          return null
        }
      `,
      expected: false,
    },
    {
      name: 'bare return guard then JSX',
      code: dedent`
        function Foo(data) {
          if (!data) return

          return <div />
        }
      `,
      expected: true,
    },
  ]

  it.each(cases)('matches some(isJsxNode) for $name', ({ code, expected }) => {
    const fn = firstFunction(code)

    expect(collectOwnReturnArguments(fn).some(isJsxNode)).toBe(expected)
  })
})
