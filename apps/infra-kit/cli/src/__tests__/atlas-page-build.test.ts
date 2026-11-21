import * as esbuild from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { atlasPageBuildOptions } from '../../scripts/build.js'

const CLI_ROOT = resolve(__dirname, '../..')
const MAX_APP_JS_BYTES = 600 * 1024

/** A remote URL in any spot that would make the browser load it; namespace strings inside React are inert. */
const REMOTE_LOADS = [
  /\b(?:src|href)\s*=\s*["']?https?:\/\//i,
  /@import\s+(?:url\(\s*)?["']?https?:\/\//i,
  /\burl\(\s*["']?https?:\/\//i,
  /\bfetch\(\s*["'`]https?:\/\//i,
]

/**
 * Rebuilds the page from the EXPORTED options into a fresh directory, never reading a checked-out
 * `dist/` (gitignored, and `qa` has no build step), so every assertion below sees this commit's bundle.
 */
describe('atlas page bundle', () => {
  let outDir = ''

  beforeAll(async () => {
    const cache = resolve(CLI_ROOT, 'node_modules', '.cache')

    mkdirSync(cache, { recursive: true })
    outDir = mkdtempSync(join(cache, 'atlas-page-'))
    await esbuild.build({ ...atlasPageBuildOptions, outdir: outDir, logLevel: 'silent' })
  }, 60_000)

  afterAll(() => {
    if (outDir !== '') rmSync(outDir, { recursive: true, force: true })
  })

  const read = (name: string): string => {
    return readFileSync(join(outDir, name), 'utf8')
  }

  it('writes exactly index.html, app.js and app.css, with no source map', () => {
    expect(readdirSync(outDir).sort()).toEqual(['app.css', 'app.js', 'index.html'])
  })

  it('loads its own assets by absolute path and carries no inline script or style', () => {
    const html = read('index.html')

    expect(html).toContain('src="/__atlas/app.js"')
    expect(html).toContain('href="/__atlas/app.css"')
    for (const tag of html.match(/<script[^>]*>/gi) ?? []) expect(tag).toContain('src="/__atlas/')
    expect(html).not.toMatch(/<style\b|\bstyle=/i)
  })

  it.each(['index.html', 'app.js', 'app.css'])('%s makes no remote load', (name) => {
    const body = read(name)

    for (const pattern of REMOTE_LOADS) expect(body).not.toMatch(pattern)
  })

  it('leaves no process.env for the browser to trip over', () => {
    expect(read('app.js')).not.toContain('process.env')
  })

  // React DOM itself carries a `createElement('style')` path (hoisted `<style precedence>`), so the
  // inline-style guarantee is checked in the browser against the CSP, not by grepping the bundle.
  it('bundles the React Flow stylesheet into app.css', () => {
    expect(read('app.css')).toContain('.react-flow')
  })

  it("keeps the bundled libraries' MIT license notices", () => {
    expect(read('app.js')).toMatch(/@license[\s\S]{0,400}MIT license/i)
  })

  it(`keeps app.js within ${MAX_APP_JS_BYTES / 1024} KB`, () => {
    expect(statSync(join(outDir, 'app.js')).size).toBeLessThanOrEqual(MAX_APP_JS_BYTES)
  })
})
