import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import packageJson from '../../../package.json' with { type: 'json' }
import { buildMcpBundle } from './helpers/mcp-harness'

/**
 * Dependency-manifest and bundle-externalization guards for the SDK v1 → v2 migration.
 *
 * These exist because `scripts/build.js` derives esbuild's `external` list from
 * `Object.keys(packageJson.dependencies)`. That derivation is why a manifest mistake does not
 * ERROR — it silently INLINES an entire SDK into `dist/mcp.js` and the build still succeeds.
 * Every assertion below is written to fail loudly on that specific silent failure.
 */

const CLI_ROOT = resolve(__dirname, '../../..')
const SRC = resolve(CLI_ROOT, 'src')

/** Every `.ts`/`.tsx` file under `src/` that is NOT part of a `__tests__/` directory. */
const nonTestSourceFiles = (): string[] => {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((rel) => {
      return /\.tsx?$/.test(rel) && !rel.split('/').includes('__tests__')
    })
    .map((rel) => {
      return join(SRC, rel)
    })
}

/** Bare `@modelcontextprotocol/*` package names imported by a file (subpaths collapsed to the package). */
const mcpPackagesImportedBy = (file: string): string[] => {
  const text = readFileSync(file, 'utf8')
  const matches = text.matchAll(/from\s*['"](@modelcontextprotocol\/[a-z-]+)(?:\/[^'"]*)?['"]/g)

  return [
    ...new Set(
      [...matches].flatMap((m) => {
        return m[1] === undefined ? [] : [m[1]]
      }),
    ),
  ]
}

