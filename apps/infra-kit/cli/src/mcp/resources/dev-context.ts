/**
 * TRANSITIONAL re-export shim. The reader itself moved to `src/lib/dev-context` so that BOTH callers
 * — this MCP resource and the `dev-status` command — share one implementation; before the move the
 * command carried its own copy that resolved the fragment directory differently (a plain
 * `path.join(cwd, …)` instead of an upward search), so the same server answered the same question two
 * different ways depending on whether a client read the resource or called the tool.
 *
 * This file exists only so `./index.ts` keeps importing an unchanged specifier, which is what lets the
 * move be a pure rename with no content edit. New code MUST import from `src/lib/dev-context`; this
 * shim is deleted once the resource is repointed.
 */
export type { DevContextApp, DevContextSnapshot } from 'src/lib/dev-context'
export { readDevContext } from 'src/lib/dev-context'
