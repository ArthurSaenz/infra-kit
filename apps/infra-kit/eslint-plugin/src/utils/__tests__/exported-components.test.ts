import tsParser from '@typescript-eslint/parser'
import type * as ESTree from 'estree'
import { describe, expect, it } from 'vitest'

import { collectExportedComponents } from '../exported-components'

const names = (code: string): Array<string | null> => {
  const program = tsParser.parse(code, { ecmaFeatures: { jsx: true }, sourceType: 'module', range: true, loc: true })

  return collectExportedComponents(program as unknown as ESTree.Program).map((component) => {
    return component.name
  })
}

describe('collectExportedComponents', () => {
  it('collects every exported declaration form', () => {
    expect(names('export const A = () => <div />')).toEqual(['A'])
    expect(names('export function B() { return <div /> }')).toEqual(['B'])
    expect(names('export default function C() { return <div /> }')).toEqual(['C'])
    expect(names('const D = () => <div />\nexport { D }')).toEqual(['D'])
    expect(names('const E = () => <div />\nexport default E')).toEqual(['E'])
    expect(names('export default () => <div />')).toEqual([null])
  })

  it('counts a component exported twice once', () => {
    expect(names('const D = () => <div />\nexport { D }\nexport default D')).toEqual(['D'])
  })

  it('skips re-exports, local-only components and non-components', () => {
    expect(names("export { X } from './x'")).toEqual([])
    expect(names('const F = () => <div />')).toEqual([])
    expect(names('export const value = 1\nexport const fn = () => 1')).toEqual([])
  })
})
