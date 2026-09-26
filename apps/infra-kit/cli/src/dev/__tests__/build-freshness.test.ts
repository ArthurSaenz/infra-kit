import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildInfoCoversOutputs,
  findStaleSources,
  formatBuildErrors,
  readLatestBuildInfo,
  readPackageName,
  summarizeBuildErrors,
} from 'src/dev/build-freshness'
import type { BuildInfo } from 'src/dev/build-freshness'

import { createTempTracker } from './fixtures'

const temp = createTempTracker()

afterEach(() => {
  temp.cleanup()
})

const sha256 = (text: string): string => {
  return createHash('sha256').update(text).digest('hex')
}

/** A package dir holding `files` (relative path → text) plus a `package.json` named `name`. */
const makePackage = (files: Record<string, string>, name = '@pkg/lib-core'): string => {
  const dir = temp.register(fs.mkdtempSync(path.join(os.tmpdir(), 'build-freshness-')))

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }))

  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }

  return dir
}

const writeBuildInfo = (dir: string, data: object, name = 'tsconfig.tsbuildinfo'): string => {
  const file = path.join(dir, name)

  fs.writeFileSync(file, JSON.stringify(data))

  return file
}

const read = (dir: string): BuildInfo => {
  const info = readLatestBuildInfo(dir)

  expect(info).toBeDefined()

  return info!
}

const VERSION_SRC = "export const LIB_VERSION: string = 'v1'\n"
const INDEX_SRC = "export { LIB_VERSION } from './version.js'\n"

describe('readLatestBuildInfo', () => {
  it('is undefined when the package has no buildinfo', () => {
    expect(readLatestBuildInfo(makePackage({}))).toBeUndefined()
  })

  it('is undefined for a torn (unparseable) buildinfo — tsc may be mid-write', () => {
    const dir = makePackage({})

    fs.writeFileSync(path.join(dir, 'tsconfig.tsbuildinfo'), '{"fileNames":[')

    expect(readLatestBuildInfo(dir)).toBeUndefined()
  })

  it('picks the newest of the package-root and dist buildinfos', () => {
    const dir = makePackage({ 'dist/index.js': '' })
    const old = writeBuildInfo(dir, { version: 'old' })
    const fresh = writeBuildInfo(path.join(dir, 'dist'), { version: 'fresh' }, 'tsconfig.build.tsbuildinfo')

    fs.utimesSync(old, new Date(1000), new Date(1000))
    fs.utimesSync(fresh, new Date(), new Date())

    const info = read(dir)

    expect(info.dir).toBe(path.join(dir, 'dist'))
    expect(info.data).toMatchObject({ version: 'fresh' })
  })
})

describe('buildInfoCoversOutputs', () => {
  it('holds for outputs written before the buildinfo (tsc writes it last), or already unlinked', () => {
    const dir = makePackage({ 'dist/index.js': '' })
    const output = path.join(dir, 'dist', 'index.js')

    fs.utimesSync(output, new Date(1000), new Date(1000))
    writeBuildInfo(dir, {})

    expect(buildInfoCoversOutputs(read(dir), [output, path.join(dir, 'dist', 'gone.js')])).toBe(true)
  })

  it('fails for an output newer than the buildinfo — a turbo cache restore, which never writes the buildinfo', () => {
    const dir = makePackage({ 'dist/index.js': '' })
    const buildInfo = writeBuildInfo(dir, {})

    fs.utimesSync(buildInfo, new Date(1000), new Date(1000))

    expect(buildInfoCoversOutputs(read(dir), [path.join(dir, 'dist', 'index.js')])).toBe(false)
  })
})

describe('summarizeBuildErrors', () => {
  it('is undefined for a clean build (no diagnostics keys)', () => {
    const dir = makePackage({})

    writeBuildInfo(dir, { fileNames: ['./src/version.ts'], fileInfos: [sha256(VERSION_SRC)] })

    expect(summarizeBuildErrors(read(dir), dir)).toBeUndefined()
  })

  it('names the first type error by file, code and message, with a count of the rest', () => {
    const dir = makePackage({})

    writeBuildInfo(dir, {
      fileNames: ['../lib.d.ts', './src/version.ts', './src/index.ts'],
      semanticDiagnosticsPerFile: [
        [2, [{ code: 2322, category: 1, messageText: "Type 'number' is not assignable to type 'string'." }]],
        [3, [{ code: 2304, category: 1, messageText: { messageText: "Cannot find name 'x'.", next: [] } }]],
      ],
    })

    const errors = summarizeBuildErrors(read(dir), dir)

    expect(errors).toEqual({
      file: path.join('src', 'version.ts'),
      detail: "TS2322 Type 'number' is not assignable to type 'string'.",
      total: 2,
    })
    expect(formatBuildErrors('@pkg/lib-core', errors!)).toBe(
      `@pkg/lib-core has type errors: ${path.join('src', 'version.ts')} TS2322 Type 'number' is not assignable to type 'string'. (+1 more)`,
    )
  })

  it('reports emit diagnostics (e.g. isolatedDeclarations) the same way', () => {
    const dir = makePackage({})

    writeBuildInfo(dir, {
      fileNames: ['./src/a.ts'],
      emitDiagnosticsPerFile: [[1, [{ code: 9007, messageText: 'Function must have an explicit return type.' }]]],
    })

    expect(formatBuildErrors('p', summarizeBuildErrors(read(dir), dir)!)).toBe(
      `p has type errors: ${path.join('src', 'a.ts')} TS9007 Function must have an explicit return type.`,
    )
  })

  it('reports a bare file id — a file a syntax error kept from being type-checked', () => {
    const dir = makePackage({})

    writeBuildInfo(dir, { fileNames: ['./src/version.ts'], semanticDiagnosticsPerFile: [1] })

    expect(formatBuildErrors('p', summarizeBuildErrors(read(dir), dir)!)).toBe(
      `p has errors: ${path.join('src', 'version.ts')} was not type-checked (syntax error)`,
    )
  })

  it('falls back to a generic clause for a top-level errors flag', () => {
    const dir = makePackage({})

    writeBuildInfo(dir, { fileNames: [], errors: true })

    expect(formatBuildErrors('p', summarizeBuildErrors(read(dir), dir)!)).toBe('p has build errors (see the watch log)')
  })
})

