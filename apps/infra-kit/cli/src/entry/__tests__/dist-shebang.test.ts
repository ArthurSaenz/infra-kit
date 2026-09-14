import * as esbuild from 'esbuild'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import packageJson from '../../../package.json' with { type: 'json' }
import { buildOptions } from '../../../scripts/build.js'

/**
 * `dist/cli.js` must carry a hashbang and the library entries must not. esbuild
 * floats at `^0.28.x`, so a patch bump could relocate or drop it. Guard by
 * building fresh into a temp dir with the REAL build options — never by reading
 * `dist/`, which is gitignored and never produced by `pnpm run qa`.
 */
const SHEBANG = '#!/usr/bin/env node'

let outDir = ''
let metafile: esbuild.Metafile | undefined

const read = (fileName: string): string => {
  return readFileSync(join(outDir, fileName), 'utf8')
}

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'infra-kit-dist-shebang-'))

  // `metafile` is what makes the isolation guard below form-independent: it records which INPUTS
  // each output was built from, so a lazy `import()`, a `require`, or a subpath specifier like
  // `zod/v4` all show up as a `node_modules/` input — where a regex over import statements would
  // have to know every spelling in advance.
  ;({ metafile } = await esbuild.build({ ...buildOptions, outdir: outDir, metafile: true }))
}, 60_000)

afterAll(() => {
  rmSync(outDir, { force: true, recursive: true })
})

describe('dist hashbang', () => {
  it('puts the hashbang on line 1 of cli.js', () => {
    expect(
      read('cli.js').split('\n')[0],
      'no hashbang on dist/cli.js means `npm i -g infra-kit` installs a broken binary: the bin symlink execs the file directly and the shell tries to parse ESM',
    ).toBe(SHEBANG)
  })

  it.each(['dev-server.js', 'mcp.js'])('keeps the hashbang off the spawned entry %s', (fileName) => {
    expect(
      read(fileName).startsWith('#!'),
      `dist/${fileName} is spawned as \`node dist/${fileName}\`, never exec’d; a hashbang would imply it is a bin`,
    ).toBe(false)
  })

  /**
   * `ik-mcp` is a bin, so it needs what `cli.js` needs and what the spawned entries
   * must not have.
   */
  it('puts the hashbang on line 1 of mcp-proxy.js', () => {
    expect(
      read('mcp-proxy.js').split('\n')[0],
      'dist/mcp-proxy.js is published as the `ik-mcp` bin: npm symlinks it and the client execs it directly, so without a hashbang the shell tries to parse ESM',
    ).toBe(SHEBANG)
  })

  it('keeps the hashbang off the background worker update-check.js', () => {
    expect(
      read('update-check.js').startsWith('#!'),
      'dist/update-check.js is spawned as `node dist/update-check.js`, never exec’d; a hashbang would be dead weight and imply it is a bin',
    ).toBe(false)
  })
})

/**
 * `infra-kit` is a CLI and NOTHING ELSE. This is the invariant the whole global-install story rests on:
 * npm cannot install a package's `exports` without also installing its `bin`, and a local
 * `node_modules/.bin/infra-kit` shadows the global one. So the moment this package re-grows an importable
 * surface, some consumer's config imports it, that consumer must install it locally, and the global CLI
 * silently goes back to being dead weight — with nothing failing to say so.
 *
 * The importable surface lives in `@slip-stream-kit/config`. Keep it there.
 */
describe('infra-kit is bin-only', () => {
  it('publishes no importable entry point', () => {
    const manifest = packageJson as Record<string, unknown>

    for (const field of ['main', 'module', 'types', 'exports']) {
      expect(
        manifest[field],
        `package.json "${field}" makes infra-kit importable again — which forces consumers back to a local devDependency, whose node_modules/.bin/infra-kit then shadows the global install. Put the export in @slip-stream-kit/config instead.`,
      ).toBeUndefined()
    }
  })

  it('still declares the bin', () => {
    expect((packageJson as { bin?: Record<string, string> }).bin).toMatchObject({ 'infra-kit': 'dist/cli.js' })
  })

  it('declares the mcp proxy bin against its own entry, and no grafana-specific one', () => {
    const bin = (packageJson as { bin?: Record<string, string> }).bin

    expect(
      bin,
      'routing ik-mcp at dist/cli.js would drag commander, inquirer and cli.ts’s top-level side effects into a long-lived MCP server',
    ).toMatchObject({ 'ik-mcp': 'dist/mcp-proxy.js' })
    expect(bin?.['ik-grafana'], 'the Grafana-specific bin was never published and must not linger').toBeUndefined()
  })
})

/**
 * The background auto-update worker must be a DEDICATED bundle. If it ever pulled in `cli.js`, that
 * module's top-level side effects (`warnIfLocalInstall()`, `maybeAutoUpdate()`, the commander tree, the
 * no-arg interactive menu) would all run inside the detached child — and `maybeAutoUpdate()` would spawn
 * yet another child, recursively.
 */
