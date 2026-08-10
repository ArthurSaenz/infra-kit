import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The resolver is CommonJS on purpose (eslint-module-utils loads resolvers with `require`),
// so it is required here the same way its real caller does.
const require_ = createRequire(import.meta.url)
const resolver = require_('../resolvers/root-alias.cjs') as {
  interfaceVersion: number
  resolve: (
    source: string,
    file: string,
    config?: { alias?: string; baseDir?: string; extensions?: string[] },
  ) => { found: boolean; path?: string }
}

// A resolver that fails to resolve produces NO lint output at all — boundaries simply cannot
// classify the target, so the import goes unpoliced. Every branch below therefore pins a case
// that would otherwise turn into a silent miss.
let root: string

const write = (rel: string, body = 'export const x = 1\n') => {
  const abs = path.join(root, rel)

  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, body)

  return abs
}

// Importer used as the `file` argument; only its directory matters for package-root lookup.
const importer = () => path.join(root, 'src/features/beta/x.ts')

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wl-root-alias-')))
  writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture" }\n')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('root-alias resolver: contract', () => {
  it('declares interfaceVersion 2', () => {
    expect(resolver.interfaceVersion).toBe(2)
  })

  it('passes non-alias specifiers to the next resolver', () => {
    expect(resolver.resolve('../alpha', importer())).toEqual({ found: false })
    expect(resolver.resolve('jotai', importer())).toEqual({ found: false })
    expect(resolver.resolve('./local/util', importer())).toEqual({ found: false })
  })

  it('does not claim a specifier that merely starts with the alias name', () => {
    expect(resolver.resolve('#rootless/thing', importer())).toEqual({ found: false })
    expect(resolver.resolve('#root', importer())).toEqual({ found: false })
  })
})

describe('root-alias resolver: extension resolution', () => {
  it.each([
    ['.ts', 'src/features/alpha/thing.ts'],
    ['.tsx', 'src/features/alpha/widget.tsx'],
    ['.js', 'src/features/alpha/legacy.js'],
    ['.jsx', 'src/features/alpha/legacy-view.jsx'],
    ['.mts', 'src/features/alpha/modern.mts'],
    ['.json', 'src/features/alpha/data.json'],
  ])('resolves an extensionless specifier to %s', (_extension, rel) => {
    const abs = write(rel, rel.endsWith('.json') ? '{}\n' : undefined)
    const specifier = `#root/${rel.slice('src/'.length).replace(/\.[^.]+$/, '')}`

    expect(resolver.resolve(specifier, importer())).toEqual({ found: true, path: abs })
  })

  it('resolves a specifier that already carries its extension', () => {
    const abs = write('src/features/alpha/explicit.ts')

    expect(resolver.resolve('#root/features/alpha/explicit.ts', importer())).toEqual({
      found: true,
      path: abs,
    })
  })

  it('prefers .ts over .js when both exist', () => {
    write('src/features/alpha/both.js')
    const ts = write('src/features/alpha/both.ts')

    expect(resolver.resolve('#root/features/alpha/both', importer())).toEqual({ found: true, path: ts })
  })
})

describe('root-alias resolver: directory index', () => {
  it('resolves a directory to its index file — the barrel form the convention uses', () => {
    const abs = write('src/features/gamma/index.ts')

    expect(resolver.resolve('#root/features/gamma', importer())).toEqual({ found: true, path: abs })
  })

  it('resolves a nested directory barrel', () => {
    const abs = write('src/shared/index.ts')

    expect(resolver.resolve('#root/shared', importer())).toEqual({ found: true, path: abs })
  })

  it('reports not-found for a directory without an index', () => {
    mkdirSync(path.join(root, 'src/features/empty'), { recursive: true })

    expect(resolver.resolve('#root/features/empty', importer())).toEqual({ found: false })
  })

  it('reports not-found for a target that does not exist', () => {
    expect(resolver.resolve('#root/features/nope', importer())).toEqual({ found: false })
  })
})

describe('root-alias resolver: package root discovery', () => {
  it('anchors on the nearest package.json, not the importing directory', () => {
    const abs = write('src/features/alpha/deep.ts')
    const deepImporter = path.join(root, 'src/features/beta/containers/nested/deep/x.ts')

    expect(resolver.resolve('#root/features/alpha/deep', deepImporter)).toEqual({ found: true, path: abs })
  })

  it('anchors on an inner package when one exists — monorepo nesting', () => {
    const inner = path.join(root, 'packages/inner')
    mkdirSync(inner, { recursive: true })
    writeFileSync(path.join(inner, 'package.json'), '{ "name": "inner" }\n')

    const abs = write('packages/inner/src/features/own/index.ts')
    const innerImporter = path.join(inner, 'src/features/other/x.ts')

    expect(resolver.resolve('#root/features/own', innerImporter)).toEqual({ found: true, path: abs })
  })
})

describe('root-alias resolver: configurability', () => {
  it('honours a custom baseDir', () => {
    const abs = write('app/features/delta/index.ts')

    expect(resolver.resolve('#root/features/delta', importer(), { baseDir: 'app' })).toEqual({
      found: true,
      path: abs,
    })
  })

  it('honours a custom alias', () => {
    const abs = write('src/features/epsilon/index.ts')

    expect(resolver.resolve('@/features/epsilon', importer(), { alias: '@/' })).toEqual({
      found: true,
      path: abs,
    })
  })
})
