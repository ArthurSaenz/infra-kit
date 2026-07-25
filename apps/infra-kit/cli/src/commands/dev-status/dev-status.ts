import { z } from 'zod'

import { defaultIsListening } from 'src/dev/proxy/portless-driver'
import { logger } from 'src/lib/logger'
import { defineMcpTool, textContent } from 'src/types'

import { readDevContextFragments } from './dev-context-reader'

/**
 * Injection seams for the handler. All three default to the real world; tests override them so the read is
 * hermetic (a seeded fragment dir, a fixed clock, a stub probe) and NO server is ever spawned.
 */
export interface DevStatusDeps {
  /** Clock for the freshness computation. Defaults to `Date.now`. */
  now?: () => number
  /** Root to read `.infra-kit/dev-context` under. Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * TCP liveness probe. Defaults to the engine's OWN probe ({@link defaultIsListening}, a bounded
   * `net.connect`) — the same one `doctor` uses. `dev-status` NEVER asserts liveness it did not probe:
   * every `live` value below is a real connect result, not an inference from fragment presence.
   */
  isListening?: (port: number) => Promise<boolean>
}

/**
 * Report what `infra-kit dev` currently has running, by READING the dev-context fragments the dev server
 * writes to `<cwd>/.infra-kit/dev-context/`. Strictly advisory and strictly read-only: it starts no server
 * and only inspects on-disk state plus a bounded TCP probe.
 *
 * Two facts an agent must not conflate are surfaced separately:
 *   - PRESENCE + FRESHNESS: a fragment exists and how long ago it was written (`fragmentMtime` /
 *     `ageSeconds`, from the file's mtime — the authoritative signal). A stale fragment is a strong hint a
 *     server died without cleaning up.
 *   - LIVENESS: whether the app's port answers a TCP connect RIGHT NOW. A fresh fragment with `live:false`
 *     is a crashed/killed dev server whose fragment was never removed.
 *
 * When no fragments exist (no dev session, or `dev` cleaned up on exit) it returns `{ active: false,
 * apps: [] }` — a clean empty result, not an error.
 */
export const devStatus = async (deps: DevStatusDeps = {}) => {
  const now = deps.now ?? Date.now
  const isListening = deps.isListening ?? defaultIsListening

  const records = readDevContextFragments(deps.cwd)
  const at = now()

  const apps = await Promise.all(
    records.map(async (record) => {
      const ageSeconds = Math.max(0, Math.round((at - record.fragmentMtimeMs) / 1000))
      const live = await isListening(record.port)

      return {
        app: record.app,
        package: record.package,
        port: record.port,
        pid: record.pid,
        alias: record.alias,
        origin: record.origin,
        release: record.release,
        writtenAt: record.writtenAt > 0 ? new Date(record.writtenAt).toISOString() : null,
        fragmentMtime: new Date(record.fragmentMtimeMs).toISOString(),
        ageSeconds,
        live,
      }
    }),
  )

  const active = apps.length > 0

  if (!active) {
    logger.info('No active infra-kit dev session (no dev-context fragments found).')
  } else {
    logger.info(`infra-kit dev: ${apps.length} app(s) with a dev-context fragment on disk:`)

    for (const app of apps) {
      const liveness = app.live ? 'live' : 'NOT responding'
      const freshness = `written ${app.ageSeconds}s ago`

      logger.info(`  ${app.app} (${app.package}) → ${app.origin} on :${app.port} — ${liveness}, ${freshness}`)
    }
  }

  const structuredContent = { active, apps }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

const devStatusOutputSchema = {
  active: z
    .boolean()
    .describe(
      'True when at least one dev-context fragment exists on disk (an infra-kit dev session has apps registered). False means no active dev session was found — this is a clean result, NOT an error.',
    ),
  apps: z
    .array(
      z.object({
        app: z.string().describe('App folder name (the fragment filename without .json).'),
        package: z.string().describe('The app package name the vite helper reads to decide a local route.'),
        port: z.number().describe('The actual bound port the dev server is listening on.'),
        pid: z
          .number()
          .describe('PID of the dev-server process that wrote the fragment (ownership / staleness metadata).'),
        alias: z.string().describe('Registered portless hostname for the app.'),
        origin: z.string().describe('Authoritative local origin the vite helper proxies to for this app.'),
        release: z.string().describe('Release slug the runner recorded for this worktree.'),
        writtenAt: z
          .string()
          .nullable()
          .describe(
            'ISO 8601 time the runner self-reported writing the fragment (writer clock — may be wrong; prefer fragmentMtime). Null when the fragment did not record it.',
          ),
        fragmentMtime: z
          .string()
          .describe('ISO 8601 filesystem mtime of the fragment file — the AUTHORITATIVE freshness signal.'),
        ageSeconds: z
          .number()
          .describe(
            'Seconds since the fragment was last written on disk. A large value with live:false means a stale/abandoned fragment.',
          ),
        live: z
          .boolean()
          .describe(
            'Whether a TCP connection to the app port succeeds RIGHT NOW (a real engine liveness probe, not an inference). A fresh fragment with live:false is a crashed or killed dev server whose fragment was not cleaned up.',
          ),
      }),
    )
    .describe('One entry per dev-context fragment on disk, sorted by app name. Empty when no dev session is active.'),
}

// MCP Tool Registration
export const devStatusMcpTool = defineMcpTool({
  name: 'dev-status',
  description:
    'Report what `infra-kit dev` currently has running by READING the on-disk dev-context fragments (never starts a server). Advisory + read-only: surfaces each app’s package, bound port, portless alias, local origin, fragment freshness (mtime / ageSeconds), and a live TCP liveness probe of the port. Returns { active: false, apps: [] } when no dev session is active.',
  inputSchema: {},
  outputSchema: devStatusOutputSchema,
  handler: () => {
    return devStatus()
  },
})
