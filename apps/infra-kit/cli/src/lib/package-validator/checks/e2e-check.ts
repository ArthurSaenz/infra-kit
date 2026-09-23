import fs from 'node:fs/promises'
import path from 'node:path'

import { E2E_SCRIPTS } from 'src/lib/package-config'

import type { PackageCheck } from '../types'

export const PLAYWRIGHT_CONFIG_FILE = 'playwright.config.ts'

/**
 * The slow-motion contract every suite shares, so `e2e-test-ui-demo` behaves the same in every
 * repo: `E2E_SLOW_MO` is read from the env, fed to `launchOptions.slowMo`, and the per-test timeout
 * grows with it — slow motion spends the test budget on pure sleep, and without the headroom a
 * slowed run dies mid-demo reporting a timeout instead of the real problem. Traces are kept on
 * local failures because `retries` is 0 there, so `on-first-retry` alone would leave none.
 */
const CONFIG_RULES: ReadonlyArray<{ name: string; pattern: RegExp; expected: string }> = [
  {
    name: 'slow-mo',
    pattern: /process\.env\.E2E_SLOW_MO/u,
    expected: 'const SLOW_MO = Number(process.env.E2E_SLOW_MO ?? 0)',
  },
  {
    name: 'launch-options',
    pattern: /launchOptions:\s*\{[^}]*\bslowMo\b/u,
    expected: 'use.launchOptions: { slowMo: SLOW_MO }',
  },
  {
    name: 'timeout-headroom',
    pattern: /\btimeout:[^\n]*\bSLOW_MO\b/u,
    expected: 'timeout: <base> + SLOW_MO * 100',
  },
  {
    name: 'trace',
    pattern: /trace:\s*process\.env\.CI\s*\?\s*'on-first-retry'\s*:\s*'retain-on-failure'/u,
    expected: "use.trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure'",
  },
]

export const checkE2eScripts = (scripts: Record<string, string>): PackageCheck[] => {
  return Object.entries(E2E_SCRIPTS).map(([script, expected]) => {
    const name = `e2e-script:${script}`
    const value = scripts[script]

    if (typeof value !== 'string' || value.trim().length === 0) {
      return { name, status: 'fail', message: `missing "${script}" in package.json scripts — expected: ${expected}` }
    }

    if (value.trim() !== expected) {
      return { name, status: 'fail', message: `"${script}" drifts from the shared e2e scripts — expected: ${expected}` }
    }

    return { name, status: 'pass', message: 'matches the shared e2e scripts' }
  })
}

export const checkE2eConfig = async (packageDir: string): Promise<PackageCheck[]> => {
  const configPath = path.join(packageDir, PLAYWRIGHT_CONFIG_FILE)
  const content = await fs.readFile(configPath, 'utf-8').catch(() => {
    return null
  })

  if (content === null) {
    return [
      { name: `e2e-config:${PLAYWRIGHT_CONFIG_FILE}`, status: 'fail', message: `missing ${PLAYWRIGHT_CONFIG_FILE}` },
    ]
  }

  return CONFIG_RULES.map((rule) => {
    const name = `e2e-config:${rule.name}`

    return rule.pattern.test(content)
      ? { name, status: 'pass', message: 'present' }
      : {
          name,
          status: 'fail',
          message: `${PLAYWRIGHT_CONFIG_FILE} lacks the shared e2e convention — expected: ${rule.expected}`,
        }
  })
}

/** Convention checks applied to every `e2e` package, on top of its `infra-kit.config.ts` rules. */
export const checkE2e = async (packageDir: string, scripts: Record<string, string>): Promise<PackageCheck[]> => {
  return [...checkE2eScripts(scripts), ...(await checkE2eConfig(packageDir))]
}
