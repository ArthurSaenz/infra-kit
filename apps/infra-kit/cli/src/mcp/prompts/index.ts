import type { McpServer } from '@modelcontextprotocol/server'

import { WORKFLOW_BODIES } from '../workflow-bodies'

/**
 * Register infra-kit's MCP prompts — the human half of the two-channel pair.
 *
 * A prompt is a host UI affordance: a human picks it out of the `/` menu, and an agent cannot
 * fetch one on its own initiative. So every body registered here is ALSO registered as a resource
 * (`src/mcp/resources`), from the same `WORKFLOW_BODIES` constant, which is what an agent reads.
 * Two channels, one constant — the prose cannot drift between them without two edits.
 */
export const initializePrompts = async (server: McpServer) => {
  server.registerPrompt(
    'release-create',
    {
      title: 'Cut a release',
      description:
        'The procedure for cutting a release with infra-kit: preconditions, the two-call confirm ' +
        'protocol, and what "next" resolves against.',
      // `argsSchema` is OMITTED, deliberately. The SDK types it optional, and this is the one shape
      // on which a `prompts/get` carrying no `arguments` cannot throw: a bare `z.object({…})`
      // argsSchema rejects an omitted `arguments`, and the obvious `.default({})` repair voids
      // `.shape`. Giving this prompt a `version` argument means solving that first — a named
      // follow-up, not a silent gap. The consequence is that the prompt takes nothing and the
      // human types the version in chat afterwards.
    },
    // No-args callback: the SDK's prompt-callback types degrade to `(ctx) => …` when no argsSchema
    // is declared, and a zero-parameter function satisfies that.
    () => {
      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: WORKFLOW_BODIES['release-create'] },
          },
        ],
      }
    },
  )
}
