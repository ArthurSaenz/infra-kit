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
  /**
   * True when this UI's vite config wires `infra-kit/vite`'s `infraKitDev()` helper — the ONLY thing
   * that makes it honor the runner-assigned `INFRA_KIT_UI_PORTS` port (which it binds with `strictPort`).
   *
   * The runner treats frameworks opaquely, so it cannot assume a pre-assigned port is the port the child
   * will bind. Without this signal it would print a confident, wrong URL for any UI that picks its own
   * port (vike, astro, a hand-rolled vite config). Unwired → the runner claims no port and the UI keeps
   * its honest "vite prints its URL below" reference line.
   */
  managedPort: boolean
}

/** Vite config filenames checked for the helper import, in vite's own resolution order. */
const VITE_CONFIG_FILES = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
]

/**
 * Every module specifier that binds a UI to infra-kit's dev wiring — whether through the raw
 * `infraKitDev` helper or through the `@slip-stream-kit/vite` plugin that wraps it.
 *
 * A LIST, not a single literal, because the wiring moved packages twice: it used to ship from the
 * `infra-kit` CLI itself, then from `@slip-stream-kit/config` (the split that let the CLI become a
 * global install — a local `node_modules/.bin/infra-kit` would otherwise shadow the global bin, see
 * that package's readme), and the plugin form now ships from `@slip-stream-kit/vite`. Consumers migrate
 * one repo at a time, so all three specifiers are live.
 *
 * This is what makes `managedPort` true, so a MISSING entry is not cosmetic: the runner would stop
 * claiming the port for every UI on that specifier, and with it the hero URL.
 *
 * Note this is a SUBSTRING match, which is why the config package could not be called `@infra-kit/vite`:
 * that name *contains* `infra-kit/vite`, so the legacy entry would have matched it by accident and
 * hidden the very coupling the split makes explicit. Neither `@slip-stream-kit/config/vite` nor
 * `@slip-stream-kit/vite` contains any other entry, so no entry here shadows another.
 *
 * Drop the legacy entry once every consumer repo is migrated.
 */
export const INFRA_KIT_VITE_SPECIFIERS = [
  '@slip-stream-kit/vite',
  '@slip-stream-kit/config/vite',
  'infra-kit/vite',
] as const

/**
 * True when `<dir>`'s vite config references the `infraKitDev` helper module. A text match, not a
 * module load: the config is TypeScript the runner must not execute, and importing it would run the
 * consumer's own side effects. False negatives (a config that re-exports the helper from a shared
 * preset) cost only the reference line, never a wrong URL — the safe direction to be wrong in.
 */
export function usesInfraKitVite(dir: string): boolean {
  for (const file of VITE_CONFIG_FILES) {
    const configPath = path.join(dir, file)

    if (!fs.existsSync(configPath)) continue

    try {
      const source = fs.readFileSync(configPath, 'utf-8')

      return INFRA_KIT_VITE_SPECIFIERS.some((specifier) => {
        return source.includes(specifier)
      })
    } catch {
      return false
    }
  }

  return false
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
        managedPort: usesInfraKitVite(uiPath),
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
 * Infer the current app's folder name from `startDir`, so a per-app script can
 * run `infra-kit dev --self` without hardcoding its own app name. Walks up to the
 * monorepo root (via {@link findMonorepoRoot}), then takes the first path segment
 * of `startDir` relative to `<root>/apps` — e.g. `apps/config-handler/api` and
 * `apps/config-handler` both resolve to `config-handler`. Throws when `startDir`
 * isn't inside `<root>/apps/<app>/...` (repo root, or an unrelated path).
 *
 * @example
 * resolveSelfAppName('/repo/apps/config-handler/api') // => 'config-handler'
 */
export function resolveSelfAppName(startDir: string): string {
  const root = findMonorepoRoot(startDir)
  const relative = path.relative(path.join(root, 'apps'), startDir)
  const firstSegment = relative.split(path.sep)[0]
  const isOutsideApps = relative === '' || relative.startsWith('..') || path.isAbsolute(relative)

  if (isOutsideApps || !firstSegment) {
    throw new Error(
      `--self: not inside an apps/<app> directory (cwd: ${startDir}). Run from an app folder or use --app=<name>.`,
    )
  }

  return firstSegment
}

/** App-part directory names that are apps in their own right, never shared packages. See {@link getPackageDistDirs}. */
const APP_PART_DIRS = new Set(['api', 'ui'])

/** `<dir>/dist` when it exists and is a directory, else `undefined`. */
const existingDistDir = (dir: string): string | undefined => {
  const distDir = path.join(dir, 'dist')

  return fs.existsSync(distDir) && fs.statSync(distDir).isDirectory() ? distDir : undefined
}

/** Immediate subdirectory names of `dir`, or `[]` when `dir` does not exist. */
const subdirNames = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return []

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => {
      return d.isDirectory()
    })
    .map((d) => {
      return d.name
    })
}

