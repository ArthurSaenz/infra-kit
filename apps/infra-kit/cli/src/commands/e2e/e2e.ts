import { E2E_MODE_ENV } from '@slip-stream-kit/config/internal'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import { isHeadless } from 'src/lib/agent-mode'
import { confirmOrExit } from 'src/lib/command-echo'
import { jsonOutput } from 'src/lib/json-output'
import { logger } from 'src/lib/logger'
import { isProtectedEnv, resolveProtectedEnvAccess } from 'src/lib/workflow-envs'
import type { ProtectedEnvAccess } from 'src/lib/workflow-envs'
import { defineMcpTool, textContent } from 'src/types'

import { e2eRefusal } from './e2e-refusal'
import { describeCloudTarget, describeLocalTarget, locateE2eTarget } from './e2e-target'
import type { E2eLocation, E2eTarget, E2eTargetDeps } from './e2e-target'
import { JSON_REPORTER_ARG, callerPicksReporter, jsonReporterEnv, readPlaywrightReport } from './playwright-report'
import type { E2eAnnotatedFile, E2eFailure, E2eSummary } from './playwright-report'
import { acquireRunLock } from './run-lock'
import { spawnForwardingSignals } from './spawn-forwarding-signals'

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
  /** Runs Playwright with `env` on top of this process's, and resolves its exit code. */
  runPlaywright?: (target: E2eTarget, args: string[], env: Record<string, string>) => Promise<number>
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
  const lines = [`${target.app} e2e → ${target.mode.toUpperCase()} ${target.baseUrl}`]

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

  throw e2eRefusal(
    'dead_local_routes',
    { routes: names },
    {
      operation: `run ${target.app} e2e against the local dev server`,
      remediation: 'check the backend rows in `infra-kit dev-status`, fix or restart it, then re-run',
      stderrExcerpt: `routes held local but their backend is not responding: ${names.join(', ')}`,
    },
  )
}

const assertCloudEnvReachable = async (target: E2eTarget, deps: E2eDeps): Promise<void> => {
  if (target.env === null || !isProtectedEnv(target.env)) return

  const access = await (deps.protectedEnvAccess ?? resolveProtectedEnvAccess)()

  if (access.allowed) return

  const operation = `run ${target.app} e2e against "${target.env}"`

  if (access.reason === 'agent-blocked') {
    throw e2eRefusal(
      'protected_env',
      { env: target.env, humanMayRun: true },
      {
        operation,
        remediation: 'a human runs it from their own terminal — this project sets `protectedEnvs: "cli-only"`',
        stderrExcerpt: `"${target.env}" is withheld from agents in this project`,
      },
    )
  }

  throw e2eRefusal(
    'protected_env',
    { env: target.env, humanMayRun: false },
    {
      operation,
      remediation: `load a non-protected env (\`infra-kit env-load -c dev\`), or set \`protectedEnvs\` in infra-kit.json`,
      stderrExcerpt: `"${target.env}" is a protected environment`,
    },
  )
}

/**
 * A served UI proxies cloud routes to the env its dev session started with, while the split reported here
 * and the run's own env come from this shell. Two envs would report one target and test another.
 */
const assertServedEnvMatches = (location: E2eLocation): void => {
  if (location.servedEnv === null || location.servedEnv === location.env) return

  throw e2eRefusal(
    'served_env_mismatch',
    { servedEnv: location.servedEnv, env: location.env },
    {
      operation: `run ${location.app} e2e against the local dev server`,
      remediation: `load the same env (\`infra-kit env-load -c ${location.servedEnv}\`), or restart \`infra-kit dev\` under "${location.env ?? 'none'}"`,
      stderrExcerpt: `the dev server serving ${location.target} runs with env "${location.servedEnv}", this shell with "${location.env ?? 'none'}"`,
    },
  )
}

/** The local run: the served target's proxy split when it is up, else the alias the config will start. */
const resolveLocal = async (location: E2eLocation, deps: E2eDeps): Promise<E2eTarget> => {
  if (location.served) {
    assertServedEnvMatches(location)

    const target = await describeLocalTarget(location, deps)

    assertLocalRoutesLive(target)

    return target
  }

  if (!startsItsOwnDevServer(location.testsDir)) {
    throw e2eRefusal(
      'no_dev_server',
      { devCommand: devCommandFor(location) },
      {
        operation: `run ${location.app} e2e locally`,
        remediation: `start it (\`${devCommandFor(location)}\`), or wire \`infraKitE2e()\` from @slip-stream-kit/config/playwright into its playwright.config.ts`,
        stderrExcerpt: `nothing serves ${location.target} and ${location.testsDir}'s Playwright config does not start it`,
      },
    )
  }

  const { app, testsDir, target, packageName, deployedUrlEnv, release, env, servedEnv, localUrl } = location

  return {
    app,
    testsDir,
    target,
    packageName,
    deployedUrlEnv,
    release,
    env,
    servedEnv,
    localUrl,
    mode: 'local',
    baseUrl: localUrl,
    routes: [],
  }
}

