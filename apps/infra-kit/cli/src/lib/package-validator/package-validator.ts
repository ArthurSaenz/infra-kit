import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'yaml'
import { z } from 'zod/v4'

import { DEFAULT_RULES, packageConfigSchema, resolvePackageConfig } from 'src/lib/package-config'
import type { ResolvedPackageRules } from 'src/lib/package-config'

/** Per-package config filename every validated package must provide. */
const PACKAGE_CONFIG_FILE = 'infra-kit.config.ts'

const WORKSPACE_FILE = 'pnpm-workspace.yaml'

const TURBO_FILE = 'turbo.json'

export interface PackageCheck {
  /** Stable identifier for the check, e.g. `infra-kit.config.ts`, `script:build`. */
  name: string
  status: 'pass' | 'fail'
  message: string
}

export interface PackageValidationResult {
  packageDir: string
  packageName: string
  checks: PackageCheck[]
  passed: boolean
}

interface PackageJsonShape {
  name?: string
  scripts?: Record<string, string>
}

/**
 * Resolve whether a path is reachable, suppressing ENOENT into a boolean.
 *
 * @example
 * await pathExists('/etc/hosts') // => true
 * await pathExists('/nope')      // => false
 */
const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target)

    return true
  } catch {
    return false
  }
}

/**
 * Read and JSON-parse a package.json, returning an empty object when it is
 * missing or unreadable so callers can degrade into a clear "missing" check.
 */
const readPackageJson = async (packageDir: string): Promise<PackageJsonShape> => {
  try {
    const raw = await fs.readFile(path.join(packageDir, 'package.json'), 'utf-8')

    return JSON.parse(raw) as PackageJsonShape
  } catch {
    return {}
  }
}

/**
 * Load, resolve, and validate a package's `infra-kit.config.js`.
 *
 * Dynamic-imports the file (ESM), resolves the Vite-style factory or object
 * default export, validates the result against {@link packageConfigSchema}, and
 * merges it over the defaults. Throws a descriptive error when the file is
 * absent or the resolved config violates the schema.
 *
 * @example
 * await loadPackageConfig('/repo/packages/serverless-config')
 * // => { name: undefined, requiredScripts: [], requiredFiles: ['serverless.common.yml'] }
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

/**
 * Build the "config present and valid" check, returning the resolved rules when
 * the load succeeds so the caller can run the rule-based checks against them.
 */
const checkConfig = async (
  packageDir: string,
  baseline: Readonly<ResolvedPackageRules>,
): Promise<{ check: PackageCheck; rules: ResolvedPackageRules | null }> => {
  try {
    const rules = await loadPackageConfig(packageDir, baseline)

    return {
      check: { name: PACKAGE_CONFIG_FILE, status: 'pass', message: 'present and valid' },
      rules,
    }
  } catch (err) {
    return {
      check: { name: PACKAGE_CONFIG_FILE, status: 'fail', message: (err as Error).message },
      rules: null,
    }
  }
}

/**
 * Check that every required script is defined in the package.json `scripts` map.
 */
const checkScripts = (scripts: Record<string, string>, requiredScripts: string[]): PackageCheck[] => {
  return requiredScripts.map((script) => {
    const defined = typeof scripts[script] === 'string'

    return {
      name: `script:${script}`,
      status: defined ? 'pass' : 'fail',
      message: defined ? 'defined' : `missing "${script}" in package.json scripts`,
    }
  })
}

/**
 * Check that every required file exists relative to the package root.
 */
const checkFiles = async (packageDir: string, requiredFiles: string[]): Promise<PackageCheck[]> => {
  return Promise.all(
    requiredFiles.map(async (file) => {
      const exists = await pathExists(path.join(packageDir, file))

      return {
        name: `file:${file}`,
        status: exists ? 'pass' : 'fail',
        message: exists ? 'exists' : `missing file: ${file}`,
      }
    }),
  )
}

/**
 * Check that every required turbo task is defined in turbo.json `tasks`. A root
 * task may be keyed as either `name` or `//#name`, so both forms count as present.
 * Runs only when the resolved rules ask for turbo tasks (the monorepo root).
 */
