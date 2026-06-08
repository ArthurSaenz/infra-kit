import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

import { DEFAULT_RULES, packageConfigSchema, resolvePackageConfig } from 'src/lib/package-config'
import type { ResolvedPackageRules } from 'src/lib/package-config'

import { pathExists } from '../fs-utils'

/** Per-package config filename every validated package must provide. */
export const PACKAGE_CONFIG_FILE = 'infra-kit.config.ts'

interface PackageJsonShape {
  name?: string
  scripts?: Record<string, string>
}

/**
 * Read and JSON-parse a package.json, returning an empty object when it is
 * missing or unreadable so callers can degrade into a clear "missing" check.
 */
export const readPackageJson = async (packageDir: string): Promise<PackageJsonShape> => {
  try {
    const raw = await fs.readFile(path.join(packageDir, 'package.json'), 'utf-8')

    return JSON.parse(raw) as PackageJsonShape
  } catch {
    return {}
  }
}

/**
 * Load, resolve, and validate a package's `infra-kit.config.ts`.
 *
 * Dynamic-imports the file (ESM), resolves the Vite-style factory or object
 * default export, validates the result against {@link packageConfigSchema}, and
 * merges it over the defaults. Throws a descriptive error when the file is
 * absent or the resolved config violates the schema.
 *
 * @example
 * await loadPackageConfig('/repo/packages/serverless-config')
 * // => { requiredScripts: [], requiredFiles: ['serverless.common.yml'], turboTasks: [] }
 */
export const loadPackageConfig = async (
  packageDir: string,
  baseline: Readonly<ResolvedPackageRules> = DEFAULT_RULES,
): Promise<ResolvedPackageRules> => {
  const configPath = path.join(packageDir, PACKAGE_CONFIG_FILE)

  if (!(await pathExists(configPath))) {
    throw new Error(`${PACKAGE_CONFIG_FILE} not found at ${configPath}`)
  }

  // Cache-bust with the file mtime so repeated loads (long-running MCP server)
  // pick up edits without a process restart. `.ts` configs load via Node's
  // native type stripping (the repo requires Node >= 24).
  const stat = await fs.stat(configPath)
  const moduleUrl = `${pathToFileURL(configPath).href}?mtime=${Number(stat.mtimeMs)}`

  const imported = (await import(moduleUrl)) as { default?: unknown }
  const rawExport = imported.default

  if (rawExport === undefined) {
    throw new Error(`${PACKAGE_CONFIG_FILE} at ${configPath} has no default export`)
  }

  const resolvedExport = typeof rawExport === 'function' ? await (rawExport as () => unknown)() : rawExport

  const parsed = packageConfigSchema.safeParse(resolvedExport)

  if (!parsed.success) {
    throw new Error(`Invalid ${PACKAGE_CONFIG_FILE} at ${configPath}: ${z.prettifyError(parsed.error)}`)
  }

  return resolvePackageConfig(parsed.data, baseline)
}
