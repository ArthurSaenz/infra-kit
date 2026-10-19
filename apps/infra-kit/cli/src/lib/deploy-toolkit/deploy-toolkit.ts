import type {
  DeployBackendApiOptions,
  DeployBuildOptions,
  DeployFrontendUiOptions,
  DeployHook,
  DeployHookContext,
  DeployRetryOptions,
  DeployRunOptions,
  DeployToolkit,
} from '@slip-stream-kit/config'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Serverless 4 needs a licence key; every consumer still packages with 3. */
export const SERVERLESS_VERSION = '3.39.0'

const MAX_BUFFER = 10 * 1024 * 1024

/** `aws ssm get-parameters` accepts at most ten names per call. */
const SSM_BATCH = 10

type Env = Record<string, string | undefined>

/** The side effects, injectable so a test can record every command instead of running it. */
export interface ToolkitDeps {
  run: (command: string, args: string[], options: { cwd: string; env: Env }) => Promise<void>
  capture: (command: string, args: string[], options: { cwd: string; env: Env }) => Promise<string>
  sleep: (ms: number) => Promise<void>
  random: () => number
  log: (line: string) => void
}

/** Thrown by `skip()`; `deploy-run` reports it as a skipped deploy and exits 0. */
export class DeploySkipped extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'DeploySkipped'
  }
}

