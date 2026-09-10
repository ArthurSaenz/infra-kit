import type { McpServer } from '@modelcontextprotocol/server'

import type { InfraKitConfig } from 'src/lib/infra-kit-config'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'

import type { WorkflowKey } from '../workflow-bodies'
import { WORKFLOW_BODIES } from '../workflow-bodies'
import type { DevContextSnapshot } from './dev-context'
import { readDevContext } from './dev-context'

/** Stable URI of the merged-config resource. */
export const CONFIG_RESOURCE_URI = 'infra-kit://config'

/** Stable URI of the dev-context resource. */
export const DEV_CONTEXT_RESOURCE_URI = 'infra-kit://dev-context'

/**
 * Stable URI of the `release-create` procedure.
 *
 * This is the agent-reachable half of the pair: the same body is also registered as a prompt
 * (`src/mcp/prompts`), because an agent can read a resource but cannot fetch a prompt.
 */
export const RELEASE_CREATE_WORKFLOW_URI = 'infra-kit://workflow/release-create'

/**
 * Stable URI of the `setup` procedure.
 *
 * Resource-only, unlike `release-create`: `setup`'s human channel is the `/infra-kit:setup` plugin
 * command, so the prompt half would duplicate it rather than reach a second reader. It ships in the
 * CLI and not in the plugin because `scripts/check-workflow-resource-published.mjs` refuses to let a
 * plugin command merge until the PUBLISHED CLI answers `resources/list` with the URI its body names.
 */
export const SETUP_WORKFLOW_URI = 'infra-kit://workflow/setup'

/**
 * Stable URI of the `session` procedure.
 *
 * Resource-only, on `setup`'s precedent: its human channel is the `/infra-kit:session` plugin
 * command, so a prompt would duplicate that entry rather than reach a second reader.
 *
 * What it carries that no tool's own description can: the order to call them in, and the two silent
 * failures — a load that lands in a terminal nobody is watching, and an `env-status` over MCP that
 * cannot see a load made in the same session.
 */
export const SESSION_WORKFLOW_URI = 'infra-kit://workflow/session'

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
 * Register one workflow procedure at its URI.
 *
 * A helper rather than a second copy of the registration block: the two bodies differ only in their
 * key, URI and blurb, and a hand-copied handler is exactly where a second workflow would quietly get
 * the FIRST one's text — a drift no `resources/list` assertion would catch, because the URI would
 * still be listed.
 *
 * No dep injection and no `async`: the body is a build-time constant, so there is nothing to read,
 * nothing to fail, and nothing a test would need to stub.
 */
const registerWorkflow = (
  server: McpServer,
  workflow: { key: WorkflowKey; uri: string; title: string; description: string },
): void => {
  server.registerResource(
    `infra-kit-workflow-${workflow.key}`,
    workflow.uri,
    { title: workflow.title, description: workflow.description, mimeType: 'text/markdown' },
    (uri) => {
      return { contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text: WORKFLOW_BODIES[workflow.key] }] }
    },
  )
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

  registerWorkflow(server, {
    key: 'release-create',
    uri: RELEASE_CREATE_WORKFLOW_URI,
    title: 'release-create procedure',
    description:
      'How to cut a release with the release-create tool: the preconditions, the two-call confirm ' +
      'protocol, and what the "next" token actually resolves against. Read this before calling ' +
      'mcp__infra-kit__release-create.',
  })

  registerWorkflow(server, {
    key: 'setup',
    uri: SETUP_WORKFLOW_URI,
    title: 'setup procedure',
    description:
      'How to set a machine up with the setup tool: the ordered local writes, then the dependency ' +
      'converge; what tools/mode/skipTools each narrow; which recipes are printed instead of run and ' +
      'why; and what to run when a repo still tells you to set it up some older way. Read this before ' +
      'calling mcp__infra-kit__setup.',
  })

  registerWorkflow(server, {
    key: 'session',
    uri: SESSION_WORKFLOW_URI,
    title: 'session procedure',
    description:
      'How to switch a terminal to a named environment by composing env-list, env-load and ' +
      'env-clear: which tool to call when the human names no environment, how the loaded vars reach ' +
      'the terminal that launched Claude Code and when they appear there, and the two silent ' +
      'failures — a load that lands in a session nothing is watching, and a clear that loses a ' +
      'same-second tie to the load before it. Read this before loading an environment for someone.',
  })
}
