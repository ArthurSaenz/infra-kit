import type { InfraKitE2e } from '@slip-stream-kit/config'
import { describeProxyRoutes, loadDev, readLocalContext, slugifyHostLabel } from '@slip-stream-kit/config/internal'
import type { ProxyRouteDescription } from '@slip-stream-kit/config/internal'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import { defaultHealthProbe } from 'src/dev/health-probe'
import type { HealthProbe } from 'src/dev/health-probe'
import { listRoutes as listPortlessRoutes } from 'src/dev/proxy/portless-driver'
import type { PortlessRoute } from 'src/dev/proxy/portless-driver'
import { agentMode } from 'src/lib/agent-mode'
import { readAppRelease } from 'src/lib/app-release'
import { INFRA_KIT_ENV_VAR } from 'src/lib/constants'
import { OperationError } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { getProjectRoot } from 'src/lib/git-utils'
import { loadAuthoredPackageConfig, readPackageJson } from 'src/lib/package-validator/loader'

/** A UI proxy route as the local dev server is running it, with its backend's liveness when local. */
export interface E2eRoute extends ProxyRouteDescription {
  /** Local routes only: whether the backend behind it answers `/__health` right now. `null` for cloud. */
  live: boolean | null
}

/** Where one e2e package's run would go, and everything the decision was made from. */
export interface E2eTarget {
  app: string
  testsDir: string
  /** `<app>/ui` or `<app>/api`. */
  target: string
  packageName: string
  mode: 'local' | 'cloud'
  baseUrl: string
  baseUrlEnv: string
  release: string
  /** `INFRA_KIT_ENV` of this process — the env a cloud run targets. */
  env: string | null
  /** The local address probed, whether or not anything answered there. */
  localUrl: string
  /** Local UI runs only: the proxy split the dev server is serving with. Empty otherwise. */
  routes: E2eRoute[]
}

export interface E2eTargetDeps {
  cwd?: string
  projectRoot?: string
  env?: NodeJS.ProcessEnv
  listRoutes?: () => PortlessRoute[]
  healthProbe?: HealthProbe
}

interface E2ePackage {
  app: string
  testsDir: string
  e2e: InfraKitE2e
}

/** Every `apps/<app>/tests` package whose `infra-kit.config.ts` declares an `e2e` block. */
const discoverE2ePackages = async (root: string): Promise<E2ePackage[]> => {
  const appsDir = path.join(root, 'apps')
  const apps = fs.existsSync(appsDir) ? fs.readdirSync(appsDir).toSorted() : []
  const found: E2ePackage[] = []

  for (const app of apps) {
    const testsDir = path.join(appsDir, app, 'tests')
    const config = await loadAuthoredPackageConfig(testsDir).catch(() => {
      return undefined
    })

    if (config?.e2e) found.push({ app, testsDir, e2e: config.e2e })
  }

  return found
}

/** The app folder `cwd` sits in (`apps/<app>/…`), or `undefined` when it is outside `apps/`. */
const appFromCwd = (root: string, cwd: string): string | undefined => {
  const [top, app] = path.relative(root, cwd).split(path.sep)

  return top === 'apps' && app ? app : undefined
}

const pickPackage = (packages: E2ePackage[], app: string | undefined, cwd: string, root: string): E2ePackage => {
  const byName = (name: string | undefined) => {
    return packages.find((candidate) => {
      return candidate.app === name
    })
  }

  const picked = byName(app) ?? (app === undefined ? byName(appFromCwd(root, cwd)) : undefined)

  if (picked) return picked
  if (app === undefined && packages.length === 1) return packages[0]!

  const names = packages.map((candidate) => {
    return candidate.app
  })

  if (names.length === 0) {
    throw new OperationError(undefined, {
      operation: 'find an e2e package',
      remediation:
        'declare `e2e: { target, baseUrlEnv }` in `apps/<app>/tests/infra-kit.config.ts` (see the `InfraKitE2e` type)',
      stderrExcerpt: `no apps/*/tests package under ${root} declares an e2e block`,
    })
  }

  const argument = 'app'

  throw new StructuredRefusalError(
    {
      status: 'argument_required',
      argument,
      choices: z.toJSONSchema(z.object({ app: z.enum(names as [string, ...string[]]) })),
      agentMode: agentMode.source,
    },
    2,
    {
      operation: 'pick the e2e package to run',
      remediation: `pass --app ${names.join('|')}`,
      stderrExcerpt:
        app === undefined
          ? 'more than one app has e2e tests'
          : `"${app}" has no e2e block; e2e apps: ${names.join(', ')}`,
    },
  )
}

