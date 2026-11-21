import type { InfraKitDevEnv, InfraKitDevProxy } from '@slip-stream-kit/config'
import {
  ATLAS_ENV,
  applyDevEnv,
  readCloudOrigin,
  readLocalContext,
  readRelease,
  serializeAtlasEndpoint,
} from '@slip-stream-kit/config/internal'
import * as fs from 'node:fs'
import process from 'node:process'

import { INFRA_KIT_ENV_VAR } from 'src/lib/constants'

import type { DevLogSink } from '../log-sink.js'
import type { HealthState } from '../render.js'
import type { AtlasAssetReader } from './atlas-asset.js'
import { ATLAS_RUN_FOLDER_ID } from './atlas-contract.js'
import type { AtlasSnapshot } from './atlas-contract.js'
import { createAtlasOpener } from './atlas-open.js'
import type { AtlasOpenResult, AtlasOpenTarget } from './atlas-open.js'
import { startAtlasServer } from './atlas-server.js'
import type { AtlasServerHandle, AtlasSnapshotRequest } from './atlas-server.js'
import { buildAtlasSnapshot, hostOnly } from './atlas-snapshot.js'
import type { AtlasBackendInput, AtlasSiteInput } from './atlas-snapshot.js'

/** One launched frontend, from the same `loadPackageConfig` read the runner's degraded-route check makes. */
export interface AtlasUiInput {
  app: string
  path: string
  packageName: string
  proxy: InfraKitDevProxy | undefined
  devEnv: InfraKitDevEnv | undefined
  deployedUrlEnv: string | undefined
}

interface AppRef {
  name: string
  packageName: string
}

/** The runner's live state, read on every request so the snapshot never lags it. */
export interface AtlasRunnerFacts {
  appServers: ReadonlyArray<{ app: AppRef; alias: string }>
  failedApps: ReadonlyArray<{ app: AppRef }>
  heldLocalPkgs: ReadonlySet<string>
  uiPortMap: Readonly<Record<string, { port: number; alias: string }>>
  healthOf: (tag: string) => HealthState
  sink: Pick<DevLogSink, 'dir' | 'pathFor'>
}

export interface AtlasRuntimeOptions {
  /** Every backend this run plans to launch; one not yet up or failed reads `starting`. */
  planned: readonly AppRef[]
  facts: () => AtlasRunnerFacts
  readAsset?: AtlasAssetReader
  opener?: (target: AtlasOpenTarget) => Promise<AtlasOpenResult>
  pid?: number
  now?: () => Date
}

const RUN_LOGS = ['runner', 'turbo', 'watch'] as const

const packagesOf = (entries: ReadonlyArray<{ app: AppRef }>): Set<string> => {
  return new Set(
    entries.map(({ app }) => {
      return app.packageName
    }),
  )
}

const aliasHost = (alias: string | undefined): string | null => {
  return alias === undefined ? null : hostOnly(`https://${alias}`)
}

/** A copy of `base` with the UI's `dev.env` applied the way its own vite applies it. */
const withDevEnv = (ui: AtlasUiInput, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const copy = { ...base }

  applyDevEnv(ui.devEnv, copy)

  return copy
}

/** The runner-side atlas: its inputs, the loopback server, and the env that tells a UI's vite where it is. */
export class AtlasRuntime {
  private readonly options: AtlasRuntimeOptions
  private readonly booting: ReadonlySet<string>
  private uis: AtlasUiInput[] = []
  /** Per UI package: the env its vite was spawned with, `dev.env` applied. Absent until the spawn. */
  private readonly uiEnvs = new Map<string, NodeJS.ProcessEnv>()
  private readonly releases = new Map<string, string>()
  private server: AtlasServerHandle | null = null
  private readonly opener: (target: AtlasOpenTarget) => Promise<AtlasOpenResult>

  constructor(options: AtlasRuntimeOptions) {
    this.options = options
    this.opener = options.opener ?? createAtlasOpener()
    this.booting = new Set(
      options.planned.map((app) => {
        return app.packageName
      }),
    )
  }

  async start(): Promise<void> {
    this.server = await startAtlasServer({
      snapshot: (request) => {
        return this.snapshot(request)
      },
      readAsset: this.options.readAsset,
      open: (id) => {
        return this.open(id)
      },
    })
  }

