import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { MANIFEST_FILE, VENDOR_DIR, compareToManifest, isUnknownSchema, readManifest } from 'src/lib/vendor'
import { defineMcpTool, textContent } from 'src/types'

/** Max drifted paths to print per category before truncating. */
const MAX_REPORTED = 30

type VendorCheckStatus = 'clean' | 'drift' | 'skipped' | 'missing-manifest' | 'unknown-schema'

interface VendorCheckOptions {
  /** Repo root to check. Defaults to the git toplevel. */
  cwd?: string
}

const report = (label: string, list: string[]): void => {
  if (list.length === 0) {
    return
  }

  logger.info(`\n${label} (${list.length}):`)

  for (const rel of list.slice(0, MAX_REPORTED)) {
    logger.info(`  ${rel}`)
  }

  if (list.length > MAX_REPORTED) {
    logger.info(`  …and ${list.length - MAX_REPORTED} more`)
  }
}

/**
 * Verify that files under `vendor/` still match the checksums recorded in
 * `vendor/.sync-manifest.json`. Config-free and self-contained (no source repo,
 * no `vendor.config.ts`, no rsync) so it runs in any consumer's CI. Read-only —
 * never calls `process.exit`; the CLI action maps `structuredContent.ok` to the
 * exit code, and the MCP tool reuses the same handler.
 *
 * Exit-code contract (preserved from the legacy `vendor-check.mjs`):
 *   clean → ok; drift → not ok; missing `vendor/` → ok (skip);
 *   missing manifest → not ok; unknown (newer) schemaVersion → not ok (fail-closed).
 *
 * @example
 * await vendorCheck()                 // checks the current repo's vendor/
 * await vendorCheck({ cwd: '/repo' }) // checks a specific root (tests)
 */
export const vendorCheck = async (options: VendorCheckOptions = {}) => {
  const root = options.cwd ?? (await getProjectRoot())
  const vendorRoot = path.join(root, VENDOR_DIR)

  const base = { modified: [] as string[], added: [] as string[], removed: [] as string[], fileCount: 0 }

  if (!existsSync(vendorRoot)) {
    logger.info(`ℹ️  No ${VENDOR_DIR}/ folder found — nothing to check.`)
    const structuredContent = { status: 'skipped' as VendorCheckStatus, ok: true, ...base }

    return { content: textContent(JSON.stringify(structuredContent, null, 2)), structuredContent }
  }

  if (!existsSync(path.join(vendorRoot, MANIFEST_FILE))) {
    logger.error(`❌ Missing ${VENDOR_DIR}/${MANIFEST_FILE}. Re-run the vendor sync to generate it.`)
    const structuredContent = { status: 'missing-manifest' as VendorCheckStatus, ok: false, ...base }

    return { content: textContent(JSON.stringify(structuredContent, null, 2)), structuredContent }
  }

  const manifest = readManifest(vendorRoot)

  if (isUnknownSchema(manifest)) {
    logger.error(
      `❌ ${VENDOR_DIR}/${MANIFEST_FILE} has a newer schemaVersion (${String(manifest.schemaVersion)}) than this CLI supports. Upgrade infra-kit.`,
    )
    const structuredContent = { status: 'unknown-schema' as VendorCheckStatus, ok: false, ...base }

    return { content: textContent(JSON.stringify(structuredContent, null, 2)), structuredContent }
  }

  const { modified, added, removed } = compareToManifest(vendorRoot, manifest)
  const drifted = modified.length > 0 || added.length > 0 || removed.length > 0

  if (drifted) {
    logger.error(`❌ ${VENDOR_DIR}/ has drifted from ${VENDOR_DIR}/${MANIFEST_FILE}.`)
    logger.error('   These files are mirrored from the source repo — edit them upstream, not here.')
    report('Modified', modified)
    report('Added (not in manifest)', added)
    report('Removed (in manifest, now missing)', removed)
  } else {
    logger.info(`✅ ${VENDOR_DIR}/ matches manifest (${manifest.fileCount} files).`)
  }

  const structuredContent = {
    status: (drifted ? 'drift' : 'clean') as VendorCheckStatus,
    ok: !drifted,
    fileCount: manifest.fileCount,
    modified,
    added,
    removed,
  }

  return { content: textContent(JSON.stringify(structuredContent, null, 2)), structuredContent }
}

const vendorCheckOutputSchema = {
  status: z.enum(['clean', 'drift', 'skipped', 'missing-manifest', 'unknown-schema']),
  ok: z.boolean().describe('Whether the vendor tree matches its manifest (false → CI should fail)'),
  fileCount: z.number(),
  modified: z.array(z.string()),
  added: z.array(z.string()),
  removed: z.array(z.string()),
}

// MCP Tool Registration (read-only; safe to expose).
export const vendorCheckMcpTool = defineMcpTool({
  name: 'vendor-check',
  description:
    'Verify that files under vendor/ match the checksums in vendor/.sync-manifest.json. Self-contained (no source repo or config needed). Returns ok=false on drift, missing manifest, or an unknown future schemaVersion; ok=true when clean or when no vendor/ folder exists.',
  inputSchema: {},
  outputSchema: vendorCheckOutputSchema,
  handler: () => {
    return vendorCheck({ cwd: process.cwd() })
  },
})
