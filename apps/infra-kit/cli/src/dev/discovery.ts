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

/** Bare metadata for a discovered UI app (a frontend with its own framework `dev` script). */
export interface DiscoveredUiApp {
  /** App folder name (e.g. backoffice, client). */
  name: string
  /** package.json `name` — used as the exact `turbo run dev --filter` target. */
  packageName: string
  /** Absolute path to `apps/<app>/ui`. */
  path: string
}

/** True when `<dir>/package.json` declares a non-empty `scripts.dev`. */
function hasDevScript(dir: string): boolean {
  const pkgPath = path.join(dir, 'package.json')

  if (!fs.existsSync(pkgPath)) return false

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> }

    return typeof pkg.scripts?.dev === 'string' && pkg.scripts.dev.length > 0
  } catch {
    return false
  }
}

/**
 * Discover every `apps/<app>/ui` whose package.json declares a `dev` script — the frontends
 * `infra-kit dev --ui` runs (via one delegated `turbo run dev`). Lenient: no `apps/` dir → `[]`
 * (UIs are optional), unlike {@link discoverApiApps} which requires it.
 */
export function discoverUiApps(root: string): DiscoveredUiApp[] {
  const appsDir = path.join(root, 'apps')
  const apps: DiscoveredUiApp[] = []

  if (!fs.existsSync(appsDir)) return apps

  const appDirs = fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter((dirent) => {
      return dirent.isDirectory()
    })
    .map((dirent) => {
      return dirent.name
    })

  for (const appName of appDirs) {
    const uiPath = path.join(appsDir, appName, 'ui')

    if (fs.existsSync(uiPath) && hasDevScript(uiPath)) {
      apps.push({
        name: appName,
        packageName: getPackageName(uiPath, appName),
        path: uiPath,
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

/**
 * Existing `packages/<pkg>/dist` directories under the monorepo root — the compiled
 * outputs `turbo watch` rewrites. Watched (alongside app dist) because editing a shared
 * lib rewrites only the lib's `dist`, never the dependent app's, so a package-dist change
 * is the only signal that a lib was rebuilt.
 */
export function getPackageDistDirs(root: string): string[] {
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
    const distDir = path.join(packagesDir, name, 'dist')

    if (fs.existsSync(distDir) && fs.statSync(distDir).isDirectory()) {
      dirs.push(distDir)
    }
  }

  return dirs
}

/** Existing `<app.path>/dist` directories for the given apps (order preserved). */
export function getAppDistDirs(apps: Array<{ path: string }>): string[] {
  return apps
    .map((app) => {
      return path.join(app.path, 'dist')
    })
    .filter((dir) => {
      return fs.existsSync(dir)
    })
}

/** How a watched dist change should be routed. */
export interface ChangeClassification {
  kind: 'app' | 'package'
  /** For app changes: the matched app dist dir (undefined when nothing matched). */
  app?: string
}

/**
 * Route a changed compiled-output path: a `packages/<pkg>/dist` change is a shared-package
 * rebuild (restart every app), an `<app>/dist` change restarts only that app (the matched
 * app dist dir is returned; `undefined` when the path matches neither). Package matches take
 * precedence.
 */
export function classifyDistChange(
  changedPath: string,
  appDistDirs: string[],
  packageDistDirs: string[],
): ChangeClassification {
  const normalized = path.normalize(changedPath)

  const inPackage = packageDistDirs.some((dir) => {
    return normalized.startsWith(path.normalize(dir))
  })

  if (inPackage) {
    return { kind: 'package' }
  }

  const matchedDir = appDistDirs.find((dir) => {
    return normalized.startsWith(path.normalize(dir))
  })

  return { kind: 'app', app: matchedDir }
}
