import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { InfraKitConfig } from 'src/lib/infra-kit-config'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'

import type { DevContextSnapshot } from './dev-context'
import { readDevContext } from './dev-context'

/** Stable URI of the merged-config resource. */
export const CONFIG_RESOURCE_URI = 'infra-kit://config'

/** Stable URI of the dev-context resource. */
export const DEV_CONTEXT_RESOURCE_URI = 'infra-kit://dev-context'

/**
 * The two disk reads the resources need, injected so the registration is unit-testable without touching
 * the filesystem or the config-loader's mtime cache. Production uses the real readers by default.
 */
export interface ResourceDeps {
  /** Loads the merged `infra-kit.json` (all override layers applied). May throw when no config exists. */
  loadConfig: () => Promise<InfraKitConfig>
  /** Reads the dev-context fragments `infra-kit dev` last wrote. Never throws; absent session ⇒ empty. */
  readDevContext: () => DevContextSnapshot
}

const defaultDeps: ResourceDeps = {
  loadConfig: getInfraKitConfig,
  readDevContext: () => {
    return readDevContext()
  },
}

/** Serialize a resource body as pretty JSON text — the wire form every MCP client can read. */
const jsonResource = (uri: string, value: unknown): { contents: { uri: string; mimeType: string; text: string }[] } => {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] }
}

/**
 * Register infra-kit's READ-ONLY MCP resources so an agent can inspect the repo's config and dev state
 * without calling a tool (or mutating anything):
 *
 *   - `infra-kit://config`       — the merged `infra-kit.json` an agent would run against.
 *   - `infra-kit://dev-context`  — what `infra-kit dev` last wrote (backends up, ports, freshness); an
 *                                  absent dev session resolves to an empty `session: 'none'` payload, NOT
 *                                  an error.
 *
 * Both handlers are side-effect free and swallow their reader's failure into an `{ error }` payload rather
 * than throwing, so a bad on-disk config can never crash the long-lived MCP server.
 */
export const initializeResources = async (server: McpServer, deps: ResourceDeps = defaultDeps) => {
  server.registerResource(
    'infra-kit-config',
    CONFIG_RESOURCE_URI,
    {
      title: 'infra-kit config',
      description: 'The merged infra-kit.json configuration (all override layers applied). Read-only.',
      mimeType: 'application/json',
    },
    async (uri) => {
      try {
        return jsonResource(uri.toString(), await deps.loadConfig())
      } catch (error) {
        return jsonResource(uri.toString(), { error: error instanceof Error ? error.message : String(error) })
      }
    },
  )

  server.registerResource(
    'infra-kit-dev-context',
    DEV_CONTEXT_RESOURCE_URI,
    {
      title: 'infra-kit dev context',
      description:
        'What `infra-kit dev` last wrote: backends currently up, their ports/origins, and fragment ' +
        'freshness. Read-only and advisory (no liveness probe). No active session resolves to an empty payload.',
      mimeType: 'application/json',
    },
    // The SDK's `ReadResourceCallback` accepts a synchronous return; the disk read is sync, so no `async`.
    (uri) => {
      return jsonResource(uri.toString(), deps.readDevContext())
    },
  )
}
