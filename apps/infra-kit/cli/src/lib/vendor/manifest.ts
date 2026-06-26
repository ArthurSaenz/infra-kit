import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import { sha256 } from './hash'
import { walkVendorTree } from './walk'

/** Filename of the integrity manifest inside a `vendor/` tree. */
export const MANIFEST_FILE = '.sync-manifest.json'

/**
 * Manifest schema version the CLI understands. A manifest with a HIGHER version
 * than this was written by a newer CLI and is treated as drift (fail-closed) —
 * see {@link isUnknownSchema}. Legacy manifests carry no `schemaVersion` field
 * and read as compatible.
 */
export const CURRENT_SCHEMA_VERSION = 1

/**
 * `schemaVersion` is OPTIONAL with no default: legacy manifests written by
 * `writeVendorMeta` have no such field, and a required field would make
 * `vendor check` fail-closed on every existing manifest. Absent is read as
 * "compatible" (current). `writeManifest` always emits the current version.
 */
const manifestSchema = z.object({
  schemaVersion: z.number().optional(),
  source: z.string(),
  commit: z.string(),
  syncedAt: z.string(),
  fileCount: z.number(),
  files: z.record(z.string(), z.string()),
})

export type VendorManifest = z.infer<typeof manifestSchema>

export interface ManifestDiff {
  modified: string[]
  added: string[]
  removed: string[]
}

/**
 * Whether a manifest's `schemaVersion` is newer than this CLI supports. Absent
 * (legacy) reads as compatible; only a strictly-greater version is unknown.
 */
export const isUnknownSchema = (manifest: VendorManifest): boolean => {
  return (manifest.schemaVersion ?? CURRENT_SCHEMA_VERSION) > CURRENT_SCHEMA_VERSION
}

/**
 * Walk the vendor tree and hash every file into a `{ relativePath: sha256 }`
 * map (sorted by walk order → stable). A file that cannot be read (e.g. a
 * dangling symlink) surfaces an explicit error rather than crashing with a raw
 * fs stack.
 */
export const buildFilesMap = (vendorRoot: string): Record<string, string> => {
  const files: Record<string, string> = {}

  for (const rel of walkVendorTree(vendorRoot)) {
    try {
      files[rel] = sha256(path.join(vendorRoot, rel))
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)

      throw new Error(`Cannot hash vendor file "${rel}" (broken symlink or unreadable file): ${reason}`)
    }
  }

  return files
}

/**
 * Read and validate the manifest at `<vendorRoot>/.sync-manifest.json`. Throws a
 * descriptive error if the file is missing or malformed.
 */
export const readManifest = (vendorRoot: string): VendorManifest => {
  const manifestPath = path.join(vendorRoot, MANIFEST_FILE)

  let raw: string

  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch {
    throw new Error(`Missing ${MANIFEST_FILE} at ${manifestPath}`)
  }

  const parsed = manifestSchema.safeParse(JSON.parse(raw))

  if (!parsed.success) {
    throw new Error(`Invalid ${MANIFEST_FILE} at ${manifestPath}: ${z.prettifyError(parsed.error)}`)
  }

  return parsed.data
}

/**
 * Build and write a fresh manifest for the current content of `vendorRoot`.
 * Emits the CURRENT schema version, the supplied `source`/`commit`, an ISO
 * `syncedAt`, and the per-file checksum map. Returns the written manifest.
 *
 * The `files` map and field set (minus `schemaVersion`) match legacy
 * `writeVendorMeta`, so a regenerated manifest differs from a legacy one only by
 * the added `schemaVersion` and the `syncedAt` timestamp.
 */
export const writeManifest = (vendorRoot: string, meta: { source: string; commit: string }): VendorManifest => {
  const files = buildFilesMap(vendorRoot)

  const manifest: VendorManifest = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    source: meta.source,
    commit: meta.commit,
    syncedAt: new Date().toISOString(),
    fileCount: Object.keys(files).length,
    files,
  }

  writeFileSync(path.join(vendorRoot, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)

  return manifest
}

/**
 * Compare the live `vendorRoot` tree against a manifest's recorded checksums.
 * Returns the modified / added (present, not in manifest) / removed (in
 * manifest, now missing) relative paths.
 */
export const compareToManifest = (vendorRoot: string, manifest: VendorManifest): ManifestDiff => {
  const expected = manifest.files
  const actualFiles = walkVendorTree(vendorRoot)

  const modified: string[] = []
  const added: string[] = []

  for (const rel of actualFiles) {
    if (!(rel in expected)) {
      added.push(rel)
      continue
    }

    if (sha256(path.join(vendorRoot, rel)) !== expected[rel]) {
      modified.push(rel)
    }
  }

  const actualSet = new Set(actualFiles)
  const removed = Object.keys(expected).filter((rel) => {
    return !actualSet.has(rel)
  })

  return { modified, added, removed }
}
