import fs from 'node:fs/promises'
import path from 'node:path'
import { $ } from 'zx'

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
  {
    name: 'infra-kit-e2e',
    pattern: /\binfraKitE2e\b/u,
    expected: "baseURL, ignoreHTTPSErrors and webServer from infraKitE2e() ('@slip-stream-kit/config/playwright')",
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

/** A string literal naming a `.auth` path segment: `'.auth/user.json'`, `'../.auth'`, `join(dir, '.auth', …)`. */
const AUTH_DIR_PATTERN = /['"`](?:[^'"`\n]*\/)?\.auth['"/`]/u
const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/u

const listSourceFiles = async (dir: string, recursive: boolean): Promise<string[]> => {
  const entries = await fs.readdir(dir, { recursive, withFileTypes: true }).catch(() => {
    return []
  })

  return entries
    .filter((entry) => {
      return entry.isFile() && SOURCE_FILE_PATTERN.test(entry.name)
    })
    .map((entry) => {
      return path.join(entry.parentPath, entry.name)
    })
}

const referencesAuthDir = async (packageDir: string): Promise<boolean> => {
  const sourceFiles = await listSourceFiles(path.join(packageDir, 'src'), true)

  // `use.storageState` in the config is the other common place to name it.
  for (const file of [path.join(packageDir, PLAYWRIGHT_CONFIG_FILE), ...sourceFiles]) {
    const content = await fs.readFile(file, 'utf-8').catch(() => {
      return ''
    })

    if (AUTH_DIR_PATTERN.test(content)) return true
  }

  return false
}

/**
 * Saved storage state is a live session cookie, so committing it leaks a login. Asked of git rather
 * than parsed from `.gitignore` files, so negations and nested ignores resolve as the next `git add`
 * will; the global excludes file is switched off because it lives on one machine, not in the repo.
 */
export const checkE2eAuthIgnored = async (packageDir: string): Promise<PackageCheck> => {
  const name = 'e2e-auth:gitignored'

  if (!(await referencesAuthDir(packageDir))) {
    return { name, status: 'pass', message: 'no saved auth state referenced' }
  }

  // A path inside it: bare `.auth` misses a `.auth/` rule until the directory exists, and a fresh clone has none.
  const result = await $({
    cwd: packageDir,
    quiet: true,
    nothrow: true,
  })`git -c core.excludesFile=/dev/null check-ignore -q .auth/storage-state.json`

  if (result.exitCode === 0) return { name, status: 'pass', message: '.auth/ is gitignored' }

  if (result.exitCode === 1) {
    return {
      name,
      status: 'fail',
      message: 'the suite saves auth state under .auth/, which git would commit — add `.auth/` to .gitignore',
    }
  }

  const reason = result.stderr.trim() || `exit ${result.exitCode}`

  return { name, status: 'fail', message: `could not ask git whether .auth/ is ignored: ${reason}` }
}

const BASIC_AUTH_USERNAME_ENV = 'E2E__BASIC_AUTH_USERNAME'
const BASIC_AUTH_PASSWORD_ENV = 'E2E__BASIC_AUTH_PASSWORD'

const BASIC_AUTH_NAME_PATTERN = /\bE2E_\w*BASIC_AUTH_\w+/gu
// Credential names only: a flag such as `E2E_BASIC_AUTH_ENABLED` is not a second spelling of the pair.
const CREDENTIAL_SUFFIX_PATTERN = /_(?:USER(?:NAME)?|PASS(?:WORD)?)$/u
const BLOCK_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//gu
// The `:` guard keeps a URL's `https://` from reading as a comment.
const LINE_COMMENT_PATTERN = /(^|[^:])\/\/[^\n]*/gu

const canonicalBasicAuthName = (name: string): string => {
  return /USER(?:NAME)?$/u.test(name) ? BASIC_AUTH_USERNAME_ENV : BASIC_AUTH_PASSWORD_ENV
}

const stripComments = (source: string): string => {
  return source.replace(BLOCK_COMMENT_PATTERN, '').replace(LINE_COMMENT_PATTERN, '$1')
}

/**
 * One basic-auth pair across every suite and repo: it is what the dev proxy injects (`@slip-stream-kit/config/vite`)
 * and what the shared CI job exports, so a per-app name works in one place and silently sends no credentials in the other.
 */
export const checkE2eBasicAuthNaming = async (packageDir: string): Promise<PackageCheck> => {
  const name = 'e2e-env:basic-auth'
  const files = [
    ...(await listSourceFiles(packageDir, false)),
    ...(await listSourceFiles(path.join(packageDir, 'src'), true)),
  ]
  const renames: string[] = []

  for (const file of files) {
    const content = await fs.readFile(file, 'utf-8').catch(() => {
      return ''
    })
    const drifted = new Set(
      [...stripComments(content).matchAll(BASIC_AUTH_NAME_PATTERN)]
        .map((match) => {
          return match[0]
        })
        .filter((found) => {
          return (
            CREDENTIAL_SUFFIX_PATTERN.test(found) &&
            found !== BASIC_AUTH_USERNAME_ENV &&
            found !== BASIC_AUTH_PASSWORD_ENV
          )
        }),
    )

    for (const found of drifted) {
      renames.push(`${found} → ${canonicalBasicAuthName(found)} (${path.relative(packageDir, file)})`)
    }
  }

  if (renames.length === 0) {
    return {
      name,
      status: 'pass',
      message: `basic auth read only from ${BASIC_AUTH_USERNAME_ENV} / ${BASIC_AUTH_PASSWORD_ENV}`,
    }
  }

  return {
    name,
    status: 'fail',
    message: `basic auth has one name pair in every suite — rename, with no fallback to the old name: ${renames.join('; ')}`,
  }
}

/** Convention checks applied to every `e2e` package, on top of its `infra-kit.config.ts` rules. */
export const checkE2e = async (packageDir: string, scripts: Record<string, string>): Promise<PackageCheck[]> => {
  return [
    ...checkE2eScripts(scripts),
    ...(await checkE2eConfig(packageDir)),
    await checkE2eAuthIgnored(packageDir),
    await checkE2eBasicAuthNaming(packageDir),
  ]
}