describe('u6 — no v1 SDK import survives outside tests', () => {
  /**
   * The v1 `@modelcontextprotocol/sdk` is retained ONLY as a devDependency, purely so the e2e
   * lane can drive the migrated server with a genuine 2025-era client. A single stray import in
   * shipped source would put a devDependency on the runtime path — and because devDeps are not in
   * `external`, esbuild would inline the whole v1 SDK into the bundle without erroring.
   */
  it('u6: zero `@modelcontextprotocol/sdk` imports in non-test source', () => {
    const offenders = nonTestSourceFiles().filter((file) => {
      return mcpPackagesImportedBy(file).includes('@modelcontextprotocol/sdk')
    })

    expect(offenders, `v1 SDK imported from shipped source:\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('u7 — the manifest matches what the source actually imports', () => {
  const deps = packageJson.dependencies as Record<string, string>
  const devDeps = packageJson.devDependencies as Record<string, string>

  /**
   * The `external` list is derived from `dependencies`, so a package imported by shipped source
   * but absent from `dependencies` is inlined silently. This is the positive direction of that rule.
   */
  it('u7a: every @modelcontextprotocol/* package imported from non-test source is in `dependencies`', () => {
    const imported = [
      ...new Set(
        nonTestSourceFiles().flatMap((file) => {
          return mcpPackagesImportedBy(file)
        }),
      ),
    ].sort()

    // Guards against the assertion silently passing on an empty set if the walker ever breaks.
    expect(imported.length).toBeGreaterThan(0)

    for (const pkg of imported) {
      expect(deps, `${pkg} is imported by shipped source but missing from dependencies`).toHaveProperty(pkg)
    }
  })

  it('u7b: the v1 sdk and the v2 client are devDependencies and are in neither `dependencies`', () => {
    for (const pkg of ['@modelcontextprotocol/sdk', '@modelcontextprotocol/client']) {
      expect(devDeps, `${pkg} must be a devDependency`).toHaveProperty(pkg)
      expect(deps, `${pkg} must NOT be a runtime dependency`).not.toHaveProperty(pkg)
    }
  })

  it('u7c: no `catalog:` protocol appears in runtime dependencies', () => {
    const catalogged = Object.entries(deps)
      .filter(([, range]) => {
        return range.startsWith('catalog:')
      })
      .map(([name]) => {
        return name
      })

    expect(catalogged, 'catalog: in runtime deps breaks install on npm AND pnpm').toEqual([])
  })
})

/**
 * Frozen snapshot of the PRE-CHANGE entry, copied once at implementation time from
 * `git show e15aec3:apps/infra-kit/cli/src/entry/mcp.ts` and trimmed to the imports plus the
 * `startServer` create/connect block.
 *
 * It is a `const`, not a `git show` at test time, on purpose. A control that reads `HEAD` holds
 * only until this work is committed: the moment it lands, `HEAD` IS the new entry, the guard
 * accepts it, and the control goes red on the ordinary success path. Two `logger.error` lines whose
 * argument was a backticked string were elided so this stays a plain template literal; every marker
 * the guard reads survives the trim, and u8c asserts that before using it.
 */
const PRE_CHANGE_ENTRY_SNAPSHOT = `
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import process from 'node:process'

import { setupErrorHandlers } from 'src/lib/error-handlers'
import { initLoggerMcp } from 'src/lib/logger'

import { createMcpServer } from '../mcp/server'

const logger = initLoggerMcp()

const startServer = async () => {
  let server

  try {
    server = await createMcpServer()

    logger.info('MCP Server instance created')
  } catch (error) {
    logger.error({ err: error, msg: 'Failed to create MCP server' })

    process.exit(1)
  }

  try {
    const transport = new StdioServerTransport()

    await server.connect(transport)

    logger.info({ msg: 'Server connected to transport. Ready.' })
  } catch (error) {
    logger.error({ err: error, msg: 'Failed to initialize server' })

    process.exit(1)
  }
}

setupErrorHandlers(logger)

startServer()
`

/** The AC1/AC2 markers of `src/entry/mcp.ts`, read out of the file's TEXT. */
interface EntryShape {
  callsConnect: boolean
  callsServeStdio: boolean
  constructsLegacyTransport: boolean
  onerrorFlushes: boolean
  onerrorLogsError: boolean
  passesOnerror: boolean
}

/**
 * Body of the `onerror:` arrow handed to `serveStdio`, or `''` when the entry passes no such arrow.
 *
 * Brace-matched rather than regex-matched: a lazy `[\s\S]*?` running up to the closing brace
 * backtracks super-linearly and this repo's lint rejects it outright.
 */
const onerrorBody = (source: string): string => {
  const marker = source.indexOf('onerror:')
  const open = marker === -1 ? -1 : source.indexOf('{', marker)

  if (open === -1) return ''

  let depth = 0

  for (const [offset, char] of [...source.slice(open)].entries()) {
    if (char === '{') depth += 1
    if (char === '}') depth -= 1

    if (depth === 0) return source.slice(open + 1, open + offset)
  }

  return source.slice(open + 1)
}

/**
 * ONE text-taking predicate, three consumers: `u8a` reads the transport markers, `u8b` the
 * `onerror` markers, and `u8c` inverts the whole verdict against the frozen snapshot. A control
 * that exercised different code from the guard would prove nothing about the guard.
 */
const inspectEntry = (source: string): EntryShape => {
  const body = onerrorBody(source)

  return {
    callsConnect: source.includes('.connect('),
    callsServeStdio: source.includes('serveStdio('),
    constructsLegacyTransport: source.includes('new StdioServerTransport('),
    onerrorFlushes: body.includes('logger.flush'),
    onerrorLogsError: body.includes('logger.error'),
    passesOnerror: source.includes('onerror'),
  }
}

/** The whole-shape verdict — every AC1 and AC2 marker at once. */
const isServeStdioEntry = (source: string): boolean => {
  const shape = inspectEntry(source)

  return (
    shape.callsServeStdio &&
    !shape.constructsLegacyTransport &&
    !shape.callsConnect &&
    shape.passesOnerror &&
    shape.onerrorLogsError &&
    shape.onerrorFlushes
  )
}

describe('u8 — the shipped MCP entry is on `serveStdio` (AC1/AC2)', () => {
  const entrySource = readFileSync(resolve(SRC, 'entry/mcp.ts'), 'utf8')

  it('u8a: the entry calls `serveStdio(` and neither constructs nor connects a transport itself', () => {
    // `serveStdio` owns the transport. A surviving `new StdioServerTransport()` + `.connect()` is
    // how the entry would silently keep serving the 2025 era from an otherwise migrated build.
    expect(inspectEntry(entrySource)).toMatchObject({
      callsConnect: false,
      callsServeStdio: true,
      constructsLegacyTransport: false,
    })
  })

  it('u8b: `onerror` is passed and its body calls both `logger.error` and `logger.flush`', () => {
    // `onerror` is mandatory under `serveStdio`: without it transport errors vanish entirely. The
    // `flush` half matters just as much — pino buffers, so an unflushed error line dies with the
    // process it was written to explain.
    expect(inspectEntry(entrySource)).toMatchObject({
      onerrorFlushes: true,
      onerrorLogsError: true,
      passesOnerror: true,
    })
  })

  it('u8c: the shared predicate ACCEPTS the entry and REJECTS the frozen pre-change snapshot', () => {
    // V14 — guard the snapshot against degenerating. The predicate rejects ANY string lacking
    // `serveStdio(`, so an empty or over-trimmed constant would make the rejection below pass while
    // proving nothing about the pre-change shape. Assert the markers are actually there FIRST.
    expect(PRE_CHANGE_ENTRY_SNAPSHOT, 'snapshot trimmed past the marker it exists to carry').toContain(
      'new StdioServerTransport(',
    )
    expect(PRE_CHANGE_ENTRY_SNAPSHOT, 'snapshot trimmed past the marker it exists to carry').toContain(
      'await server.connect(',
    )

    expect(isServeStdioEntry(entrySource), 'the guard rejects the migrated entry — it is inverted').toBe(true)
    expect(isServeStdioEntry(PRE_CHANGE_ENTRY_SNAPSHOT), 'the guard accepts the pre-change entry — it is vacuous').toBe(
      false,
    )
  })
})

describe('b1–B3 — the v2 SDK is externalized, never inlined', () => {
  let bundle = ''
  const tmpDirs: string[] = []

  /**
   * Built hermetically in-test from the EXPORTED `buildOptions`, never from a checked-out `dist/`:
   * `dist` is gitignored, `qa` has no build step, and turbo's `test` task depends on `^build`
   * (dependencies, not self) — so a committed `dist/` would make every assertion here vacuous.
   *
   * Output goes under this package's `node_modules/.cache` rather than `os.tmpdir()` because
   * `buildOptions` leaves dependencies external: the bundle only resolves them by walking up to a
   * `node_modules` directory that exists above it.
   *
   * Both invariants live in `buildMcpBundle`, which is why this delegates rather than re-deriving
   * them: a second copy is how one of them silently drifts and the guards here quietly go vacuous.
   */
  beforeAll(async () => {
    const built = await buildMcpBundle('mcp-bundle-guards-')

    tmpDirs.push(built.outDir)

    bundle = readFileSync(built.mcpPath, 'utf8')
  }, 120_000)

  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  it('b1: the bare `@modelcontextprotocol/server` specifier survives as an import', () => {
    expect(bundle).toMatch(/from\s*["']@modelcontextprotocol\/server["']/)
  })

  it('b2: the `@modelcontextprotocol/server/stdio` SUBPATH specifier survives as an import', () => {
    // A subpath is the interesting case: `external` lists package keys, not subpaths. If this
    // fails, B1 will fail too — diagnose the `external` derivation in scripts/build.js rather
    // than patching the array.
    expect(bundle).toMatch(/from\s*["']@modelcontextprotocol\/server\/stdio["']/)
  })

  it('b3: no SDK protocol-table string literal is present (i.e. no SDK source was inlined)', () => {
    // Deliberately asserts on STRING LITERALS, not identifiers. `buildOptions.minify` is true
    // (scripts/build.js), so esbuild renames identifiers — a marker like
    // `SUPPORTED_MODERN_PROTOCOL_VERSIONS` is mangled away and would report clean on a fully
    // inlined bundle. String literals survive minification, so these cannot be false greens.
    expect(bundle, 'v2 SDK protocol table inlined into the bundle').not.toContain('2026-07-28')
    expect(bundle, 'SDK protocol table inlined into the bundle').not.toContain('2025-11-25')
  })

  it('b3-meta: the literals it looks for really do appear in the un-externalized SDK', () => {
    // Without this, B3 could pass simply because the literals never existed anywhere — the same
    // vacuity that killed the identifier-based version of this check.
    const stdioSrc = readFileSync(resolve(CLI_ROOT, 'node_modules/@modelcontextprotocol/server/dist/stdio.mjs'), 'utf8')

    expect(stdioSrc).toContain('2026-07-28')
  })
})
