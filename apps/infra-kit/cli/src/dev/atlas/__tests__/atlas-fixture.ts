import { DEV_CONTEXT_WIRE_VERSION, loadPackageConfig } from '@slip-stream-kit/config/internal'
import * as fs from 'node:fs'
import os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'

import type { AtlasRunnerFacts, AtlasUiInput } from 'src/dev/atlas/atlas-state'
import { logFileName } from 'src/dev/log-sink'
import type { HealthState } from 'src/dev/render'

export const CLOUD_ENV = 'SHOP_URL'

/** One route per reason in the derivation table, keyed by the backend package it names. */
export const ROUTES = {
  '/api/mine': { packageName: 'mine-api', from: ['local', 'cloud'], default: 'cloud' },
  '/api/live': { packageName: 'live-api', from: ['local', 'cloud'], default: 'cloud' },
  '/api/boot': { packageName: 'boot-api', from: ['local', 'cloud'], default: 'cloud' },
  '/api/failed': { packageName: 'failed-api', from: ['local', 'cloud'], default: 'cloud' },
  '/api/cloud': { packageName: 'cloud-api', from: ['cloud'] },
  '/api/off': { packageName: 'off-api', from: ['local', 'cloud'], default: 'cloud' },
  '/api/lonely': { packageName: 'lonely-api', from: ['local'] },
} as const

export interface AtlasRepo {
  root: string
  ui: AtlasUiInput
  logDir: string
  writeFragment: (pkg: string) => void
  removeFragment: (pkg: string) => void
  cleanup: () => void
}

export const originOf = (pkg: string): string => {
  return `https://main.${pkg}.repo.localhost`
}

/**
 * A temp repo with one UI whose `infra-kit.config.ts` declares {@link ROUTES}, and a dev-context dir the
 * vite helper's own reader resolves upward from the UI.
 */
export const makeAtlasRepo = async (extraRoutes: Record<string, unknown> = {}): Promise<AtlasRepo> => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-atlas-')))
  const uiPath = path.join(root, 'apps', 'shop', 'ui')
  const fragmentDir = path.join(root, '.infra-kit', 'dev-context')
  const logDir = path.join(root, 'logs', 'run')

  fs.mkdirSync(uiPath, { recursive: true })
  fs.mkdirSync(fragmentDir, { recursive: true })
  fs.mkdirSync(logDir, { recursive: true })
  fs.writeFileSync(path.join(uiPath, 'package.json'), JSON.stringify({ name: 'shop-ui', type: 'module' }))

  const config = {
    deployedUrlEnv: CLOUD_ENV,
    dev: {
      proxy: {
        templates: { local: 'https://<release>.<packageName>.localhost' },
        routes: { ...ROUTES, ...extraRoutes },
      },
    },
  }

  fs.writeFileSync(path.join(uiPath, 'infra-kit.config.ts'), `export default ${JSON.stringify(config, null, 2)}\n`)

  const loaded = await loadPackageConfig(uiPath)

  return {
    root,
    ui: {
      app: 'shop',
      path: uiPath,
      packageName: 'shop-ui',
      proxy: loaded?.dev?.proxy,
      devEnv: loaded?.dev?.env,
      deployedUrlEnv: loaded?.deployedUrlEnv,
    },
    logDir,
    // `pid: process.pid` keeps the fragment past the helper's dead-writer filter; any other pid is dropped.
    writeFragment: (pkg) => {
      fs.writeFileSync(
        path.join(fragmentDir, `${pkg}.json`),
        JSON.stringify({
          v: DEV_CONTEXT_WIRE_VERSION,
          package: pkg,
          port: 4000,
          pid: process.pid,
          origin: originOf(pkg),
        }),
      )
    },
    removeFragment: (pkg) => {
      fs.rmSync(path.join(fragmentDir, `${pkg}.json`), { force: true })
    },
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

export const app = (name: string): { name: string; packageName: string } => {
  return { name, packageName: `${name}-api` }
}

/** The runner facts for {@link ROUTES}: `mine` serves, `failed` failed, `boot` is planned and not up. */
export const makeFacts = (
  logDir: string,
  health: Map<string, HealthState> = new Map(),
  overrides: Partial<AtlasRunnerFacts> = {},
): AtlasRunnerFacts => {
  // The runner hands over its own records, reason included; the snapshot must read only the package.
  const failedApps = [{ app: app('failed'), reason: 'connect postgres://u:p@h password=hunter2 Bearer x' }]

  return {
    appServers: [{ app: app('mine'), alias: 'main.mine-api.repo.localhost' }],
    failedApps,
    heldLocalPkgs: new Set(),
    uiPortMap: { 'shop-ui': { port: 5173, alias: 'main.shop-ui.repo.localhost' } },
    healthOf: (tag) => {
      return health.get(tag) ?? 'unknown'
    },
    sink: {
      dir: logDir,
      pathFor: (service) => {
        return path.join(logDir, logFileName(service))
      },
    },
    ...overrides,
  }
}

export const PLANNED = [app('mine'), app('boot'), app('failed')]
