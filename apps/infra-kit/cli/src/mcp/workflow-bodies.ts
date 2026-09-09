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

/** Name of a workflow procedure, matching the exposed MCP tool it is the procedure for. */
export type WorkflowKey = 'release-create'

/**
 * The workflow procedures, inlined at build time.
 *
 * Each body is registered TWICE from this one record — as an MCP resource under
 * `infra-kit://workflow/<key>` and as an MCP prompt named `<key>` — because the two channels
 * reach different readers: an agent cannot fetch a prompt (it is a host UI affordance) but can
 * read a resource, while a human picks the prompt out of the `/` menu. One constant, so drift
 * takes two edits and is not silent.
 *
 * `trimEnd()` because prettier gives every `.md` a trailing newline and both wire forms carry the
 * body verbatim; normalizing here keeps the two channels byte-identical by construction.
 */
export const WORKFLOW_BODIES: Readonly<Record<WorkflowKey, string>> = {
  'release-create': releaseCreate.trimEnd(),
}
