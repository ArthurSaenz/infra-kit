import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { readRelease } from '../release-slug/read-release'
import { slugifyHostLabel } from '../release-slug/release-slug'
import { loadPackageConfig } from '../vite/vite'

/**
 * The line `infra-kit dev --reuse` prints once every app it serves answers its health probe. Playwright's
 * `webServer.wait.stdout` waits on it — a URL cannot stand in for it, because portless answers 404 for a
 * hostname nothing serves, and Playwright counts a 404 as "server is up".
 */
export const DEV_SERVING_MARKER = 'infra-kit dev: serving'

/** `local` | `cloud` — which side a run targets. Unset: `cloud` on CI (no dev servers there), else `local`. */
export const E2E_MODE_ENV = 'INFRA_KIT_E2E'

const PREFIX = '@slip-stream-kit/config/playwright:'

export type InfraKitE2eMode = 'local' | 'cloud'

/** The subset of Playwright's `TestConfig['webServer']` this helper fills in. */
export interface InfraKitWebServer {
  name: string
  command: string
  cwd: string
  wait: { stdout: RegExp }
  gracefulShutdown: { signal: 'SIGTERM'; timeout: number }
  timeout: number
  stdout: 'ignore'
  stderr: 'pipe'
}

export interface InfraKitE2eSetup {
  mode: InfraKitE2eMode
  /** For `use.baseURL`. Never written back to the environment: see {@link infraKitE2e}. */
  baseURL: string
  /** The target's `deployedUrlEnv` — where a cloud run's URL comes from. Undefined when it declares none. */
  deployedUrlEnv: string | undefined
  /** For `use.ignoreHTTPSErrors`: local aliases are signed by portless's own CA. */
  ignoreHTTPSErrors: boolean
  /** For `webServer`. `undefined` for a cloud run — nothing is started. */
  webServer: InfraKitWebServer | undefined
}

export interface InfraKitE2eOptions {
  /** The e2e package's directory (the one holding `infra-kit.config.ts`). Defaults to `process.cwd()`. */
  dir?: string
  env?: NodeJS.ProcessEnv
  /** How long a cold `infra-kit dev` may take to serve everything. Defaults to 5 minutes. */
  timeoutMs?: number
}

const findWorkspaceRoot = (start: string): string => {
  let dir = start

  while (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir)

    if (parent === dir) throw new Error(`${PREFIX} no pnpm-workspace.yaml above ${start}`)
    dir = parent
  }

  return dir
}

const resolveMode = (env: NodeJS.ProcessEnv): InfraKitE2eMode => {
  const raw = env[E2E_MODE_ENV]

  if (raw === 'local' || raw === 'cloud') return raw
  if (raw) throw new Error(`${PREFIX} ${E2E_MODE_ENV}="${raw}" (expected "local" or "cloud")`)

  return env.CI ? 'cloud' : 'local'
}

/**
 * Point a Playwright config at this worktree: the local alias of the package's `e2e.target`, served by
 * `infra-kit dev <app>` — reused when this worktree already runs it, started and stopped around the run
 * otherwise. A cloud run (`INFRA_KIT_E2E=cloud`, or CI) points at the deployed URL and starts nothing.
 *
 * Every entry point — `playwright test`, `--ui`, `--debug`, the editor extension, `infra-kit e2e` — goes
 * through the config, which is why this lives here rather than in a CLI command.
 *
 * @example
 * // apps/client/tests/playwright.config.ts
 * const e2e = await infraKitE2e({ dir: import.meta.dirname })
 *
 * export default defineConfig({
 *   webServer: e2e.webServer,
 *   use: { baseURL: e2e.baseURL, ignoreHTTPSErrors: e2e.ignoreHTTPSErrors },
 * })
 */
export const infraKitE2e = async (options: InfraKitE2eOptions = {}): Promise<InfraKitE2eSetup> => {
  const dir = options.dir ?? process.cwd()
  const env = options.env ?? process.env
  const e2e = (await loadPackageConfig(dir))?.e2e

  if (!e2e) {
    throw new Error(`${PREFIX} ${path.join(dir, 'infra-kit.config.ts')} declares no \`e2e\` block`)
  }

  const root = findWorkspaceRoot(dir)
  const [app] = e2e.target.split('/') as [string]
  const targetDir = path.join(root, 'apps', e2e.target)
  const deployedUrlEnv = (await loadPackageConfig(targetDir))?.deployedUrlEnv
  const mode = resolveMode(env)

  if (mode === 'cloud') {
    if (!deployedUrlEnv) {
      throw new Error(
        `${PREFIX} a cloud run needs ${path.join(targetDir, 'infra-kit.config.ts')} to declare \`deployedUrlEnv\` — the variable holding ${e2e.target}'s deployed URL`,
      )
    }

    const baseURL = env[deployedUrlEnv]

    if (!baseURL) {
      throw new Error(
        `${PREFIX} a cloud run of ${e2e.target} needs ${deployedUrlEnv}, and it is not set. Load an environment with \`infra-kit env-load -c <env>\`, or unset ${E2E_MODE_ENV} to run locally.`,
      )
    }

    return { mode, baseURL, deployedUrlEnv, ignoreHTTPSErrors: false, webServer: undefined }
  }

  const packageName = (JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8')) as { name?: string })
    .name

  if (!packageName) throw new Error(`${PREFIX} ${targetDir}/package.json has no name`)

  // The deployed URL stays in the environment untouched: the dev server `webServer` starts inherits it,
  // and proxies the UI's cloud-only routes there. Overwriting it with the local alias would loop them back.
  const baseURL = `https://${readRelease(targetDir)}.${slugifyHostLabel(packageName)}.localhost`

  return {
    mode,
    baseURL,
    deployedUrlEnv,
    ignoreHTTPSErrors: true,
    webServer: {
      name: 'infra-kit dev',
      command: `infra-kit dev ${app} --no-watch --reuse`,
      cwd: root,
      wait: { stdout: new RegExp(DEV_SERVING_MARKER) },
      // `dev` reaps its turbo/vite process groups on SIGTERM; Playwright's default SIGKILL would orphan them.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
      timeout: options.timeoutMs ?? 300_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  }
}