const defaultRunPlaywright = (target: E2eTarget, args: string[], env: Record<string, string>): Promise<number> => {
  return spawnForwardingSignals('pnpm', ['exec', 'playwright', 'test', ...args], {
    cwd: target.testsDir,
    // Only the mode: the deployed URL stays as loaded, because the dev server a local run starts proxies
    // the UI's cloud-only routes there.
    env: { ...process.env, ...env, [E2E_MODE_ENV]: target.mode },
    // Under --json/agent mode stdout carries the result document; Playwright's report goes to stderr.
    stdio: ['inherit', jsonOutput.enabled || isHeadless() ? 2 : 'inherit', 'inherit'],
  })
}

/**
 * Every run writes its traces to a directory of its own: Playwright empties its output directory when a run
 * starts, so a focus run after a full one would delete the traces the full run's failures point at.
 */
const withOwnOutputDir = (target: E2eTarget, args: string[]): { args: string[]; outputDir: string } => {
  const index = args.findIndex((arg) => {
    return arg === '--output' || arg.startsWith('--output=')
  })

  if (index !== -1) {
    const value = args[index] === '--output' ? (args[index + 1] ?? '') : args[index]!.slice('--output='.length)

    return { args, outputDir: path.resolve(target.testsDir, value) }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outputDir = path.join(target.testsDir, 'test-results', `ik-e2e-${stamp}-${process.pid}`)

  return { args: [...args, `--output=${outputDir}`], outputDir }
}

const holdRunLock = (target: E2eTarget): (() => void) => {
  if (target.mode === 'cloud') return () => {}

  const lock = acquireRunLock(target.testsDir)

  if ('holder' in lock) {
    throw e2eRefusal(
      'run_in_progress',
      { pid: lock.holder },
      {
        operation: `run ${target.app} e2e locally`,
        remediation: `wait for it to finish (or stop process ${lock.holder}), then re-run`,
        stderrExcerpt: `another local e2e run of ${target.app} (pid ${lock.holder}) is using its dev server`,
      },
    )
  }

  return lock.release
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

  if (target.mode === 'cloud') await assertCloudEnvReachable(target, deps)

  const plan = {
    ...target,
    served: location.served,
    devCommand: target.mode === 'local' && !location.served ? devCommandFor(location) : null,
    playwrightArgs: args.playwrightArgs ?? [],
  }

  if (args.dryRun) {
    return buildResult({ ...plan, ran: false, exitCode: null, ...NO_REPORT })
  }

  if (target.mode === 'cloud') {
    await confirmOrExit(args.yes, `Run ${target.app} e2e against ${target.baseUrl} ("${target.env}", shared)?`, {
      plan,
    })
  }

  const releaseRunLock = holdRunLock(target)

  try {
    return await runAndReport(plan, deps.runPlaywright ?? defaultRunPlaywright)
  } finally {
    releaseRunLock()
  }
}

const runAndReport = async (
  plan: E2eTarget & { served: boolean; devCommand: string | null; playwrightArgs: string[] },
  runPlaywright: NonNullable<E2eDeps['runPlaywright']>,
) => {
  // Per-test results are for a machine reader; a human already has Playwright's own report.
  if (!isHeadless() || callerPicksReporter(plan.playwrightArgs)) {
    const exitCode = await runPlaywright(plan, plan.playwrightArgs, {})

    if (exitCode !== 0) process.exitCode = exitCode

    return buildResult({ ...plan, ran: true, exitCode, ...NO_REPORT, report: isHeadless() ? 'caller-reporter' : 'off' })
  }

  const { args, outputDir } = withOwnOutputDir(plan, plan.playwrightArgs)
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-e2e-report-'))
  const reportFile = path.join(reportDir, 'report.json')

  try {
    const exitCode = await runPlaywright(plan, [JSON_REPORTER_ARG, ...args], jsonReporterEnv(reportFile))

    if (exitCode !== 0) process.exitCode = exitCode

    const report = readPlaywrightReport(reportFile)

    return buildResult({
      ...plan,
      ran: true,
      exitCode,
      ...(report ? { report: 'collected', ...report } : { ...NO_REPORT, report: 'unavailable' }),
      outputDir,
    })
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true })
  }
}

