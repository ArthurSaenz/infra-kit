import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

import { VENDOR_CONFIG_FILE, vendorConfigSchema } from './config-schema'
import type { VendorConfig } from './config-schema'

// Convenience re-export so importers of the loader can also grab the authoring
// helper from one module. The node-free definitions live in `./config-schema`
// (the public `.d.ts` emit imports from there to stay node-type-free).
export { defineVendorConfig } from './config-schema'

/**
 * Load, resolve, and validate a source repo's `vendor.config.ts`.
 *
 * Reuses the established loader pattern from
 * `package-validator/loader/config-loader.ts`: dynamic-import the `.ts` file via
 * Node's native type stripping with an mtime cache-bust (so a long-running MCP
 * server picks up edits), resolve a Vite-style factory or object default export,
 * then validate against {@link vendorConfigSchema}. No new dependency (no
 * jiti/tsx). Throws a descriptive error when the file is absent or malformed.
 *
 * @example
 * await loadVendorConfig('/Users/me/projects/starter-workspace')
 */
export const loadVendorConfig = async (rootDir: string): Promise<VendorConfig> => {
  const configPath = path.join(rootDir, VENDOR_CONFIG_FILE)

  let stat

  try {
    stat = await fs.stat(configPath)
  } catch {
    throw new Error(`${VENDOR_CONFIG_FILE} not found at ${configPath}`)
  }

  // Cache-bust with the file mtime so repeated loads pick up edits without a
  // process restart. `.ts` configs load via Node's native type stripping.
  const moduleUrl = `${pathToFileURL(configPath).href}?mtime=${Number(stat.mtimeMs)}`

  const imported = (await import(moduleUrl)) as { default?: unknown }
  const rawExport = imported.default

  if (rawExport === undefined) {
    throw new Error(`${VENDOR_CONFIG_FILE} at ${configPath} has no default export`)
  }

  const resolvedExport = typeof rawExport === 'function' ? await (rawExport as () => unknown)() : rawExport

  const parsed = vendorConfigSchema.safeParse(resolvedExport)

  if (!parsed.success) {
    throw new Error(`Invalid ${VENDOR_CONFIG_FILE} at ${configPath}: ${z.prettifyError(parsed.error)}`)
  }

  return parsed.data
}
