import { E2E_MODE_ENV } from '@slip-stream-kit/config/internal'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import { isHeadless } from 'src/lib/agent-mode'
import { confirmOrExit } from 'src/lib/command-echo'
import { OperationError } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { jsonOutput } from 'src/lib/json-output'
import { logger } from 'src/lib/logger'
import { isProtectedEnv, resolveProtectedEnvAccess } from 'src/lib/workflow-envs'
import type { ProtectedEnvAccess } from 'src/lib/workflow-envs'
import { defineMcpTool, textContent } from 'src/types'

import { describeCloudTarget, describeLocalTarget, locateE2eTarget } from './e2e-target'
import type { E2eLocation, E2eTarget, E2eTargetDeps } from './e2e-target'

export interface E2eArgs {
  app?: string
  dryRun?: boolean
  yes?: boolean
  /** Run against the deployed app at `INFRA_KIT_ENV` instead of this worktree. */
  cloud?: boolean
  /** Passed through to `playwright test` verbatim. */
  playwrightArgs?: string[]
}

export interface E2eDeps extends E2eTargetDeps {
  protectedEnvAccess?: () => Promise<ProtectedEnvAccess>
  /** Runs Playwright and resolves its exit code. */
  runPlaywright?: (target: E2eTarget, args: string[]) => Promise<number>
}

const PLAYWRIGHT_CONFIGS = [
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.js',
  'playwright.config.mjs',
]

/** Whether the package's Playwright config wires `infraKitE2e()` — the only thing that starts `dev` for a run. */
const startsItsOwnDevServer = (testsDir: string): boolean => {
  return PLAYWRIGHT_CONFIGS.some((file) => {
    try {
      return fs.readFileSync(path.join(testsDir, file), 'utf8').includes('infraKitE2e')
    } catch {
      return false
    }
  })
}

const devCommandFor = (location: E2eLocation): string => {
  return `infra-kit dev ${location.target.split('/')[0]} --no-watch --reuse`
}

const formatTarget = (target: E2eTarget, served: boolean): string => {
  const lines = [`${target.app} e2e → ${target.mode.toUpperCase()} ${target.baseUrl}  (${target.baseUrlEnv})`]

  if (target.mode === 'cloud') lines.push(`  deployed app at env "${target.env}"`)
  else if (served) lines.push(`  dev server for ${target.target} on release "${target.release}", already running`)
  else lines.push(`  nothing serves ${target.target} yet; the Playwright config starts it and stops it after the run`)

  for (const route of target.routes) {
    let state = ''

    if (route.live !== null) state = route.live ? ' — live' : ' — NOT responding'

    lines.push(`  ${route.path.padEnd(24)} ${route.source.padEnd(5)} ${route.target ?? '(unresolved)'}${state}`)
  }

  return lines.join('\n')
}

/**
 * A local route whose backend is down is not a local run: requests on it fail at portless, so every
 * test touching it fails for a reason unrelated to the change under test. Stop before Playwright starts.
 */
const assertLocalRoutesLive = (target: E2eTarget): void => {
  const dead = target.routes.filter((route) => {
    return route.source === 'local' && route.live !== true
  })

  if (dead.length === 0) return

  const names = dead.map((route) => {
    return `${route.path} (${route.packageName})`
  })

  throw new OperationError(undefined, {
    operation: `run ${target.app} e2e against the local dev server`,
    remediation: 'check the backend rows in `infra-kit dev-status`, fix or restart it, then re-run',
    stderrExcerpt: `routes held local but their backend is not responding: ${names.join(', ')}`,
  })
}

const assertCloudEnvReachable = async (target: E2eTarget, deps: E2eDeps): Promise<void> => {
  if (target.env === null || !isProtectedEnv(target.env)) return

  const access = await (deps.protectedEnvAccess ?? resolveProtectedEnvAccess)()

  if (access.allowed) return

  const operation = `run ${target.app} e2e against "${target.env}"`

  if (access.reason === 'agent-blocked') {
    throw new StructuredRefusalError({ status: 'refused', env: target.env }, 2, {
      operation,
      remediation: 'a human runs it from their own terminal — this project sets `protectedEnvs: "cli-only"`',
      stderrExcerpt: `"${target.env}" is withheld from agents in this project`,
    })
  }

  throw new OperationError(undefined, {
    operation,
    remediation: `load a non-protected env (\`infra-kit env-load -c dev\`), or set \`protectedEnvs\` in infra-kit.json`,
    stderrExcerpt: `"${target.env}" is a protected environment`,
  })
}

/** The local run: the served target's proxy split when it is up, else the alias the config will start. */
const resolveLocal = async (location: E2eLocation, deps: E2eDeps): Promise<E2eTarget> => {
  if (location.served) {
    const target = await describeLocalTarget(location, deps)

    assertLocalRoutesLive(target)

    return target
  }

  if (!startsItsOwnDevServer(location.testsDir)) {
    throw new OperationError(undefined, {
      operation: `run ${location.app} e2e locally`,
      remediation: `start it (\`${devCommandFor(location)}\`), or wire \`infraKitE2e()\` from @slip-stream-kit/config/playwright into its playwright.config.ts`,
      stderrExcerpt: `nothing serves ${location.target} and ${location.testsDir}'s Playwright config does not start it`,
    })
  }

  const { app, testsDir, target, packageName, baseUrlEnv, release, env, localUrl } = location

  return {
    app,
    testsDir,
    target,
    packageName,
    baseUrlEnv,
    release,
    env,
    localUrl,
    mode: 'local',
    baseUrl: localUrl,
    routes: [],
  }
}