/**
 * Existing dist directories of every SHARED workspace package — the compiled outputs `turbo watch`
 * rewrites. Watched (alongside app dist) because editing a shared lib rewrites only the lib's `dist`,
 * never the dependent app's, so a package-dist change is the only signal that a lib was rebuilt.
 *
 * Two homes, because the pnpm workspace globs cover `packages/<pkg>` as well as `apps/<app>/<part>`:
 *  - `packages/<pkg>/dist` — the obvious one.
 *  - `apps/<app>/<part>/dist` where `<part>` is neither `api` nor `ui` and the dir is a real workspace
 *    member (it has a `package.json`). A shared library may legally live beside the app that owns it —
 *    hulyo's `@pkg/ai-mcp` is `apps/ai/mcp`, and two backends depend on it. Scanning only `packages`
 *    left such a package watched by nobody: turbo rebuilt its dist, the runner never saw the change, and
 *    every dependent backend kept serving stale code.
 *
 * `api`/`ui` parts are excluded deliberately: an api's dist is already covered by {@link getAppDistDirs},
 * and treating a frontend's dist as a shared package would bounce every backend on a UI rebuild.
 */
export function getPackageDistDirs(root: string): string[] {
  const dirs: string[] = []

  for (const name of subdirNames(path.join(root, 'packages'))) {
    const distDir = existingDistDir(path.join(root, 'packages', name))

    if (distDir !== undefined) dirs.push(distDir)
  }

  const appsDir = path.join(root, 'apps')

  for (const app of subdirNames(appsDir)) {
    for (const part of subdirNames(path.join(appsDir, app))) {
      if (APP_PART_DIRS.has(part)) continue

      const partDir = path.join(appsDir, app, part)

      // A workspace member, not a stray build artifact directory.
      if (!fs.existsSync(path.join(partDir, 'package.json'))) continue

      const distDir = existingDistDir(partDir)

      if (distDir !== undefined) dirs.push(distDir)
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
  /** For package changes: the matched `packages/<pkg>/dist` dir (the change identity used to scope restarts). */
  packageDir?: string
}

/**
 * Route a changed compiled-output path: a `packages/<pkg>/dist` change is a shared-package
 * rebuild — the matched package dist dir is returned so the caller can restart only the apps
 * whose dependency closure includes it. An `<app>/dist` change restarts only that app (the
 * matched app dist dir is returned; `undefined` when the path matches neither). Package matches
 * take precedence.
 */
export function classifyDistChange(
  changedPath: string,
  appDistDirs: string[],
  packageDistDirs: string[],
): ChangeClassification {
  const normalized = path.normalize(changedPath)

  const matchedPackageDir = packageDistDirs.find((dir) => {
    return normalized.startsWith(path.normalize(dir))
  })

  if (matchedPackageDir) {
    return { kind: 'package', packageDir: matchedPackageDir }
  }

  const matchedDir = appDistDirs.find((dir) => {
    return normalized.startsWith(path.normalize(dir))
  })

  return { kind: 'app', app: matchedDir }
}
