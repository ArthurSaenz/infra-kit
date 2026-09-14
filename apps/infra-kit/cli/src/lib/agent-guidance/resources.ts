import designSkeleton from '../../../resources/design/skeleton.md?raw'
// This import list must stay flat, static and explicit. Esbuild bundles the CLI
// into a single file and only inlines specifiers it can see statically — a dynamic
// `import()`, a glob or a computed path resolves to nothing it can follow, the
// specifier survives into `dist`, and node throws `ERR_UNKNOWN_FILE_EXTENSION` on a
// consumer's machine. Every test in this package runs from `src/`, where such a
// refactor still works, so nothing but the bundle guard would catch it.
import backend from '../../../resources/package/backend.md?raw'
import e2e from '../../../resources/package/e2e.md?raw'
import frontend from '../../../resources/package/frontend.md?raw'
import lib from '../../../resources/package/lib.md?raw'
import mobile from '../../../resources/package/mobile.md?raw'
import rootBody from '../../../resources/root/body.md?raw'

/** Path of a resource under `resources/`, without the `.md` extension. */
export type ResourceKey =
  | 'root/body'
  | 'package/frontend'
  | 'package/backend'
  | 'package/lib'
  | 'package/e2e'
  | 'package/mobile'
  | 'design/skeleton'

/**
 * The guidance prose, inlined at build time. Trailing whitespace is stripped from
 * every entry, so a body never ends with a newline.
 *
 * The import list above must stay flat, static and explicit — see the note there.
 */
// Why `trimEnd()`: prettier gives each `.md` a trailing newline, but
// `buildManagedBlock` writes `${start}\n${body}\n${end}`, so an un-normalized body
// would add a blank line before the end marker of every managed block in every
// consumer file. `buildDesignSkeleton` re-adds the single trailing newline its own
// contract has always had.
export const RESOURCES: Readonly<Record<ResourceKey, string>> = {
  'root/body': rootBody.trimEnd(),
  'package/frontend': frontend.trimEnd(),
  'package/backend': backend.trimEnd(),
  'package/lib': lib.trimEnd(),
  'package/e2e': e2e.trimEnd(),
  'package/mobile': mobile.trimEnd(),
  'design/skeleton': designSkeleton.trimEnd(),
}

/**
 * The placeholders each resource is expected to carry, asserted still present
 * after formatting. Cheap and specific, and measurably insufficient on its own:
 * prettier's characteristic damage leaves every token in place and moves a line
 * beside it, which a presence check cannot see. The exact rendered line counts
 * in `bodies.test.ts` are the primary net for that.
 */
export const PLACEHOLDERS: Readonly<Record<ResourceKey, readonly string[]>> = {
  'root/body': ['{{mcpToolPrefix}}'],
  'package/frontend': ['{{packageName}}', '{{relDir}}', '{{type}}', '{{readmeBullet}}'],
  'package/backend': ['{{packageName}}', '{{relDir}}', '{{type}}', '{{readmeBullet}}'],
  'package/lib': ['{{packageName}}', '{{relDir}}', '{{type}}', '{{readmeBullet}}'],
  'package/e2e': ['{{packageName}}', '{{relDir}}', '{{type}}', '{{readmeBullet}}'],
  'package/mobile': ['{{packageName}}', '{{relDir}}', '{{type}}', '{{readmeBullet}}'],
  'design/skeleton': ['{{packageName}}'],
}