describe('findStaleSources', () => {
  it('is empty when every own source hashes to its recorded version (string and object forms)', () => {
    const dir = makePackage({ 'src/version.ts': VERSION_SRC, 'src/index.ts': INDEX_SRC })

    writeBuildInfo(dir, {
      fileNames: ['./src/version.ts', './src/index.ts'],
      fileInfos: [sha256(VERSION_SRC), { version: sha256(INDEX_SRC), signature: 'x' }],
    })

    expect(findStaleSources(read(dir), dir)).toEqual([])
  })

  it('reports a source whose text is not what the build compiled, with its current hash', () => {
    const next = "export const LIB_VERSION: string = 'v2'\n"
    const dir = makePackage({ 'src/version.ts': next, 'src/index.ts': INDEX_SRC })

    writeBuildInfo(dir, {
      fileNames: ['./src/version.ts', './src/index.ts'],
      fileInfos: [sha256(VERSION_SRC), sha256(INDEX_SRC)],
    })

    expect(findStaleSources(read(dir), dir)).toEqual([
      { file: path.join(dir, 'src', 'version.ts'), hash: sha256(next) },
    ])
  })

  it('never hashes inputs outside the package or under node_modules', () => {
    const dir = makePackage({ 'node_modules/dep/index.d.ts': 'changed', 'src/version.ts': VERSION_SRC })
    const sibling = path.join(path.dirname(dir), 'other.d.ts')

    writeBuildInfo(dir, {
      fileNames: ['../other.d.ts', './node_modules/dep/index.d.ts', './src/version.ts'],
      fileInfos: ['not-the-hash', 'not-the-hash', sha256(VERSION_SRC)],
    })

    expect(fs.existsSync(sibling)).toBe(false)
    expect(findStaleSources(read(dir), dir)).toEqual([])
  })

  it('treats a source deleted mid-burst as not stale', () => {
    const dir = makePackage({})

    writeBuildInfo(dir, { fileNames: ['./src/gone.ts'], fileInfos: ['whatever'] })

    expect(findStaleSources(read(dir), dir)).toEqual([])
  })

  it('hashes the text without its UTF-8 BOM, as TypeScript does', () => {
    const dir = makePackage({ 'src/version.ts': String.fromCharCode(0xfeff) + VERSION_SRC })

    writeBuildInfo(dir, { fileNames: ['./src/version.ts'], fileInfos: [sha256(VERSION_SRC)] })

    expect(findStaleSources(read(dir), dir)).toEqual([])
  })
})

describe('readPackageName', () => {
  it('reads package.json, falling back to the directory name', () => {
    const named = makePackage({}, '@pkg/types')
    const unnamed = makePackage({})

    fs.rmSync(path.join(unnamed, 'package.json'))

    expect(readPackageName(named)).toBe('@pkg/types')
    expect(readPackageName(unnamed)).toBe(path.basename(unnamed))
  })
})

describe('against a buildinfo written by the real tsc -b', () => {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')

  const build = (dir: string): void => {
    try {
      execFileSync(process.execPath, [tsc, '-b'], { cwd: dir, stdio: 'ignore' })
    } catch {
      // A type error exits 1 and still emits — the case under test.
    }
  }

  it('reads its type errors, then a clean build, then a save it did not compile', () => {
    const dir = makePackage({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          composite: true,
          strict: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022'],
          types: [],
          skipLibCheck: true,
          rootDir: './src',
          outDir: './dist',
        },
        include: ['src'],
      }),
      'src/version.ts': 'export const LIB_VERSION: string = 42\n',
    })

    build(dir)

    expect(fs.existsSync(path.join(dir, 'dist', 'version.js'))).toBe(true)
    expect(formatBuildErrors('@pkg/lib-core', summarizeBuildErrors(read(dir), dir)!)).toBe(
      `@pkg/lib-core has type errors: ${path.join('src', 'version.ts')} TS2322 Type 'number' is not assignable to type 'string'.`,
    )

    fs.writeFileSync(path.join(dir, 'src', 'version.ts'), VERSION_SRC)
    build(dir)

    expect(summarizeBuildErrors(read(dir), dir)).toBeUndefined()
    expect(findStaleSources(read(dir), dir)).toEqual([])

    fs.writeFileSync(path.join(dir, 'src', 'version.ts'), "export const LIB_VERSION: string = 'v2'\n")

    expect(
      findStaleSources(read(dir), dir).map((s) => {
        return s.file
      }),
    ).toEqual([path.join(dir, 'src', 'version.ts')])
  }, 30_000)
})