describe('update-check worker isolation', () => {
  it('does not pull commander or the cli entry into dist/update-check.js', () => {
    const worker = read('update-check.js')

    expect(worker.includes('commander'), 'update-check.js must not bundle commander — it is not a CLI').toBe(false)
    expect(
      worker.includes('Running from a project-local node_modules'),
      'that string lives in cli.ts warnIfLocalInstall; its presence means update-check.js bundled the cli entry, so the detached child would re-spawn itself',
    ).toBe(false)
  })

  /**
   * The plugin step (`update-plugin.ts`) reaches into `src/lib/plugin-pointer`, whose pointer and
   * installer modules construct pino at import time. The worker must take only the lean modules
   * (`names.ts`, `claude-cli.ts`, `install-state.ts`): a detached child with an ignored stderr has no
   * use for a logger, and the plan for that step says it adds no heavy import to the worker.
   */
  it('keeps the logger (pino) out of dist/update-check.js and the chunks it reaches', () => {
    expect(metafile, 'the build must have produced a metafile').toBeDefined()

    const outputs = metafile!.outputs
    const entryKey = Object.keys(outputs).find((key) => {
      return key.endsWith('/update-check.js')
    })

    expect(entryKey, 'update-check.js must be one of the built outputs').toBeDefined()

    const closure = new Set<string>()
    const queue = [entryKey!]

    while (queue.length > 0) {
      const key = queue.shift()!

      if (closure.has(key)) continue
      closure.add(key)

      for (const imported of outputs[key]?.imports ?? []) {
        if (imported.path in outputs) queue.push(imported.path)
        else {
          expect(
            imported.path,
            `${key} imports "${imported.path}" — the worker must not load the logger (or any package) at boot`,
          ).not.toMatch(/^pino/)
        }
      }
    }

    for (const key of closure) {
      expect(
        Object.keys(outputs[key]!.inputs).filter((input) => {
          return input.startsWith('src/lib/logger/')
        }),
        `${key} was built from src/lib/logger — some plugin-pointer import pulled the pino singleton into the worker`,
      ).toEqual([])
    }
  })

  it('keeps the hashbang off every shared chunk', () => {
    const chunks = readdirSync(outDir).filter((fileName) => {
      return fileName.startsWith('chunk-') && fileName.endsWith('.js')
    })

    expect(
      chunks.length,
      'code splitting emits shared chunks; zero of them means this guard tests nothing',
    ).toBeGreaterThan(0)

    for (const chunk of chunks) {
      expect(
        read(chunk).startsWith('#!'),
        `a hashbang on the shared chunk ${chunk} would be imported by every entry, breaking library consumers`,
      ).toBe(false)
    }
  })

  /**
   * The proxy bundle and every chunk it reaches must be built from `src/` and Node builtins only.
   *
   * Asserted from esbuild's metafile, not from grepping import statements: `zx` is externalized
   * without `sideEffects: false`, so esbuild keeps a bare `import "zx"` even when the loader code is
   * tree-shaken away, and a lazy `import()` only moves it into a chunk. Walking the output closure's
   * INPUTS catches every spelling — static, dynamic, `require`, subpath — because the bundler already
   * resolved them.
   */
  it('keeps every node_modules input — zx, zod, commander included — out of mcp-proxy.js and the chunks it reaches', () => {
    expect(metafile, 'the build must have produced a metafile').toBeDefined()

    const outputs = metafile!.outputs
    const entryKey = Object.keys(outputs).find((key) => {
      return key.endsWith('/mcp-proxy.js')
    })

    expect(entryKey, 'mcp-proxy.js must be one of the built outputs').toBeDefined()

    // Transitive closure over the chunks the entry imports (static AND dynamic — the metafile
    // lists both under `imports`).
    const closure = new Set<string>()
    const queue = [entryKey!]

    while (queue.length > 0) {
      const key = queue.shift()!

      if (closure.has(key)) continue
      closure.add(key)

      for (const imported of outputs[key]?.imports ?? []) {
        if (imported.path in outputs) queue.push(imported.path)
        else {
          expect(
            imported.path.startsWith('node:') || !imported.external,
            `${key} imports the external package "${imported.path}" — it would load into every ik-mcp process`,
          ).toBe(true)
        }
      }
    }

    expect(closure.size, 'the closure must at least contain the entry').toBeGreaterThan(0)

    for (const key of closure) {
      const inputs = Object.keys(outputs[key]!.inputs)

      expect(
        inputs.filter((input) => {
          return input.includes('node_modules/')
        }),
        `${key} was built from a node_modules input — the proxy must stay Node-builtins-only`,
      ).toEqual([])
      expect(
        inputs.filter((input) => {
          return input.endsWith('src/entry/cli.ts')
        }),
        `${key} bundled the cli entry, and with it captureSessionReportPath(), which READS AND DELETES INFRA_KIT_SESSION_REPORT`,
      ).toEqual([])
    }
  })

  it('leaves cli.js.map a valid source map', () => {
    const sourceMap: unknown = JSON.parse(read('cli.js.map'))

    expect(sourceMap, 'the hashbang must not shift the source map off-by-one or invalidate it').toMatchObject({
      version: 3,
    })

    const { mappings, sources } = sourceMap as { mappings: string; sources: string[] }

    expect(mappings.length, 'empty mappings means stack traces from the installed CLI point nowhere').toBeGreaterThan(0)
    expect(sources.length, 'empty sources means stack traces from the installed CLI point nowhere').toBeGreaterThan(0)
  })
})
