// This import list must stay flat, static and explicit. Esbuild bundles the CLI
// into a single file and only inlines specifiers it can see statically — a dynamic
// `import()`, a glob or a computed path resolves to nothing it can follow, the
// specifier survives into `dist`, and node throws `ERR_UNKNOWN_FILE_EXTENSION` on a
// consumer's machine. Every test in this package runs from `src/`, where such a
// refactor still works, so nothing but the bundle guard would catch it.
//
// The `?raw` suffix — not a bare `.md` — is the one spelling correct in all three
// toolchains this package builds with (see src/md.d.ts).
import releaseCreate from '../../resources/workflow/release-create.md?raw'
import session from '../../resources/workflow/session.md?raw'
import setup from '../../resources/workflow/setup.md?raw'

/**
 * Name of a workflow procedure.
 *
 * `release-create` and `setup` name the exposed MCP tool they are the procedure for; `session` names
 * the plugin command instead, because it is the procedure for no single tool.
 */
export type WorkflowKey = 'release-create' | 'session' | 'setup'

/**
 * The workflow procedures, inlined at build time.
 *
 * Every body is registered as an MCP resource under `infra-kit://workflow/<key>`, which is the
 * channel an AGENT can reach: an agent cannot fetch a prompt, because a prompt is a host UI
 * affordance a human picks out of the `/` menu.
 *
 * Every body is resource-only. The human surface for each is its plugin command or skill — the
 * `/infra-kit:release-create` and `/infra-kit:setup` commands, the `session` skill — and a prompt
 * carrying the same text is a duplicate `/` row next to it rather than a second reader, which is
 * exactly what the retired `release-create` prompt was (docs/release-create-prompt-removal-plan.md).
 *
 * `trimEnd()` because prettier gives every `.md` a trailing newline and every wire form carries the
 * body verbatim; normalizing here keeps the channels byte-identical by construction.
 */
export const WORKFLOW_BODIES: Readonly<Record<WorkflowKey, string>> = {
  'release-create': releaseCreate.trimEnd(),
  session: session.trimEnd(),
  setup: setup.trimEnd(),
}
