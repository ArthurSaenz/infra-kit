import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { fileExists, tildify } from 'src/lib/path-display'
import { VENDOR_CONFIG_FILE } from 'src/lib/vendor/config-schema'
import { expandTilde, getFactoryConfigPath, loadFactoryConfig } from 'src/lib/vendor/factory-config'

interface VendorConfigOptions {
  /** Scaffold `~/.infra-kit/vendor.json` instead of printing the current one. */
  init?: boolean
  /** Source repo root used for legacy `targets` auto-seeding. Defaults to the git toplevel. */
  cwd?: string
}

/** Placeholder workspace dir written by `--init`; the user edits it to their layout. */
const PLACEHOLDER_WORKSPACE_DIR = '~/projects'

/**
 * Surface or scaffold the machine-local factory config
 * (`~/.infra-kit/vendor.json`). CLI-only — NOT an MCP tool; returns nothing
 * and signals problems via `process.exitCode`.
 *
 * Without `--init`: prints the factory file path + existence, the resolved
 * `workspaceDir` + existence, and per-target reachability (`[✓]`/`[ ]`). Exits
 * non-zero if the file is missing, the workspace dir is missing, or any target
 * is unreachable, so it is usable as a doctor check.
 *
 * With `--init`: scaffolds the file (skipping if it already exists), seeding
 * `targets` from a legacy source `vendor.config.ts` when one is readable.
 */
export const vendorConfig = async (options: VendorConfigOptions = {}): Promise<void> => {
  if (options.init) {
    await initFactoryConfig(options.cwd)

    return
  }

  await printFactoryConfig()
}

/** Render the factory config chain with `[✓]`/`[ ]` reachability markers. */
const printFactoryConfig = async (): Promise<void> => {
  const factoryPath = getFactoryConfigPath()
  const exists = await fileExists(factoryPath)

  logger.info(`Factory config: ${tildify(factoryPath)}   ${exists ? '[✓]' : '[ ]'}`)

  if (!exists) {
    logger.info('\nNot found — run `infra-kit vendor-config --init` to scaffold it.')
    process.exitCode = 1

    return
  }

  const { workspaceDir, targets } = await loadFactoryConfig()
  const resolvedWorkspace = expandTilde(workspaceDir)
  const workspaceExists = await fileExists(resolvedWorkspace)

  logger.info(
    `workspaceDir:   ${workspaceDir}   (resolved: ${resolvedWorkspace})   ${workspaceExists ? '[✓ exists]' : '[ ] not found'}`,
  )
  logger.info('Targets:')

  let allReachable = workspaceExists

  for (const repo of targets) {
    const targetPath = path.join(resolvedWorkspace, repo)
    const reachable = await fileExists(targetPath)

    if (!reachable) {
      allReachable = false
    }

    const marker = reachable ? '[✓]' : '[ ]'
    const suffix = reachable ? '' : '   (not found — clone or remove)'

    logger.info(`  ${marker} ${repo}   ${tildify(targetPath)}${suffix}`)
  }

  if (!allReachable) {
    process.exitCode = 1
  }
}

/** Scaffold `~/.infra-kit/vendor.json`, skipping if it already exists. */
const initFactoryConfig = async (cwd?: string): Promise<void> => {
  const factoryPath = getFactoryConfigPath()

  if (await fileExists(factoryPath)) {
    logger.info(`Factory config already exists at ${tildify(factoryPath)} — leaving it untouched.`)

    return
  }

  const sourceRoot = cwd ?? (await getProjectRoot())
  const seededTargets = await readLegacyTargets(sourceRoot)

  await fs.mkdir(path.dirname(factoryPath), { recursive: true })
  await fs.writeFile(factoryPath, buildScaffold(seededTargets), 'utf-8')

  logger.info(`✓ Created ${tildify(factoryPath)}`)

  if (seededTargets.length > 0) {
    logger.info(`  Seeded ${seededTargets.length} target(s) from the source ${VENDOR_CONFIG_FILE}.`)
  }

  logger.info(`  Edit \`workspaceDir\` (placeholder: ${PLACEHOLDER_WORKSPACE_DIR}) to point at where your repos live.`)

  if (seededTargets.length === 0) {
    logger.info('  Add at least one repo name to `targets` before running vendor sync/manifest/diff.')
  }
}

/**
 * Best-effort read of a legacy `targets` array from the source repo's
 * `vendor.config.ts`. The current schema no longer accepts `targets`, so this
 * reads the raw default export directly (bypassing validation). Returns `[]` on
 * any failure — seeding is a convenience, never a hard requirement.
 */
const readLegacyTargets = async (sourceRoot: string): Promise<string[]> => {
  try {
    const configPath = path.join(sourceRoot, VENDOR_CONFIG_FILE)
    const stat = await fs.stat(configPath)
    const moduleUrl = `${pathToFileURL(configPath).href}?mtime=${Number(stat.mtimeMs)}`
    const imported = (await import(moduleUrl)) as { default?: unknown }
    const raw = imported.default
    const resolved = typeof raw === 'function' ? await (raw as () => unknown)() : raw

    if (resolved && typeof resolved === 'object' && 'targets' in resolved) {
      const targets = (resolved as { targets?: unknown }).targets

      if (
        Array.isArray(targets) &&
        targets.every((t) => {
          return typeof t === 'string'
        })
      ) {
        return targets as string[]
      }
    }
  } catch {
    // Absent or unreadable source config — fall through to an empty placeholder.
  }

  return []
}

/**
 * Render the scaffold file body as strict JSON (`vendor.json`). The factory config
 * is static JSON, loaded with `JSON.parse` — no comments, no executable code. When
 * `targets` is empty the stub writes `"targets": []`, which fails the schema's
 * `targets.min(1)` on load: this is intentional — `--init` produces an incomplete
 * stub the user must edit before running vendor sync/manifest/diff. The annotated
 * guidance lives in the sibling `vendor.example.jsonc` (seeded by `infra-kit init`).
 */
const buildScaffold = (targets: string[]): string => {
  return `${JSON.stringify({ workspaceDir: PLACEHOLDER_WORKSPACE_DIR, targets }, null, 2)}\n`
}
