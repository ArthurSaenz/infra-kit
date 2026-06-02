import path from 'node:path'
import process from 'node:process'
import { z } from 'zod/v4'

import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { ROOT_DEFAULT_RULES } from 'src/lib/package-config'
import type { ResolvedPackageRules } from 'src/lib/package-config'
import { discoverPackages, pathExists, validatePackage } from 'src/lib/package-validator'
import type { PackageValidationResult } from 'src/lib/package-validator'
import { defineMcpTool, textContent } from 'src/types'

interface CheckOptions {
  /** Check every non-vendor workspace package instead of just the current one. */
  all?: boolean
  /** Check the monorepo root (turbo pipeline + root commands) instead of a package. */
  root?: boolean
  /** Directory to resolve the current package from. Defaults to `process.cwd()`. */
  cwd?: string
}

/** A directory to check plus the under-the-hood defaults that apply to it. */
interface CheckTarget {
  dir: string
  baseline?: Readonly<ResolvedPackageRules>
}

/**
 * Walk upward from `start` to the nearest directory containing a package.json.
 * Used so `infra-kit check` (no `--all`) targets the package whose package.json
 * script invoked it, regardless of the exact working directory.
 *
 * @example
 * await findPackageRoot('/repo/packages/serverless-config/src')
 * // => '/repo/packages/serverless-config'
 */
const findPackageRoot = async (start: string): Promise<string> => {
  let current = path.resolve(start)

  while (current !== path.dirname(current)) {
    if (await pathExists(path.join(current, 'package.json'))) {
      return current
    }

    current = path.dirname(current)
  }

  if (await pathExists(path.join(current, 'package.json'))) {
    return current
  }

  throw new Error(`No package.json found in or above ${start}`)
}

/**
 * Resolve which directories to check, and the baseline defaults each uses:
 * `root` → the monorepo root with {@link ROOT_DEFAULT_RULES}; `all` → every
 * discovered non-vendor package; otherwise the package walked up from cwd.
 */
const resolveTargets = async (options: CheckOptions): Promise<CheckTarget[]> => {
  if (options.root) {
    return [{ dir: await getProjectRoot(), baseline: ROOT_DEFAULT_RULES }]
  }

  if (options.all) {
    const dirs = await discoverPackages(await getProjectRoot())

    return dirs.map((dir) => {
      return { dir }
    })
  }

  return [{ dir: await findPackageRoot(options.cwd ?? process.cwd()) }]
}

/**
 * Print a package's check result as doctor-style `[PASS]`/`[FAIL]` lines.
 */
const logResult = (result: PackageValidationResult): void => {
  const header = result.passed ? 'PASS' : 'FAIL'

  logger.info(`\n${result.packageName} — ${header}`)

  for (const check of result.checks) {
    const icon = check.status === 'pass' ? '[PASS]' : '[FAIL]'

    logger.info(`  ${icon} ${check.name}: ${check.message}`)
  }
}

/**
 * Check the monorepo root (`root`), every non-vendor workspace package (`all`),
 * or the package resolved by walking up from the working directory (default —
 * the shape used by a package's `"check": "infra-kit check"` script). The
 * returned `structuredContent.allPassed` lets the CLI set a non-zero exit code so
 * the check fails CI; this function never calls `process.exit` so the MCP tool
 * can reuse it.
 *
 * @example
 * // CLI inside packages/serverless-config: `infra-kit check`
 * await check()              // checks the current package
 * await check({ all: true }) // checks every non-vendor workspace package
 * await check({ root: true }) // checks the monorepo root (turbo + root commands)
 */
export const check = async (options: CheckOptions = {}) => {
  const targets = await resolveTargets(options)

  const results: PackageValidationResult[] = []

  for (const target of targets) {
    results.push(await validatePackage(target.dir, target.baseline))
  }

  for (const result of results) {
    logResult(result)
  }

  const allPassed = results.every((result) => {
    return result.passed
  })

  logger.info(`\n${allPassed ? '✅ All valid' : '❌ Check failed'} (${results.length} checked)`)

  const structuredContent = {
    allPassed,
    packages: results.map((result) => {
      return {
        name: result.packageName,
        passed: result.passed,
        checks: result.checks,
      }
    }),
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

const checkInputSchema = {
  all: z.boolean().optional().describe('Check every non-vendor workspace package'),
  root: z.boolean().optional().describe('Check the monorepo root (turbo pipeline + root commands)'),
}

const checkOutputSchema = {
  allPassed: z.boolean().describe('Whether every checked package passed all checks'),
  packages: z
    .array(
      z.object({
        name: z.string(),
        passed: z.boolean(),
        checks: z.array(
          z.object({
            name: z.string(),
            status: z.enum(['pass', 'fail']),
            message: z.string(),
          }),
        ),
      }),
    )
    .describe('Per-package check results'),
}

// MCP Tool Registration
export const checkMcpTool = defineMcpTool({
  name: 'check',
  description:
    'Check packages against infra-kit.config.ts rules (config present and valid, required scripts, required files, and turbo tasks for the root). Defaults to the current package; all=true checks every non-vendor workspace package; root=true checks the monorepo root.',
  inputSchema: checkInputSchema,
  outputSchema: checkOutputSchema,
  handler: (params) => {
    return check({ all: params.all, root: params.root })
  },
})