const spawnInherit: ToolkitDeps['run'] = (command, args, options) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: 'inherit' })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${signal ?? code}`))
    })
  })
}

export const defaultToolkitDeps: ToolkitDeps = {
  run: spawnInherit,
  capture: async (command, args, options) => {
    const { stdout } = await execFileAsync(command, args, { ...options, maxBuffer: MAX_BUFFER })

    return stdout
  },
  sleep: (ms) => {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  },
  random: Math.random,
  log: (line) => {
    // stdout, beside the commands' own output: the deploy log reads top to bottom in CI.
    process.stdout.write(`${line}\n`)
  },
}

/**
 * The aws CLI's own retries in adaptive mode, so a throttled call backs off instead of spending its
 * two standard-mode attempts within a second. An explicit setting in the environment wins.
 */
const awsEnv = (env: Env): Env => {
  return { AWS_RETRY_MODE: 'adaptive', AWS_MAX_ATTEMPTS: '10', ...env, AWS_PAGER: '' }
}

/**
 * The exact `turbo` version the repo's root package.json pins, so the global turbo that prunes and
 * builds matches the one the repo develops with.
 *
 * @example
 * await turboVersion('/repo') // root package.json devDependencies.turbo: "2.11.7" => '2.11.7'
 */
export const turboVersion = async (root: string): Promise<string> => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const range = manifest.devDependencies?.turbo ?? manifest.dependencies?.turbo
  const version = range?.replace(/^[\^~=v]+/, '')

  if (version === undefined || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`the root package.json must pin turbo to an exact version (found ${range ?? 'none'})`)
  }

  return version
}

/** Every `node_modules` below `dir`, nested ones included. */
export const removeNodeModules = async (dir: string): Promise<void> => {
  const entries = await fs.readdir(dir, { withFileTypes: true })

  await Promise.all(
    entries
      .filter((entry) => {
        return entry.isDirectory()
      })
      .map((entry) => {
        const child = path.join(dir, entry.name)

        return entry.name === 'node_modules' ? fs.rm(child, { recursive: true, force: true }) : removeNodeModules(child)
      }),
  )
}

interface ToolkitInput {
  root: string
  service: string
  /** The deploy script's directory, relative to `root`: the app a deploy targets unless it names one. */
  scriptDir?: string
  env?: Env
  deps?: ToolkitDeps
}

/**
 * The turbo workspace and path a deploy targets: what it names, else the app its script sits in.
 *
 * @example
 * await resolveApp('/repo', 'apps/client/api', {}) // apps/client/api/package.json name: backend-api => { app: 'backend-api', appPath: 'apps/client/api' }
 */
export const resolveApp = async (
  root: string,
  scriptDir: string | undefined,
  named: { app?: string; appPath?: string },
): Promise<{ app: string; appPath: string }> => {
  const appPath = named.appPath ?? scriptDir

  if (appPath === undefined) {
    throw new Error('pass app and appPath, or put the deploy script in the app it deploys')
  }

  if (named.app !== undefined) return { app: named.app, appPath }

  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, appPath, 'package.json'), 'utf-8')) as {
      name?: string
    }

    if (manifest.name) return { app: manifest.name, appPath }
  } catch {
    // Falls through to the error below, which names the fix.
  }

  throw new Error(`${appPath} has no package.json name to deploy; pass app explicitly`)
}

/**
 * The functions a service's TypeScript deploy receives: the steps of the consumers' former
 * `deploy-utils.sh`, with the same commands in the same order.
 */
// What changed against deploy-utils.sh, and why:
// - retries carry real jitter. The .sh scripts ran under `sh` (dash on ubuntu), which has no `$RANDOM`,
//   so every parallel deploy retried `create-deployment` on the same 2/4/8/16s beat and API Gateway kept
//   throttling all of them (hulyo run 38370386277, metasearch-be);
// - a missing SSM parameter throws: `--query Parameter.Value --output text` printed `None` for it;
// - hooks get the stage and directories as arguments instead of depending on the shell's cwd.
export const createDeployToolkit = ({
  root,
  service,
  scriptDir,
  env = process.env,
  deps = defaultToolkitDeps,
}: ToolkitInput): DeployToolkit => {
  const command = async (description: string, file: string, args: string[], options: DeployRunOptions = {}) => {
    deps.log(`COMMAND: ${[file, ...args].join(' ')}`)

    try {
      await deps.run(file, args, { cwd: options.cwd ?? root, env: options.env ?? env })
    } catch (error) {
      throw new Error(`${description} failed: ${(error as Error).message}`)
    }
  }

  const retry: DeployToolkit['retry'] = async (description, fn, options: DeployRetryOptions = {}) => {
    const { attempts = 8, initialDelaySeconds = 3, maxDelaySeconds = 60 } = options

    // Each wait is a random point in the upper half of its window, so parallel callers spread out.
    const attempt = async (number: number): Promise<Awaited<ReturnType<typeof fn>>> => {
      try {
        return await fn()
      } catch (error) {
        if (number >= attempts) {
          throw new Error(`${description} failed after ${attempts} attempts: ${(error as Error).message}`)
        }

        const window = Math.min(maxDelaySeconds, initialDelaySeconds * 2 ** (number - 1))
        const delay = Math.round((window / 2 + (deps.random() * window) / 2) * 10) / 10

        deps.log(`Attempt ${number}/${attempts} failed. Retrying in ${delay}s...`)
        await deps.sleep(delay * 1000)

        return attempt(number + 1)
      }
    }

    return attempt(1)
  }

  const awsWithRetry = async (description: string, args: string[], withEnv: Env = env) => {
    deps.log(`COMMAND: aws ${args.join(' ')}`)
    await retry(description, () => {
      return deps.run('aws', args, { cwd: root, env: awsEnv(withEnv) })
    })
  }

  const aws: DeployToolkit['aws'] = async (args, options = {}) => {
    await command(`aws ${args.slice(0, 2).join(' ')}`, 'aws', args, {
      cwd: options.cwd,
      env: awsEnv(options.env ?? env),
    })
  }

  const ssm: DeployToolkit['ssm'] = async (names) => {
    const batches = Array.from({ length: Math.ceil(names.length / SSM_BATCH) }, (_, index) => {
      return names.slice(index * SSM_BATCH, (index + 1) * SSM_BATCH)
    })
    const responses = await Promise.all(
      batches.map(async (batch) => {
        const stdout = await deps.capture('aws', ['ssm', 'get-parameters', '--names', ...batch, '--output', 'json'], {
          cwd: root,
          env: awsEnv(env),
        })

        return JSON.parse(stdout) as { Parameters?: { Name: string; Value: string }[]; InvalidParameters?: string[] }
      }),
    )
    const missing = responses.flatMap((response) => {
      return response.InvalidParameters ?? []
    })

    if (missing.length > 0) throw new Error(`SSM parameters not found: ${missing.join(', ')}`)

    return Object.fromEntries(
      responses.flatMap((response) => {
        return (response.Parameters ?? []).map((parameter) => {
          return [parameter.Name, parameter.Value]
        })
      }),
    )
  }

  const setupTools = async (serverless: boolean) => {
    const tools = [`turbo@${await turboVersion(root)}`, ...(serverless ? [`serverless@${SERVERLESS_VERSION}`] : [])]

    await command('Install tools', 'pnpm', ['add', '-g', ...tools])
  }

  const pruneAndBuild: DeployToolkit['pruneAndBuild'] = async (app, options: DeployBuildOptions) => {
    const out = path.join(root, 'out')
    const buildEnv = { ...env, ...options.buildEnv }
    const task = options.buildTask ?? buildEnv.TURBO_BUILD_TASK ?? 'build'

    await fs.rm(out, { recursive: true, force: true })
    await command(`Prune to ${app}`, 'turbo', ['prune', app], { env: buildEnv })
    await command('Install dependencies', 'pnpm', ['install'], { cwd: out, env: buildEnv })
    await command(`Build ${app}`, 'pnpm', ['exec', 'turbo', task, `--filter=${app}`, '--env-mode=loose'], {
      cwd: out,
      env: buildEnv,
    })

    if (options.installProd) {
      // Nested node_modules hold dev deps and recursive @pkg symlinks that serverless follows while
      // packaging, which pushed the Lambda artifact past the 250 MB unzipped limit.
      deps.log('COMMAND: remove every node_modules under ./out')
      await removeNodeModules(out)
      await command(
        'Install production dependencies',
        'pnpm',
        ['install', '--frozen-lockfile', '--node-linker=hoisted', '--prod'],
        { cwd: out, env: buildEnv },
      )
      await command('Show node_modules size', 'du', ['-sm', './node_modules/'], { cwd: out })
    }

    return out
  }

  const runHook = async (label: string, hook: DeployHook | undefined, context: DeployHookContext) => {
    if (hook === undefined) return

    deps.log(`Running ${label} hooks...`)

    try {
      await hook(context)
    } catch (error) {
      throw new Error(`${label} hooks failed: ${(error as Error).message}`)
    }

    deps.log(`${label} hooks completed successfully`)
  }

  const deployBackendApi: DeployToolkit['deployBackendApi'] = async (options: DeployBackendApiOptions) => {
    const { app, appPath } = await resolveApp(root, scriptDir, options)

    await setupTools(true)

    // deploy-utils.sh exported these for the whole deploy, so serverless sees them too.
    const deployEnv = { ...env, ...options.buildEnv }
    const outDir = await pruneAndBuild(app, {
      installProd: true,
      buildTask: options.buildTask,
      buildEnv: options.buildEnv,
    })
    const context = { stage: options.stage, outDir, appDir: path.join(outDir, appPath) }

    await runHook('Pre-deployment', options.preDeploy, context)
    await command('Deploy with Serverless', 'serverless', ['deploy', '--stage', options.stage, '--force'], {
      cwd: context.appDir,
      env: deployEnv,
    })

    if (options.restApiId === undefined) {
      deps.log(`Skipping API Gateway deployment for ${app}: no restApiId.`)
    } else {
      await awsWithRetry(
        'Create API Gateway deployment',
        ['apigateway', 'create-deployment', '--rest-api-id', options.restApiId, '--stage-name', 'api'],
        deployEnv,
      )
    }

    await runHook('Post-deployment', options.postDeploy, context)
  }

  const deployFrontendUi: DeployToolkit['deployFrontendUi'] = async (options: DeployFrontendUiOptions) => {
    const { app, appPath } = await resolveApp(root, scriptDir, options)

    await setupTools(false)

    const deployEnv = { ...env, ...options.buildEnv }
    const outDir = await pruneAndBuild(app, {
      installProd: false,
      buildTask: options.buildTask,
      buildEnv: options.buildEnv,
    })
    const context = { stage: options.stage, outDir, appDir: path.join(outDir, appPath) }
    const destination = `s3://${options.bucket}${options.destPath ?? ''}`
    const source = options.sourcePath ?? './dist'

    await command(
      'Sync to S3',
      'aws',
      ['s3', 'sync', source, destination, ...(options.syncFlags ?? []), '--only-show-errors'],
      {
        cwd: context.appDir,
        env: awsEnv(deployEnv),
      },
    )
    await awsWithRetry(
      'Invalidate CloudFront',
      [
        'cloudfront',
        'create-invalidation',
        '--distribution-id',
        options.cloudfrontId,
        '--paths',
        options.invalidationPath ?? '/*',
      ],
      deployEnv,
    )
    await runHook('Post-deployment', options.postDeploy, context)
  }

  return {
    root,
    service,
    ssm,
    aws,
    run: (file, args, options = {}) => {
      return deps.run(file, args, { cwd: options.cwd ?? root, env: options.env ?? env })
    },
    capture: (file, args, options = {}) => {
      return deps.capture(file, args, { cwd: options.cwd ?? root, env: options.env ?? env })
    },
    retry,
    skip: (reason) => {
      throw new DeploySkipped(reason)
    },
    pruneAndBuild,
    deployBackendApi,
    deployFrontendUi,
  }
}
