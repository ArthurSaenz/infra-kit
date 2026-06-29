import tsParser from '@typescript-eslint/parser'
import type * as ESTree from 'estree'
import { describe, expect, it } from 'vitest'

import { dedent } from '../../test-utils/dedent'
import { cognitiveComplexity } from '../cognitive-complexity'
import type { FunctionNode } from '../cognitive-complexity'

// Parse a snippet and return its first top-level function (declaration or arrow/expression init).
const parseFunction = (code: string): FunctionNode => {
  const program = tsParser.parse(code, {
    ecmaFeatures: { jsx: true },
    ecmaVersion: 'latest',
    sourceType: 'module',
    loc: true,
  }) as unknown as ESTree.Program

  const statement = program.body[0]

  if (statement?.type === 'FunctionDeclaration') {
    return statement
  }

  if (statement?.type === 'VariableDeclaration') {
    const init = statement.declarations[0]?.init

    if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') {
      return init
    }
  }

  throw new Error('no function found in snippet')
}

const complexityOf = (code: string): number => {
  return cognitiveComplexity(parseFunction(code))
}

describe('cognitiveComplexity', () => {
  it('scores a flat function as 0', () => {
    expect(complexityOf('function f() { return 1 }')).toBe(0)
  })

  it('scores a single `if` as 1', () => {
    expect(complexityOf('function f(a) { if (a) { return 1 } }')).toBe(1)
  })

  it('adds the nesting level to an `if` inside a loop (1 + 2 = 3)', () => {
    const code = dedent`
      function f(items) {
        for (const x of items) {
          if (x) {
            return x
          }
        }
      }
    `

    expect(complexityOf(code)).toBe(3)
  })

  it('compounds nesting across loop -> if -> while (1 + 2 + 3 = 6)', () => {
    const code = dedent`
      function f(items) {
        for (const x of items) {
          if (x) {
            while (x.next) {
              doThing()
            }
          }
        }
      }
    `

    expect(complexityOf(code)).toBe(6)
  })

  it('counts an if/else-if/else chain flat (1 + 1 + 1 = 3)', () => {
    const code = dedent`
      function f(a) {
        if (a === 1) {
          return 1
        } else if (a === 2) {
          return 2
        } else {
          return 3
        }
      }
    `

    expect(complexityOf(code)).toBe(3)
  })

  it('counts a run of identical `&&` operators once', () => {
    expect(complexityOf('function f(a, b, c) { return a && b && c }')).toBe(1)
  })

  it('counts an alternation of `&&` and `||` as two runs', () => {
    expect(complexityOf('function f(a, b, c) { return a && b || c }')).toBe(2)
  })

  it('scores a ternary as 1', () => {
    expect(complexityOf('function f(a) { return a ? 1 : 2 }')).toBe(1)
  })

  it('scores a switch as 1', () => {
    const code = dedent`
      function f(a) {
        switch (a) {
          case 1:
            return 1
          default:
            return 2
        }
      }
    `

    expect(complexityOf(code)).toBe(1)
  })

  it('scores a try/catch (the catch) as 1', () => {
    const code = dedent`
      function f() {
        try {
          doThing()
        } catch (e) {
          handle(e)
        }
      }
    `

    expect(complexityOf(code)).toBe(1)
  })

  it('adds 1 for a direct recursive call', () => {
    expect(complexityOf('function f() { f() }')).toBe(1)
  })

  it('combines control flow and recursion (factorial = 2)', () => {
    const code = dedent`
      function f(n) {
        if (n <= 1) {
          return 1
        }

        return n * f(n - 1)
      }
    `

    expect(complexityOf(code)).toBe(2)
  })

  it('nests structures inside a nested function one level deeper (if = 2)', () => {
    const code = dedent`
      function f(items) {
        items.forEach(function inner(x) {
          if (x) {
            return x
          }
        })
      }
    `

    expect(complexityOf(code)).toBe(2)
  })

  it('treats `else { if }` as nested (not flat like `else if`)', () => {
    const code = dedent`
      function f(a, b) {
        if (a) {
          return 1
        } else {
          if (b) {
            return 2
          }
        }
      }
    `

    // if (+1) + else (+1) + nested if (+1+1) = 4.
    expect(complexityOf(code)).toBe(4)
  })

  it('uses an explicit enclosing name for arrow recursion', () => {
    const program = tsParser.parse('const f = () => { f() }', {
      ecmaVersion: 'latest',
      sourceType: 'module',
      loc: true,
    }) as unknown as ESTree.Program
    const statement = program.body[0]
    const init = statement?.type === 'VariableDeclaration' ? statement.declarations[0]?.init : null

    if (init?.type !== 'ArrowFunctionExpression') {
      throw new Error('expected an arrow function')
    }

    expect(cognitiveComplexity(init, 'f')).toBe(1)
  })
})