  /** What to merge into the UI child's env: empty until the server is up, so a failed start passes nothing. */
  endpointEnv(): Record<string, string> {
    return this.server === null ? {} : { [ATLAS_ENV]: serializeAtlasEndpoint(this.server.endpoint) }
  }

  setUis(uis: AtlasUiInput[]): void {
    this.uis = uis
  }

  /**
   * Captured from the env actually handed to the UI child, with each UI's `dev.env` applied the way its own
   * vite applies it — so `INFRA_KIT_ENV` and the cloud origin read here are the ones vite reads, and a
   * backend that later edits this process's env cannot skew them.
   */
  captureSpawnEnv(env: NodeJS.ProcessEnv): void {
    for (const ui of this.uis) {
      this.uiEnvs.set(ui.packageName, withDevEnv(ui, env))
    }
  }

  snapshot(request: AtlasSnapshotRequest): AtlasSnapshot {
    const facts = this.options.facts()

    return buildAtlasSnapshot({
      pid: this.options.pid ?? process.pid,
      logDir: facts.sink.dir,
      sites: this.siteInputs(facts),
      backends: this.backendInputs(facts),
      facts: {
        running: packagesOf(facts.appServers),
        failed: new Set([...packagesOf(facts.failedApps), ...facts.heldLocalPkgs]),
        booting: this.booting,
      },
      logs: RUN_LOGS.map((service) => {
        return { service, path: facts.sink.pathFor(service) }
      }),
      exists: fs.existsSync,
      viewer: { siteId: request.siteId },
      served: request.served,
      now: this.options.now?.() ?? new Date(),
    })
  }

  /** `id` is looked up in this run's own snapshot, so the page can only name a log this run writes. */
  open(id: string): Promise<AtlasOpenResult> {
    const snapshot = this.snapshot({ siteId: null, served: null })

    if (id === ATLAS_RUN_FOLDER_ID) return this.opener({ kind: 'folder', path: snapshot.run.logDir })

    const logs = [
      ...snapshot.logs,
      ...snapshot.sites.map((site) => {
        return site.log
      }),
      ...snapshot.backends.flatMap((backend) => {
        return backend.log === null ? [] : [backend.log]
      }),
    ]

    const log = logs.find((candidate) => {
      return candidate.service === id && candidate.exists
    })

    return log === undefined
      ? Promise.resolve('unknown')
      : this.opener({ kind: 'log', service: log.service, path: log.path })
  }

  async close(): Promise<void> {
    const server = this.server

    this.server = null
    await server?.close()
  }

  private releaseOf(uiPath: string): string {
    let release = this.releases.get(uiPath)

    if (release === undefined) {
      release = readRelease(uiPath)
      this.releases.set(uiPath, release)
    }

    return release
  }

  private siteInputs(facts: AtlasRunnerFacts): AtlasSiteInput[] {
    return this.uis.map((ui): AtlasSiteInput => {
      // Before the UI child exists there is no spawn env; this run's own env is what it is about to get.
      const env = this.uiEnvs.get(ui.packageName) ?? withDevEnv(ui, process.env)

      return {
        app: ui.app,
        packageName: ui.packageName,
        host: aliasHost(facts.uiPortMap[ui.packageName]?.alias),
        health: facts.healthOf(`${ui.app}/ui`),
        logPath: facts.sink.pathFor(`${ui.app}/ui`),
        proxy: ui.proxy,
        localContext: readLocalContext(ui.path),
        env: env[INFRA_KIT_ENV_VAR],
        cloud: readCloudOrigin(ui.deployedUrlEnv, env),
        getRelease: () => {
          return this.releaseOf(ui.path)
        },
      }
    })
  }

  private backendInputs(facts: AtlasRunnerFacts): AtlasBackendInput[] {
    const aliases = new Map(
      facts.appServers.map(({ app, alias }) => {
        return [app.packageName, alias] as const
      }),
    )

    return this.options.planned.map((app): AtlasBackendInput => {
      return {
        app: app.name,
        packageName: app.packageName,
        host: aliasHost(aliases.get(app.packageName)),
        health: facts.healthOf(`${app.name}/api`),
        logPath: facts.sink.pathFor(`${app.name}/api`),
      }
    })
  }
}
