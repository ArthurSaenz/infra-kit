import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { $ } from 'zx'

import type { VendorConfig } from './config-schema'
import { expandTilde } from './factory-config'
import { writeManifest } from './manifest'
import { VENDOR_DIR } from './skip-sets'

/**
 * Write-path operations for `vendor sync`/`manifest`/`diff`. This module imports
 * `zx` at the top level and is NEVER re-exported from the read-path barrel
 * (`./index.ts`); `vendor check` never imports it, so its runtime path stays
 * free of `zx`/rsync.
 */

/** rsync excludes mirrored from the legacy sync script. */
const EXCLUDE_PATTERNS = [
  'node_modules',
  'dist',
  '*.tsbuildinfo',
  '.turbo',
  '.eslintcache',
  '.omc',
  '__screenshots__',
  '.vitest-attachments',
  '.output',
  '.source',
  '.nitro',
  '.tanstack',
  'log.txt',
]

const VENDOR_README = `# vendor/ — mirrored from the source repo

**DO NOT EDIT files in this folder here.**

Everything under \`vendor/\` is the single source of truth maintained in the source
repo and copied into this repo by \`infra-kit vendor sync\`. Local edits are
overwritten on the next sync and will fail \`infra-kit vendor check\` in CI.

To change a vendored package, edit it in the source repo and re-run the sync.

See \`.sync-manifest.json\` for the source commit and per-file checksums.
`

const excludeFlags = (): string[] => {
  return EXCLUDE_PATTERNS.map((pattern) => {
    return `--exclude=${pattern}`
  })
}

/** Resolve the source repo's current HEAD commit (or `unknown` if unavailable). */
export const getSourceCommit = async (sourceRoot: string): Promise<string> => {
  try {
    const result = await $({ cwd: sourceRoot })`git rev-parse HEAD`

    return result.stdout.trim()
  } catch {
    return 'unknown'
  }
}

/** rsync a directory source→target (target is replaced to avoid nested copies). */
export const copyDirectory = async (source: string, target: string): Promise<boolean> => {
  if (!existsSync(source)) {
    return false
  }

  if (existsSync(target)) {
    await $`rm -rf ${target}`
  }

  const sourceSlash = `${source}/`
  const targetSlash = `${target}/`

  await $`rsync -a ${excludeFlags()} ${sourceSlash} ${targetSlash}`

  return true
}

/** Copy a single file source→target, creating the target dir as needed. */
export const copyFile = async (source: string, target: string): Promise<boolean> => {
  if (!existsSync(source)) {
    return false
  }

  const targetDir = path.dirname(target)

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  await $`cp ${source} ${target}`

  return true
}

/**
 * Dry-run rsync reporting whether `target` has drifted from `source`. Returns the
 * itemized change list (empty = in sync). `--delete` surfaces consumer-only files.
 */
export const diffDirectory = async (source: string, target: string): Promise<string[]> => {
  if (!existsSync(source)) {
    return []
  }

  if (!existsSync(target)) {
    return [`missing target: ${target}`]
  }

  const sourceSlash = `${source}/`
  const targetSlash = `${target}/`
  const result = await $`rsync -ai --dry-run --delete ${excludeFlags()} ${sourceSlash} ${targetSlash}`

  return result.stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter(Boolean)
}

/**
 * Write `vendor/README.md` + `vendor/.sync-manifest.json` for a target repo,
 * mirroring the legacy `writeVendorMeta`. The manifest `files` map matches legacy
 * output; it differs only by the added `schemaVersion` and the `syncedAt` stamp.
 */
export const writeVendorMeta = (targetRoot: string, meta: { source: string; commit: string }): void => {
  const vendorRoot = path.join(targetRoot, VENDOR_DIR)

  if (!existsSync(vendorRoot)) {
    return
  }

  writeFileSync(path.join(vendorRoot, 'README.md'), VENDOR_README)
  writeManifest(vendorRoot, meta)
}

/**
 * Resolve a target repo name to its absolute root under the machine-local
 * `workspaceDir` (from `~/.infra-kit/vendor.json`). Replaces the old
 * "siblings of the source repo" assumption — the working dir is now explicit.
 */
export const resolveTargetRoot = (workspaceDir: string, repo: string): string => {
  return path.join(expandTilde(workspaceDir), repo)
}

/** Narrow the configured target list to an optional `--repos` allowlist. */
export const selectTargets = (allTargets: string[], repos?: string[]): string[] => {
  if (!repos) {
    return allTargets
  }

  return allTargets.filter((repo) => {
    return repos.includes(repo)
  })
}

export interface VendorSyncResult {
  source: string
  commit: string
  repos: { repo: string; copied: number; total: number; skipped: boolean }[]
}

/** Copy every configured item into each existing target, then write its manifest. */
export const runSync = async (
  config: VendorConfig,
  sourceRoot: string,
  workspaceDir: string,
  targets: string[],
  meta: { source: string; commit: string },
): Promise<VendorSyncResult> => {
  const repos: VendorSyncResult['repos'] = []

  for (const repo of targets) {
    const targetRoot = resolveTargetRoot(workspaceDir, repo)

    if (!existsSync(targetRoot)) {
      repos.push({ repo, copied: 0, total: config.copy.length, skipped: true })
      continue
    }

    let copied = 0

    for (const item of config.copy) {
      const source = path.join(sourceRoot, item.source)
      const target = path.join(targetRoot, item.target)
      const ok = item.type === 'directory' ? await copyDirectory(source, target) : await copyFile(source, target)

      if (ok) {
        copied++
      }
    }

    writeVendorMeta(targetRoot, meta)
    repos.push({ repo, copied, total: config.copy.length, skipped: false })
  }

  return { source: meta.source, commit: meta.commit, repos }
}

/**
 * Regenerate the manifest+README in each existing target without copying. Needs
 * neither the source `config` (no `copy[]` involved) nor `sourceRoot` (it writes
 * only into targets) — just where the targets live and which ones.
 */
export const runManifest = async (
  workspaceDir: string,
  targets: string[],
  meta: { source: string; commit: string },
): Promise<{ repo: string; skipped: boolean }[]> => {
  const repos: { repo: string; skipped: boolean }[] = []

  for (const repo of targets) {
    const targetRoot = resolveTargetRoot(workspaceDir, repo)
    const skipped = !existsSync(targetRoot)

    if (!skipped) {
      writeVendorMeta(targetRoot, meta)
    }

    repos.push({ repo, skipped })
  }

  return repos
}

export interface VendorDiffEntry {
  repo: string
  target: string
  changes: string[]
}

/** Source-aware drift across every `vendored:true` item in each target. */
export const runDiff = async (
  config: VendorConfig,
  sourceRoot: string,
  workspaceDir: string,
  targets: string[],
): Promise<VendorDiffEntry[]> => {
  const entries: VendorDiffEntry[] = []
  const vendoredItems = config.copy.filter((item) => {
    return item.vendored === true
  })

  for (const repo of targets) {
    const targetRoot = resolveTargetRoot(workspaceDir, repo)

    if (!existsSync(targetRoot)) {
      continue
    }

    for (const item of vendoredItems) {
      const source = path.join(sourceRoot, item.source)
      const target = path.join(targetRoot, item.target)
      const changes = await diffDirectory(source, target)

      if (changes.length > 0) {
        entries.push({ repo, target: item.target, changes })
      }
    }
  }

  return entries
}