const checkTurbo = async (packageDir: string, requiredTasks: string[]): Promise<PackageCheck[]> => {
  if (requiredTasks.length === 0) {
    return []
  }

  let tasks: Record<string, unknown> = {}

  try {
    const raw = await fs.readFile(path.join(packageDir, TURBO_FILE), 'utf-8')
    const parsed = JSON.parse(raw) as { tasks?: Record<string, unknown> }

    tasks = parsed.tasks ?? {}
  } catch (err) {
    return [{ name: TURBO_FILE, status: 'fail', message: `cannot read/parse ${TURBO_FILE}: ${(err as Error).message}` }]
  }

  return requiredTasks.map((task) => {
    const defined = task in tasks || `//#${task}` in tasks

    return {
      name: `turbo:${task}`,
      status: defined ? 'pass' : 'fail',
      message: defined ? 'defined' : `missing turbo task "${task}" in ${TURBO_FILE}`,
    }
  })
}

/**
 * Validate a single directory against its `infra-kit.config.ts` rules: the config
 * must be present and valid, every required script must be declared, every
 * required file must exist, and (root only) every required turbo task must be
 * defined. When the config fails to load, only that check is reported (the rules
 * are unknown, so the rule-based checks are skipped). `baseline` selects which
 * under-the-hood defaults apply — package defaults or {@link ROOT_DEFAULT_RULES}.
 *
 * @example
 * const result = await validatePackage('/repo/packages/serverless-config')
 * // result.passed reflects the package's conformance; result.checks lists each check
 */
export const validatePackage = async (
  packageDir: string,
  baseline: Readonly<ResolvedPackageRules> = DEFAULT_RULES,
): Promise<PackageValidationResult> => {
  const pkgJson = await readPackageJson(packageDir)
  const packageName = pkgJson.name ?? path.basename(packageDir)

  const { check: configCheck, rules } = await checkConfig(packageDir, baseline)
  const checks: PackageCheck[] = [configCheck]

  if (rules) {
    checks.push(...checkScripts(pkgJson.scripts ?? {}, rules.requiredScripts))
    checks.push(...(await checkFiles(packageDir, rules.requiredFiles)))
    checks.push(...(await checkTurbo(packageDir, rules.turboTasks)))
  }

  const passed = checks.every((check) => {
    return check.status === 'pass'
  })

  return { packageDir, packageName, checks, passed }
}

/**
 * List the immediate child directories of `dir`, returning `[]` when the path
 * can't be read (e.g. the parent glob segment matched a non-existent dir).
 */
const listChildDirs = async (dir: string): Promise<string[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => {
    return []
  })

  return entries
    .filter((entry) => {
      return entry.isDirectory()
    })
    .map((entry) => {
      return path.join(dir, entry.name)
    })
}

/**
 * Apply one glob segment to a set of directories: `*` fans out to every child
 * directory, a literal segment keeps the dirs where that child path exists.
 */
const expandSegment = async (dirs: string[], segment: string): Promise<string[]> => {
  const next: string[] = []

  for (const dir of dirs) {
    if (segment === '*') {
      next.push(...(await listChildDirs(dir)))

      continue
    }

    const candidate = path.join(dir, segment)

    if (await pathExists(candidate)) {
      next.push(candidate)
    }
  }

  return next
}

/**
 * Expand a single pnpm-workspace glob (only the `*` segment wildcard is
 * supported, which covers every pattern this monorepo uses) into directories.
 */
const expandGlob = async (projectRoot: string, pattern: string): Promise<string[]> => {
  let dirs = [projectRoot]

  for (const segment of pattern.split('/')) {
    dirs = await expandSegment(dirs, segment)
  }

  return dirs
}

/**
 * Discover validatable workspace packages from `pnpm-workspace.yaml`.
 *
 * Negation patterns (`!…`) and everything under `vendor/` are excluded —
 * vendor is mirrored from `starter-workspace` and is checksum-enforced by
 * `pnpm vendor:check`, so its configs are owned upstream, not here. Only
 * directories that actually contain a package.json are returned.
 *
 * @example
 * await discoverPackages('/repo')
 * // => ['/repo/apps/infra-kit/cli', '/repo/packages/serverless-config']
 */
export const discoverPackages = async (projectRoot: string): Promise<string[]> => {
  const raw = await fs.readFile(path.join(projectRoot, WORKSPACE_FILE), 'utf-8')
  const parsed = (yaml.parse(raw) ?? {}) as { packages?: string[] }

  const patterns = (parsed.packages ?? []).filter((pattern) => {
    return !pattern.startsWith('!') && !pattern.startsWith('vendor')
  })

  const found = new Set<string>()

  for (const pattern of patterns) {
    const dirs = await expandGlob(projectRoot, pattern)

    for (const dir of dirs) {
      if (await pathExists(path.join(dir, 'package.json'))) {
        found.add(dir)
      }
    }
  }

  return [...found].sort()
}
