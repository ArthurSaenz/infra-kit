/**
 * Filesystem discovery helpers for the dev-server.
 *
 * These functions read the filesystem (walking for the monorepo root, scanning
 * `apps/` and `packages/`) but never `chdir` and never resolve ports / prefixes —
 * that stays with the pure {@link file://./ports.ts} layer. The starting directory
 * is passed in so discovery is testable against a fixture root.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Bare metadata for a discovered API app (no resolved port / prefix). */
export interface DiscoveredApiApp {
  /** App folder name (e.g. backoffice, client). */
  name: string
  /** Package name from package.json (e.g. sls-trvl-client), or the folder name as fallback. */
  packageName: string
  path: string
}

/** Walk up from `startDir` (max 10 levels) to the dir containing `pnpm-workspace.yaml`. */
export function findMonorepoRoot(startDir: string): string {
  let currentDir = startDir

  for (let i = 0; i < 10; i++) {
    const workspaceFile = path.join(currentDir, 'pnpm-workspace.yaml')

    if (fs.existsSync(workspaceFile)) {
      return currentDir
    }
    currentDir = path.dirname(currentDir)
  }

  throw new Error('Could not find monorepo root (pnpm-workspace.yaml)')
}

/** Read the `name` field from `<apiPath>/package.json`, falling back to `appName`. */
export function getPackageName(apiPath: string, appName: string): string {
  const pkgPath = path.join(apiPath, 'package.json')

  if (!fs.existsSync(pkgPath)) return appName

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string }

    return typeof pkg.name === 'string' ? pkg.name : appName
  } catch {
    return appName
  }
}

/** Discover every `apps/<app>` that has an `api/serverless.yml` (bare metadata only). */
export function discoverApiApps(root: string): DiscoveredApiApp[] {
  const appsDir = path.join(root, 'apps')
  const apps: DiscoveredApiApp[] = []

  if (!fs.existsSync(appsDir)) {
    throw new Error(`Apps directory not found: ${appsDir}`)
  }

  const appDirs = fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter((dirent) => {
      return dirent.isDirectory()
    })
    .map((dirent) => {
      return dirent.name
    })

  for (const appName of appDirs) {
    const apiPath = path.join(appsDir, appName, 'api')
    const serverlessPath = path.join(apiPath, 'serverless.yml')

    if (fs.existsSync(serverlessPath)) {
      apps.push({
        name: appName,
        packageName: getPackageName(apiPath, appName),
        path: apiPath,
      })
    }
  }

  return apps
}

/** Normalize the `--app` include list: drop empties, and collapse an empty list to `null`. */
export function normalizeAppInclude(include?: string[] | null): string[] | null {
  const filtered = include?.filter(Boolean) ?? []

  return filtered.length > 0 ? filtered : null
}

/** Existing `packages/<pkg>/src` directories under the monorepo root. */
export function getPackageSrcDirs(root: string): string[] {
  const packagesDir = path.join(root, 'packages')

  if (!fs.existsSync(packagesDir)) return []

  const names = fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => {
      return d.isDirectory()
    })
    .map((d) => {
      return d.name
    })
  const dirs: string[] = []

  for (const name of names) {
    const srcDir = path.join(packagesDir, name, 'src')

    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
      dirs.push(srcDir)
    }
  }

  return dirs
}

/** Existing `<app.path>/src` directories for the given apps (order preserved). */
export function getAppSrcDirs(apps: Array<{ path: string }>): string[] {
  return apps
    .map((app) => {
      return path.join(app.path, 'src')
    })
    .filter((dir) => {
      return fs.existsSync(dir)
    })
}

/** How a watched file change should be routed. */
export interface ChangeClassification {
  kind: 'app' | 'package'
  /** For app changes: the matched app src dir (undefined when nothing matched). */
  app?: string
}

/**
 * Decide whether a changed path belongs to a shared package or a single app.
 * Package matches take precedence (a package change rebuilds every app). For app
 * matches, the matched app src dir is returned so the caller can restart the
 * owning app; `undefined` when the path matches neither.
 */
export function classifyChange(
  changedPath: string,
  appSrcDirs: string[],
  packageSrcDirs: string[],
): ChangeClassification {
  const normalized = path.normalize(changedPath)

  const inPackage = packageSrcDirs.some((dir) => {
    return normalized.startsWith(path.normalize(dir))
  })

  if (inPackage) {
    return { kind: 'package' }
  }

  const matchedDir = appSrcDirs.find((dir) => {
    return normalized.startsWith(path.normalize(dir))
  })

  return { kind: 'app', app: matchedDir }
}