type E2eReportStatus = 'off' | 'caller-reporter' | 'unavailable' | 'collected'

const NO_REPORT = {
  report: 'off' as E2eReportStatus,
  outputDir: null,
  summary: null,
  failures: [],
  annotated: [],
  errors: [],
}

const buildResult = (
  structuredContent: E2eTarget & {
    served: boolean
    devCommand: string | null
    playwrightArgs: string[]
    ran: boolean
    exitCode: number | null
    report: E2eReportStatus
    outputDir: string | null
    summary: E2eSummary | null
    failures: E2eFailure[]
    annotated: E2eAnnotatedFile[]
    errors: string[]
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
  baseUrl: z.string().describe('The URL the run was pointed at: the local alias, or the deployed URL.'),
  deployedUrlEnv: z
    .string()
    .nullable()
    .describe('The target’s variable holding its deployed URL; a cloud run reads it. Null when it declares none.'),
  release: z.string().describe('This worktree’s release slug — the first label of every local alias.'),
  env: z.string().nullable().describe('INFRA_KIT_ENV of this process; the env a cloud run targets.'),
  servedEnv: z
    .string()
    .nullable()
    .describe(
      'Served local runs: the INFRA_KIT_ENV the running dev session recorded — where its cloud routes go. Null when nothing served the target or the session recorded none. A local run refuses when it differs from env.',
    ),
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
  report: z
    .enum(['off', 'caller-reporter', 'unavailable', 'collected'])
    .describe(
      'Per-test results: collected from Playwright’s JSON reporter under --json/agent mode; caller-reporter when playwrightArgs carried its own --reporter; unavailable when the run wrote no readable report; off otherwise.',
    ),
  outputDir: z
    .string()
    .nullable()
    .describe(
      'Where this run’s traces and attachments live — its own directory, so a later run cannot delete them. Null unless report is collected or unavailable.',
    ),
  summary: z
    .object({
      expected: z.number(),
      unexpected: z.number(),
      flaky: z.number(),
      skipped: z.number(),
      repeatFlaky: z.number(),
    })
    .nullable()
    .describe(
      'Playwright’s counts by outcome, one per run (each --repeat-each repeat counts), plus repeatFlaky: tests that passed in some repeats and failed in others. Null unless report is collected.',
    ),
  failures: z
    .array(
      z.object({
        title: z.string().describe('Describe path and test title, joined with ›.'),
        file: z.string(),
        line: z.number().nullable(),
        project: z.string(),
        status: z
          .enum(['unexpected', 'flaky'])
          .describe('flaky: failed, then passed on a retry or in another --repeat-each repeat.'),
        retry: z.number().describe('The retry index of the failed attempt reported here.'),
        runs: z.number().describe('How many times the test ran in this project — its --repeat-each repeats.'),
        failedRuns: z.number().describe('How many of those runs failed.'),
        error: z.string().nullable().describe('The failure message, ANSI stripped, truncated to 2000 characters.'),
        tracePath: z.string().nullable().describe('The failed attempt’s trace.zip; open with `playwright show-trace`.'),
      }),
    )
    .describe(
      'One entry per test and project that failed, needed a retry, or failed in some repeat; empty unless report is collected.',
    ),
  annotated: z
    .array(
      z.object({
        file: z.string(),
        fail: z.number().describe('test.fail — green only while the bug it registers exists.'),
        fixme: z.number().describe('test.fixme — skipped as unfinished.'),
        skip: z.number().describe('test.skip, declared or called at runtime, conditional ones included.'),
      }),
    )
    .describe(
      'Per spec file, the tests that passed or skipped while asserting little, as Playwright ran them; empty unless report is collected.',
    ),
  errors: z
    .array(z.string())
    .describe(
      'Run-level errors with no test to blame (config, global setup, a spec that fails to import), ANSI stripped and truncated; empty unless report is collected.',
    ),
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
    playwrightArgs: z
      .array(z.string())
      .optional()
      .describe('Passed to `playwright test` verbatim — a spec path, `--grep <title>`, `--project=chromium`.'),
  },
  outputSchema: e2eOutputSchema,
  handler: (params: E2eArgs) => {
    return e2e(params)
  },
})
