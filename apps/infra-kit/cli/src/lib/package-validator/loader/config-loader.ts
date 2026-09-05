import { packageConfigSchema } from '@slip-stream-kit/config/internal'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

// Deep path, never the `agent-guidance` barrel: that barrel reaches `adoption.ts`, which
// imports this loader subtree back. `package-type.ts` itself imports nothing but `node:path`.
import { PACKAGE_TYPES } from 'src/lib/agent-guidance/package-type'
import type { PackageType } from 'src/lib/agent-guidance/package-type'
import { DEFAULT_RULES, resolvePackageConfig } from 'src/lib/package-config'
import type { ResolvedPackageRules } from 'src/lib/package-config'

import { pathExists } from '../fs-utils'

/** Per-package config filename every validated package must provide. */
export const PACKAGE_CONFIG_FILE = 'infra-kit.config.ts'

/**
 * The `package.json` fields the audit and the guidance-block writer read. The three
 * dependency maps are here for `detectPackageType`, which reads them merged.
 */
interface PackageJsonShape {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
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

/** Dynamic-import a config file and resolve its Vite-style factory-or-object default export. */
const importConfigExport = async (configPath: string): Promise<unknown> => {
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

  return typeof rawExport === 'function' ? await (rawExport as () => unknown)() : rawExport
}

/**
 * Read the optional `type` a package declares in its `infra-kit.config.ts`, or `undefined`
 * when the file is absent, unloadable, or declares no recognised type.
 *
 * Deliberately does **not** go through {@link packageConfigSchema}. That schema ships in the
 * separately-published `@slip-stream-kit/config`, it is a `strictObject`, and the release
 * carrying `type` may not be the one a consumer has installed — so parsing a config that
 * declares `type` against an older schema throws on the unknown key. Reading the field
 * directly keeps type detection working across that version skew, and keeps this function
 * out of {@link loadPackageConfig}'s return type, which eight `validatePackage` call sites
 * depend on.
 *
 * @example
 * await readDeclaredPackageType('/repo/apps/client/ui')
 * // => 'frontend'  (when the config exports `{ type: 'frontend' }`)
 * @example
 * await readDeclaredPackageType('/repo/packages/lib-a')
 * // => undefined   (no config, or no `type` key)
 */
export const readDeclaredPackageType = async (packageDir: string): Promise<PackageType | undefined> => {
  const configPath = path.join(packageDir, PACKAGE_CONFIG_FILE)

  if (!(await pathExists(configPath))) return undefined

  try {
    const resolvedExport = await importConfigExport(configPath)
    const declared = (resolvedExport as { type?: unknown } | null)?.type

    return PACKAGE_TYPES.find((candidate) => {
      return candidate === declared
    })
  } catch {
    return undefined
  }
}

export const loadPackageConfig = async (
  packageDir: string,
  baseline: Readonly<ResolvedPackageRules> = DEFAULT_RULES,
): Promise<ResolvedPackageRules> => {
  const configPath = path.join(packageDir, PACKAGE_CONFIG_FILE)

  if (!(await pathExists(configPath))) {
    throw new Error(`${PACKAGE_CONFIG_FILE} not found at ${configPath}`)
  }

  const resolvedExport = await importConfigExport(configPath)

  const parsed = packageConfigSchema.safeParse(resolvedExport)

  if (!parsed.success) {
    throw new Error(`Invalid ${PACKAGE_CONFIG_FILE} at ${configPath}: ${z.prettifyError(parsed.error)}`)
  }

  return resolvePackageConfig(parsed.data, baseline)
}
