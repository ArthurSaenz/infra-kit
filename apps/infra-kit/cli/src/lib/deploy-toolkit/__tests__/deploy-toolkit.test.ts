import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DeploySkipped, createDeployToolkit, removeNodeModules, resolveApp, turboVersion } from '../deploy-toolkit'
import type { ToolkitDeps } from '../deploy-toolkit'

interface Call {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
}

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-toolkit-'))
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { turbo: '2.11.7' } }))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** Records every command; `turbo prune` lays out `<root>/out` as the real one would. */
const fake = (overrides: Partial<ToolkitDeps> = {}) => {
  const calls: Call[] = []
  const sleeps: number[] = []
  const deps: ToolkitDeps = {
    run: async (command, args, options) => {
      calls.push({ command, args, ...options })

      if (command === 'turbo' && args[0] === 'prune') {
        await fs.mkdir(path.join(options.cwd, 'out', 'apps', 'api', 'node_modules'), { recursive: true })
      }
    },
    capture: async (command, args, options) => {
      calls.push({ command, args, ...options })

      return '{}'
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => {
      return 0.5
    },
    log: () => {},
    ...overrides,
  }
  const toolkit = createDeployToolkit({ root, service: 'client-be', env: { PATH: '/bin' }, deps })

  return { toolkit, deps, calls, sleeps }
}

const line = (call: Call | undefined) => {
  return call === undefined ? '' : [call.command, ...call.args].join(' ')
}

describe('retry', () => {
  it('retries until the call succeeds, waiting a jittered, doubling window', async () => {
    const { toolkit, sleeps } = fake({
      random: () => {
        return 1
      },
    })
    const outcomes = [new Error('TooManyRequestsException'), new Error('TooManyRequestsException')]

    const value = await toolkit.retry('flaky', async () => {
      const failure = outcomes.shift()

      if (failure) throw failure

      return 'ok'
    })

    expect(value).toBe('ok')
    expect(sleeps).toEqual([3000, 6000])
  })

  it('never waits less than half the window, and caps it', async () => {
    const { toolkit, sleeps } = fake({
      random: () => {
        return 0
      },
    })

    await expect(
      toolkit.retry(
        'always',
        () => {
          return Promise.reject(new Error('nope'))
        },
        { attempts: 4, initialDelaySeconds: 20, maxDelaySeconds: 30 },
      ),
    ).rejects.toThrow('always failed after 4 attempts: nope')
    expect(sleeps).toEqual([10000, 15000, 15000])
  })
})

describe('ssm', () => {
  it('reads every name in batches of ten with adaptive aws retries', async () => {
    const names = Array.from({ length: 12 }, (_, index) => {
      return `/hulyo/p${index}`
    })
    const { toolkit, calls } = fake({
      capture: async (command, args, options) => {
        calls.push({ command, args, ...options })

        const requested = args.slice(args.indexOf('--names') + 1, args.indexOf('--output'))

        return JSON.stringify({
          Parameters: requested.map((name) => {
            return { Name: name, Value: `v${name}` }
          }),
        })
      },
    })

    const values = await toolkit.ssm(names)

    expect(calls).toHaveLength(2)
    expect(Object.keys(values)).toHaveLength(12)
    expect(values['/hulyo/p11']).toBe('v/hulyo/p11')
    expect(calls[0]?.env).toMatchObject({ AWS_RETRY_MODE: 'adaptive', AWS_PAGER: '', PATH: '/bin' })
  })

  it('throws on a missing parameter instead of deploying with "None"', async () => {
    const { toolkit } = fake({
      capture: async () => {
        return JSON.stringify({ Parameters: [], InvalidParameters: ['/hulyo/environment'] })
      },
    })

    await expect(toolkit.ssm(['/hulyo/environment'])).rejects.toThrow('SSM parameters not found: /hulyo/environment')
  })
})

describe('deployBackendApi', () => {
  it('runs the deploy-utils.sh steps in order, hooks around serverless, then redeploys the REST API', async () => {
    const { toolkit, calls } = fake()
    const seen: string[] = []

    await toolkit.deployBackendApi({
      stage: 'arthur',
      app: 'backend-api',
      appPath: 'apps/api',
      restApiId: 'yiejco1cn6',
      preDeploy: (context) => {
        seen.push(`pre ${context.stage} ${context.outDir === path.join(root, 'out')}`)
      },
      postDeploy: (context) => {
        seen.push(`post ${context.appDir === path.join(root, 'out', 'apps', 'api')}`)
      },
    })

    expect(calls.map(line)).toEqual([
      'pnpm add -g turbo@2.11.7 serverless@3.39.0',
      'turbo prune backend-api',
      'pnpm install',
      'pnpm exec turbo build --filter=backend-api --env-mode=loose',
      'pnpm install --frozen-lockfile --node-linker=hoisted --prod',
      'du -sm ./node_modules/',
      'serverless deploy --stage arthur --force',
      'aws apigateway create-deployment --rest-api-id yiejco1cn6 --stage-name api',
    ])
    expect(calls[6]?.cwd).toBe(path.join(root, 'out', 'apps', 'api'))
    expect(seen).toEqual(['pre arthur true', 'post true'])
    await expect(fs.readdir(path.join(root, 'out', 'apps', 'api', 'node_modules'))).rejects.toThrow()
  })

  it('retries a throttled API Gateway deployment', async () => {
    const throttles = [new Error('TooManyRequestsException'), new Error('TooManyRequestsException')]
    const base = fake()
    const { toolkit, calls } = fake({
      run: async (command, args, options) => {
        await base.deps.run(command, args, options)

        const throttle = args[0] === 'apigateway' ? throttles.shift() : undefined

        if (throttle) throw throttle
      },
    })

    await toolkit.deployBackendApi({ stage: 'dev', app: 'backend-api', appPath: 'apps/api', restApiId: 'id' })

    expect(
      base.calls.filter((call) => {
        return call.args[0] === 'apigateway'
      }),
    ).toHaveLength(3)
    expect(calls).toEqual([])
  })

  it('skips the REST API deployment without an id, and stops when a pre-deploy hook fails', async () => {
    const { toolkit, calls } = fake()

    await toolkit.deployBackendApi({ stage: 'dev', app: 'cron', appPath: 'apps/api' })

    expect(
      calls.some((call) => {
        return call.args[0] === 'apigateway'
      }),
    ).toBe(false)
    await expect(
      toolkit.deployBackendApi({
        stage: 'dev',
        app: 'cron',
        appPath: 'apps/api',
        preDeploy: () => {
          return Promise.reject(new Error('migration'))
        },
      }),
    ).rejects.toThrow('Pre-deployment hooks failed: migration')
  })
})

describe('deployFrontendUi', () => {
  it('syncs the build to the bucket path and invalidates CloudFront', async () => {
    const { toolkit, calls } = fake()

    await toolkit.deployFrontendUi({
      stage: 'dev',
      app: 'website-ui',
      appPath: 'apps/api',
      bucket: 'site-bucket',
      cloudfrontId: 'E123',
      sourcePath: './dist/client',
      syncFlags: ['--delete'],
      destPath: '/mfe',
    })

    expect(line(calls[0])).toBe('pnpm add -g turbo@2.11.7')
    expect(calls.slice(-2).map(line)).toEqual([
      'aws s3 sync ./dist/client s3://site-bucket/mfe --delete --only-show-errors',
      'aws cloudfront create-invalidation --distribution-id E123 --paths /*',
    ])
    expect(calls.at(-2)?.cwd).toBe(path.join(root, 'out', 'apps', 'api'))
  })
})

describe('pruneAndBuild', () => {
  it('builds TURBO_BUILD_TASK when no task is passed', async () => {
    const calls: Call[] = []
    const { deps } = fake({
      run: async (command, args, options) => {
        calls.push({ command, args, ...options })
      },
    })
    const toolkit = createDeployToolkit({ root, service: 'mobile', env: { TURBO_BUILD_TASK: 'build-mobile' }, deps })

    await toolkit.pruneAndBuild('mobile-app', { installProd: false })

    expect(line(calls.at(-1))).toBe('pnpm exec turbo build-mobile --filter=mobile-app --env-mode=loose')
  })
})

describe('skip', () => {
  it('throws the signal deploy-run reports as skipped', () => {
    const { toolkit } = fake()

    expect(() => {
      return toolkit.skip('mobile deploys to dev and prod only')
    }).toThrow(DeploySkipped)
  })
})

describe('resolveApp', () => {
  it('takes what the deploy names, else the app its script sits in', async () => {
    await fs.mkdir(path.join(root, 'apps', 'api'), { recursive: true })
    await fs.writeFile(path.join(root, 'apps', 'api', 'package.json'), JSON.stringify({ name: 'backend-api' }))

    expect(await resolveApp(root, 'apps/api', {})).toEqual({ app: 'backend-api', appPath: 'apps/api' })
    expect(await resolveApp(root, 'apps/api', { app: 'mobile-app' })).toEqual({
      app: 'mobile-app',
      appPath: 'apps/api',
    })
    expect(await resolveApp(root, undefined, { app: 'x', appPath: 'apps/x' })).toEqual({ app: 'x', appPath: 'apps/x' })
  })

  it('asks for app and appPath when the script sits in no app', async () => {
    await expect(resolveApp(root, undefined, {})).rejects.toThrow('pass app and appPath')
    await expect(resolveApp(root, 'devops/scripts', {})).rejects.toThrow('devops/scripts has no package.json name')
  })
})

describe('turboVersion', () => {
  it('reads the exact pin from the root package.json, and refuses a range it cannot pin', async () => {
    expect(await turboVersion(root)).toBe('2.11.7')

    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { turbo: 'latest' } }))

    await expect(turboVersion(root)).rejects.toThrow('must pin turbo to an exact version (found latest)')
  })
})

describe('removeNodeModules', () => {
  it('removes every nested node_modules and keeps everything else', async () => {
    await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true })
    await fs.mkdir(path.join(root, 'apps', 'api', 'node_modules', 'typescript'), { recursive: true })
    await fs.mkdir(path.join(root, 'apps', 'api', 'src'), { recursive: true })

    await removeNodeModules(root)

    expect((await fs.readdir(root)).sort()).toEqual(['apps', 'package.json'])
    expect(await fs.readdir(path.join(root, 'apps', 'api'))).toEqual(['src'])
  })
})
