import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PROBE_FILE = '.infra-kit-import-from-app.mjs'

/**
 * Imports `specifier` as a module inside `appDir` would. A deploy script is loaded from the root checkout,
 * which deploy-run never installs, so its own bare imports cannot resolve; only the pruned `out/` is
 * installed.
 *
 * `import.meta.resolve` resolves from the file it is written in, and Node has no stable resolve-from-parent
 * API, so a probe file written into `appDir` lends its location: the app's node_modules, the package's
 * `exports` map and the workspace symlinks all apply as they would to the app's own code.
 *
 * @example
 * const { publishSiteIndexManifest } = await importFromApp<typeof SiteIndexDeploy>(appDir, '@wl/site-index/deploy')
 */
export const importFromApp = async <T>(appDir: string, specifier: string): Promise<T> => {
  const probe = path.join(appDir, PROBE_FILE)

  await fs.writeFile(probe, 'export const resolveHere = (specifier) => import.meta.resolve(specifier)\n')

  try {
    const { resolveHere } = (await import(pathToFileURL(probe).href)) as {
      resolveHere: (value: string) => string
    }

    return (await import(resolveHere(specifier))) as T
  } finally {
    await fs.rm(probe, { force: true })
  }
}