const probeRoutes = async (routes: ProxyRouteDescription[], ports: Map<string, number>, probe: HealthProbe) => {
  return Promise.all(
    routes.map(async (route): Promise<E2eRoute> => {
      if (route.source === 'cloud') return { ...route, live: null }

      const port = ports.get(route.packageName) ?? 0
      // A held fragment (a boot-failed backend) records port 0: the route stays local, and nothing serves it.
      const live = port > 0 && (await probe({ tag: `${route.packageName}`, port, kind: 'api' })) === 'ok'

      return { ...route, live }
    }),
  )
}

/**
 * Decide where an e2e package's run goes: this worktree's dev server when it serves the target, the
 * package's `cloud` URL at `INFRA_KIT_ENV` otherwise. Reads and probes only — it starts nothing.
 *
 * @throws When no dev server serves the target and the cloud side cannot be named (no `cloud`, no env).
 */
export const resolveE2eTarget = async (app: string | undefined, deps: E2eTargetDeps = {}): Promise<E2eTarget> => {
  const cwd = deps.cwd ?? process.cwd()
  const root = deps.projectRoot ?? (await getProjectRoot())
  const env = (deps.env ?? process.env)[INFRA_KIT_ENV_VAR] || null
  const probe = deps.healthProbe ?? defaultHealthProbe
  const picked = pickPackage(await discoverE2ePackages(root), app, cwd, root)
  const { target, baseUrlEnv, cloud } = picked.e2e
  const [targetApp, kind] = target.split('/') as [string, 'ui' | 'api']
  const targetDir = path.join(root, 'apps', targetApp, kind)
  const packageName = (await readPackageJson(targetDir)).name

  if (!packageName) {
    throw new OperationError(undefined, {
      operation: `resolve e2e target ${target}`,
      remediation: `check \`e2e.target\` in ${path.join(picked.testsDir, 'infra-kit.config.ts')}`,
      stderrExcerpt: `${targetDir} has no package.json name`,
    })
  }

  const release = readAppRelease(targetDir)
  const host = `${release}.${slugifyHostLabel(packageName)}.localhost`
  const localContext = readLocalContext(targetDir)
  let localUrl = `https://${host}`
  let port = 0

  if (kind === 'ui') {
    // Portless records the UI's hostname against the vite port the runner assigned; the vite ping on that
    // port — not a request through the alias — is what proves THIS worktree's UI is the one serving.
    port =
      (deps.listRoutes ?? listPortlessRoutes)().find((route) => {
        return route.name === host || route.name === `${release}.${slugifyHostLabel(packageName)}`
      })?.port ?? 0
  } else {
    const info = localContext.info.get(packageName)

    port = info?.port ?? 0
    localUrl = info?.origin ?? localUrl
  }

  const live = port > 0 && (await probe({ tag: target, port, kind })) === 'ok'
  const base = { app: picked.app, testsDir: picked.testsDir, target, packageName, baseUrlEnv, release, env, localUrl }

  if (live) {
    const dev = kind === 'ui' ? await loadDev(targetDir) : undefined
    const described = dev?.proxy
      ? describeProxyRoutes({
          proxy: dev.proxy,
          localContext,
          env: env ?? undefined,
          getRelease: () => {
            return release
          },
        })
      : []
    const ports = new Map(
      [...localContext.info].map(([name, info]) => {
        return [name, info.port] as const
      }),
    )

    return { ...base, mode: 'local', baseUrl: localUrl, routes: await probeRoutes(described, ports, probe) }
  }

  const processEnv = deps.env ?? process.env

  // Doppler already carries each env's deployed URL under `baseUrlEnv`, so a package without `cloud`
  // uses the value `env-load` put there. `INFRA_KIT_ENV` is still required: it is what names the env for
  // the protected-env check, and a variable without it could be left over from any earlier load.
  const cloudUrl = cloud ? env && cloud.replaceAll('<env>', env) : processEnv[baseUrlEnv]

  if (!env || !cloudUrl) {
    const missing = env
      ? `${baseUrlEnv} is not set (and \`e2e.cloud\` is not configured)`
      : `${INFRA_KIT_ENV_VAR} is not set`

    throw new OperationError(undefined, {
      operation: `resolve where ${picked.app}'s e2e tests run`,
      remediation: `start the dev server (\`infra-kit dev\`), or load an environment (\`infra-kit env-load -c <env>\`) to run against cloud`,
      stderrExcerpt: `nothing serves ${target} at ${localUrl}, and ${missing}`,
    })
  }

  return { ...base, mode: 'cloud', baseUrl: cloudUrl, routes: [] }
}
