import { access } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod/v4'

import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { ROOT_DEFAULT_RULES } from 'src/lib/package-config'
import type { ResolvedPackageRules } from 'src/lib/package-config'
import { discoverPackages, validatePackage } from 'src/lib/package-validator'
import type { PackageValidationResult } from 'src/lib/package-validator'
import { defineMcpTool, textContent } from 'src/types'

interface ValidateOptions {
  /** Validate every non-vendor workspace package instead of just the current one. */
  all?: boolean
  /** Validate the monorepo root (turbo pipeline + root commands) instead of a package. */
  root?: boolean
  /** Directory to resolve the current package from. Defaults to `process.cwd()`. */
  cwd?: string
}

/** A directory to validate plus the under-the-hood defaults that apply to it. */
interface ValidationTarget {
  dir: string
  baseline?: Readonly<ResolvedPackageRules>
}

/**
 * Walk upward from `start` to the nearest directory containing a package.json.
 * Used so `infra-kit validate` (no `--all`) targets the package whose
 * package.json script invoked it, regardless of the exact working directory.
 *
 * @example
 * await findPackageRoot('/repo/packages/serverless-config/src')
 * // => '/repo/packages/serverless-config'
 */
const findPackageRoot = async (start: string): Promise<string> => {
  const exists = async (target: string): Promise<boolean> => {
    try {
      await access(target)

      return true
    } catch {
      return false
    }
  }

  let current = path.resolve(start)

  while (current !== path.dirname(current)) {
    if (await exists(path.join(current, 'package.json'))) {
      return current
    }

    current = path.dirname(current)
  }

  if (await exists(path.join(current, 'package.json'))) {
    return current
  }

  throw new Error(`No package.json found in or above ${start}`)
}

/**
 * Resolve which directories to validate, and the baseline defaults each uses:
 * `root` → the monorepo root with {@link ROOT_DEFAULT_RULES}; `all` → every
 * discovered non-vendor package; otherwise the package walked up from cwd.
 */
const resolveTargets = async (options: ValidateOptions): Promise<ValidationTarget[]> => {
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
 * Print a package's validation result as doctor-style `[PASS]`/`[FAIL]` lines.
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
 * Validate the monorepo root (`root`), every non-vendor workspace package
 * (`all`), or the package resolved by walking up from the working directory
 * (default — the shape used by a package's `"validate": "infra-kit validate"`
 * script). The returned `structuredContent.allPassed` lets the CLI set a
 * non-zero exit code so the check fails CI; this function never calls
 * `process.exit` so the MCP tool can reuse it.
 *
 * @example
 * // CLI inside packages/serverless-config: `infra-kit validate`
 * await validate()              // validates the current package
 * await validate({ all: true }) // validates every non-vendor workspace package
 * await validate({ root: true }) // validates the monorepo root (turbo + root commands)
 */
export const validate = async (options: ValidateOptions = {}) => {
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

  logger.info(`\n${allPassed ? '✅ All valid' : '❌ Validation failed'} (${results.length} checked)`)

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

// MCP Tool Registration
export const validateMcpTool = defineMcpTool({
  name: 'validate',
  description:
    'Validate against infra-kit.config.ts rules (config present and valid, required scripts, required files, and turbo tasks for the root). Defaults to the current package; all=true validates every non-vendor workspace package; root=true validates the monorepo root.',
  inputSchema: {
    all: z.boolean().optional().describe('Validate every non-vendor workspace package'),
    root: z.boolean().optional().describe('Validate the monorepo root (turbo pipeline + root commands)'),
  },
  outputSchema: {
    allPassed: z.boolean().describe('Whether every validated package passed all checks'),
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
      .describe('Per-package validation results'),
  },
  handler: (params) => {
    return validate({ all: params.all, root: params.root })
  },
})
