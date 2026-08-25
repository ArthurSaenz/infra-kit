/**
 * Pins the publish lifecycle for every publishable `apps/infra-kit/*` package, because one of them
 * silently shipped a stale artifact.
 *
 * `pnpm publish` only rebuilds when the package wires `prepack` / `prepublishOnly`; without them it
 * uploads whatever happens to be sitting in `dist/`. `@slip-stream-kit/eslint-plugin` had neither,
 * and 0.3.15 went to npm carrying a dist built back when the source said `0.3.13` — the published
 * `meta.version` and the published `package.json` version disagreed. Nothing failed: the build
 * succeeds, the upload succeeds, and the package's own version test compares `src/index.ts` to
 * `package.json`, neither of which the tarball is built from at publish time.
 *
 * A per-package assertion would have to be remembered for the next package added. Sweeping every
 * non-private manifest is what actually holds.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const INFRA_KIT_APPS = path.resolve(__dirname, '../..')

interface Manifest {
  name: string
  version: string
  private?: boolean
  files?: string[]
  scripts?: Record<string, string>
}

/** Every `apps/infra-kit/*` package that `pnpm publish` would actually upload. */
const publishablePackages = (): { dir: string; manifest: Manifest }[] => {
  return readdirSync(INFRA_KIT_APPS, { withFileTypes: true })
    .filter((entry) => {
      return entry.isDirectory()
    })
    .flatMap((entry) => {
      const manifestPath = path.join(INFRA_KIT_APPS, entry.name, 'package.json')

      let manifest: Manifest

      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
      } catch {
        return []
      }

      return manifest.private === true ? [] : [{ dir: entry.name, manifest }]
    })
}

const PACKAGES = publishablePackages()

describe('publish lifecycle — a publish must never upload a stale dist', () => {
  // Guards the sweep itself: a bad glob that finds nothing would make every test below vacuous.
  it('finds all four publishable infra-kit packages', () => {
    expect(
      PACKAGES.map((p) => {
        return p.manifest.name
      }).sort(),
    ).toEqual(['@slip-stream-kit/config', '@slip-stream-kit/eslint-plugin', '@slip-stream-kit/vite', 'infra-kit'])
  })

  it.each(PACKAGES)('$manifest.name rebuilds on both publish entry points', ({ manifest }) => {
    const scripts = manifest.scripts ?? {}

    // `prepack` covers `pnpm pack` and `pnpm publish`; `prepublishOnly` covers the npm path and
    // fires even where prepack does not. Shipping the artifact needs both, not either.
    expect(scripts.prepack, `${manifest.name} has no prepack — publish would upload the dist on disk`).toBe(
      'pnpm run build',
    )
    expect(
      scripts.prepublishOnly,
      `${manifest.name} has no prepublishOnly — publish would upload the dist on disk`,
    ).toBe('pnpm run build')
  })

  it.each(PACKAGES)('$manifest.name builds from clean, so a stale file cannot survive', ({ manifest }) => {
    // Rebuilding over a dirty dist leaves orphaned files from earlier layouts in the tarball, which
    // is the same failure wearing a different hat.
    expect(manifest.scripts?.build, `${manifest.name} must clean before building`).toContain('clean-artifacts')
  })

  it.each(PACKAGES)('$manifest.name publishes only built output', ({ manifest }) => {
    expect(manifest.files, `${manifest.name} must restrict the tarball to dist`).toEqual(['dist'])
  })

  // The four move in lockstep; a straggler is how `@slip-stream-kit/vite` sat two releases behind.
  it('keeps every package on the same version', () => {
    const versions = [
      ...new Set(
        PACKAGES.map((p) => {
          return p.manifest.version
        }),
      ),
    ]

    expect(
      versions,
      `versions drifted: ${PACKAGES.map((p) => {
        return `${p.manifest.name}@${p.manifest.version}`
      }).join(', ')}`,
    ).toHaveLength(1)
  })
})