const defaultRunPlaywright = (target: E2eTarget, args: string[]): Promise<number> => {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- the consumer's own pnpm, as its e2e scripts run it
    const child = spawn('pnpm', ['exec', 'playwright', 'test', ...args], {
      cwd: target.testsDir,
      env: { ...process.env, [E2E_MODE_ENV]: target.mode, [target.baseUrlEnv]: target.baseUrl },
      // Under --json/agent mode stdout carries the result document; Playwright's report goes to stderr.
      stdio: ['inherit', jsonOutput.enabled || isHeadless() ? 2 : 'inherit', 'inherit'],
    })

    child.once('error', reject)
    child.once('close', (code) => {
      resolve(code ?? 1)
    })
  })
}

/**
 * Run an app's Playwright suite. Local by default — this worktree's dev server, reused when it runs and
 * otherwise started by the package's `infraKitE2e()` config for the length of the run. `--cloud` runs
 * against the deployed app at `INFRA_KIT_ENV`, which other people use, so it previews and needs `--yes`.
 */
export const e2e = async (args: E2eArgs, deps: E2eDeps = {}) => {
  const location = await locateE2eTarget(args.app, deps)
  const target = args.cloud ? describeCloudTarget(location, deps) : await resolveLocal(location, deps)

  logger.info(formatTarget(target, location.served))

  const current = (deps.env ?? process.env)[target.baseUrlEnv]

  if (current && current !== target.baseUrl) {
    logger.info(`  ${target.baseUrlEnv} was ${current} in this shell; the run uses ${target.baseUrl}`)
  }

  if (target.mode === 'cloud') await assertCloudEnvReachable(target, deps)

  const plan = {
    ...target,
    served: location.served,
    devCommand: target.mode === 'local' && !location.served ? devCommandFor(location) : null,
    playwrightArgs: args.playwrightArgs ?? [],
  }

  if (args.dryRun) {
    return buildResult({ ...plan, ran: false, exitCode: null })
  }

  if (target.mode === 'cloud') {
    await confirmOrExit(args.yes, `Run ${target.app} e2e against ${target.baseUrl} ("${target.env}", shared)?`, {
      plan,
    })
  }

  const exitCode = await (deps.runPlaywright ?? defaultRunPlaywright)(target, args.playwrightArgs ?? [])

  if (exitCode !== 0) process.exitCode = exitCode

  return buildResult({ ...plan, ran: true, exitCode })
}

const buildResult = (
  structuredContent: E2eTarget & {
    served: boolean
    devCommand: string | null
    playwrightArgs: string[]
    ran: boolean
    exitCode: number | null
  },
) => {
  return { content: textContent(JSON.stringify(structuredContent, null, 2)), structuredContent }
}

const e2eOutputSchema = {
  app: z.string(),
  testsDir: z.string(),
  target: z.string().describe('The package under test, `<app>/ui` or `<app>/api`.'),
  packageName: z.string(),
  mode: z
    .enum(['local', 'cloud'])
    .describe('local (default): this worktree’s dev server. cloud (--cloud): the deployed app at env.'),
  baseUrl: z.string().describe('The URL the run was pointed at, via the baseUrlEnv variable.'),
  baseUrlEnv: z.string(),
  release: z.string().describe('This worktree’s release slug — the first label of every local alias.'),
  env: z.string().nullable().describe('INFRA_KIT_ENV of this process; the env a cloud run targets.'),
  localUrl: z.string().describe('This worktree’s address for the target, whether or not anything serves it.'),
  served: z.boolean().describe('Whether this worktree’s dev server already served the target when the run began.'),
  devCommand: z
    .string()
    .nullable()
    .describe('Local runs with nothing served: the dev command the Playwright config starts, and stops after.'),
  routes: z
    .array(
      z.object({
        path: z.string(),
        packageName: z.string(),
        source: z.enum(['local', 'cloud']),
        target: z.string().nullable(),
        live: z.boolean().nullable(),
      }),
    )
    .describe('Served local UI runs only: the dev proxy’s route-by-route local/cloud split, local backends probed.'),
  playwrightArgs: z.array(z.string()),
  ran: z.boolean().describe('False for --dry-run.'),
  exitCode: z.number().nullable().describe('Playwright’s exit code; null when it did not run.'),
}

export const e2eMcpTool = defineMcpTool({
  name: 'e2e',
  description:
    'Run an app’s Playwright e2e suite against this worktree: the running dev server, or one the package’s infraKitE2e() Playwright config starts and stops. cloud runs against the deployed app at INFRA_KIT_ENV instead, confirm-gated; a protected env (prod) follows protectedEnvs. dryRun reports the target without running.',
  requiresHumanConfirm: true,
  inputSchema: {
    app: z
      .string()
      .optional()
      .describe('App folder with an apps/<app>/tests e2e package; inferred from cwd when omitted.'),
    dryRun: z.boolean().optional(),
    yes: z.boolean().optional(),
    cloud: z.boolean().optional().describe('Run against the deployed app at INFRA_KIT_ENV instead of this worktree.'),
  },
  outputSchema: e2eOutputSchema,
  handler: (params: E2eArgs) => {
    return e2e(params)
  },
})
