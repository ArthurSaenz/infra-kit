import path from 'node:path'

/**
 * The kind of workspace package a guidance block is written for. The repo root
 * has its own body and is deliberately not a `PackageType`.
 */
export type PackageType = 'frontend' | 'backend' | 'lib' | 'e2e' | 'mobile'

/** Every package type, in registry order. Useful for exhaustive table-driven tests. */
export const PACKAGE_TYPES: readonly PackageType[] = ['frontend', 'backend', 'lib', 'e2e', 'mobile']

/** The `package.json` fields package-type detection reads. */
export interface PackageTypeManifest {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export interface DetectPackageTypeArgs {
  /** Absolute path to the package directory. */
  packageDir: string
  /** Absolute path to the repo root the directory convention is measured against. */
  repoRoot: string
  /** The package's parsed `package.json` (an empty object when it is missing or unreadable). */
  pkgJson: PackageTypeManifest
  /** `type` declared in the package's `infra-kit.config.ts`. Wins over every detected signal. */
  declaredType?: PackageType
}

/** Directory names under `apps/<app>/` that carry declared semantics inside infra-kit. */
const APP_DIRECTORY_TYPES: Readonly<Record<string, PackageType>> = {
  ui: 'frontend',
  api: 'backend',
  tests: 'e2e',
}

/** A directory with this basename is a Capacitor shell wherever it sits in the tree. */
const MOBILE_BASENAME = 'mobile-app'

/**
 * Dependency signals, first match wins. `react` alone is deliberately absent:
 * component libraries carry it too, so `vite` + `react` + a `dev` script is what
 * separates an app from a library (handled separately below).
 */
const DEPENDENCY_SIGNALS: ReadonlyArray<{ type: PackageType; packages: readonly string[] }> = [
  { type: 'e2e', packages: ['@playwright/test'] },
  { type: 'mobile', packages: ['@capacitor/core', '@capacitor/cli'] },
  // `aws-lambda` / `@types/aws-lambda` are deliberately NOT signals: every consumer backend already
  // lives at `apps/<app>/api` (row 2), while the only packages those two deps would catch are
  // libraries (`packages/lib-core` in both consumers, the infra-kit CLI itself) — a lambda types
  // dependency alone never means backend, exactly as `react` alone never means frontend.
  { type: 'backend', packages: ['serverless'] },
]

/**
 * Type implied by where the package sits, or `null` when the path carries no
 * declared semantics. `apps/<app>/{ui,api,tests}` is already load-bearing inside
 * infra-kit (`devServersPresets` keys must be `<app>/api` or `<app>/ui`), so this
 * is the repo's own convention rather than a heuristic — which is why it beats
 * the dependency signals.
 *
 * @example
 * fromDirectory('/repo/apps/client/ui', '/repo') // => 'frontend'
 * fromDirectory('/repo/packages/mobile-app', '/repo') // => 'mobile'
 */
const fromDirectory = (packageDir: string, repoRoot: string): PackageType | null => {
  const segments = path
    .relative(repoRoot, packageDir)
    .split(path.sep)
    .filter((segment) => {
      return segment !== '' && segment !== '.'
    })

  const [first, , third] = segments

  if (segments.length === 3 && first === 'apps' && third !== undefined) {
    const appType = APP_DIRECTORY_TYPES[third]

    if (appType) return appType
  }

  return segments.at(-1) === MOBILE_BASENAME ? 'mobile' : null
}

/**
 * Type implied by the merged `dependencies` / `devDependencies` / `peerDependencies`
 * plus the `dev` script, or `null` when nothing matches.
 *
 * @example
 * fromDependencies({ dependencies: { '@playwright/test': '^1' } }) // => 'e2e'
 * fromDependencies({ dependencies: { react: '^19' } }) // => null (react alone is not a frontend)
 */
const fromDependencies = (pkgJson: PackageTypeManifest): PackageType | null => {
  const deps = new Set([
    ...Object.keys(pkgJson.dependencies ?? {}),
    ...Object.keys(pkgJson.devDependencies ?? {}),
    ...Object.keys(pkgJson.peerDependencies ?? {}),
  ])

  for (const signal of DEPENDENCY_SIGNALS) {
    if (
      signal.packages.some((name) => {
        return deps.has(name)
      })
    )
      return signal.type
  }

  const isViteReactApp = deps.has('vite') && deps.has('react') && Boolean(pkgJson.scripts?.dev)

  return isViteReactApp ? 'frontend' : null
}

/**
 * Resolve a package's type by the §3.2 precedence: an explicit `type` in
 * `infra-kit.config.ts` beats the directory convention, which beats the
 * dependency signals, which fall back to `lib`. There is no `unknown` — the
 * fallback is the least opinionated body, so an unrecognised package still gets
 * a usable block rather than a failing check.
 *
 * @example
 * detectPackageType({
 *   packageDir: '/repo/apps/client/ui',
 *   repoRoot: '/repo',
 *   pkgJson: { dependencies: { '@playwright/test': '^1' } },
 * })
 * // => 'frontend' (the directory convention beats the dependency signal)
 */
export const detectPackageType = ({
  packageDir,
  repoRoot,
  pkgJson,
  declaredType,
}: DetectPackageTypeArgs): PackageType => {
  return declaredType ?? fromDirectory(packageDir, repoRoot) ?? fromDependencies(pkgJson) ?? 'lib'
}
