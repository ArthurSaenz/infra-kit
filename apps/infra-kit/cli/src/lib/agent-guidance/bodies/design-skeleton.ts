import { RESOURCES } from '../resources'
import { renderTemplate } from '../template'

/**
 * The static front-matter line `buildDesignSkeleton` rewrites. Front matter cannot
 * carry a `{{…}}` placeholder — prettier reformats `name: {{packageName}}` into
 * `name: { { packageName } }`, which is still valid YAML with the expected key, so
 * every structural guard passes on the broken output. A literal replaced by exact
 * match avoids the whole class. Measured unique in the file: `fontFamily: TODO`
 * and `description: TODO` do not collide with it.
 */
const FRONT_MATTER_NAME = 'name: TODO'

/**
 * Skeleton for a package's `DESIGN.md`, in the shape of the Google Labs
 * `design.md` spec: YAML front matter (`name`, `description`, `colors`,
 * `typography`, `rounded`, `spacing`, `components`) followed by the prose
 * sections in spec order. The text lives in `resources/design/skeleton.md`.
 *
 * Every value is a placeholder a human replaces — infra-kit cannot author brand
 * content, so the skeleton exists to give that content a home and a shape, not to
 * be correct on its own. `audit --fix --design` writes it only for `frontend` /
 * `mobile` packages and never overwrites an existing file.
 *
 * @example
 * buildDesignSkeleton('@hulyo/client-ui')
 * // => '---\nname: @hulyo/client-ui\n…'
 */
export const buildDesignSkeleton = (packageName: string): string => {
  const rendered = renderTemplate(RESOURCES['design/skeleton'], { packageName })

  const nameLine = `name: ${packageName}`
  // Function replacement, not a string: a string second argument treats `$&`, `` $` ``
  // and `$'` in the value as replacement patterns, and `packageName` falls back to the
  // directory basename, which is not constrained to npm name syntax.
  const named = rendered.replace(FRONT_MATTER_NAME, () => {
    return nameLine
  })

  // Re-add the single trailing newline this builder has always emitted: `RESOURCES`
  // trims every entry, and unlike the two block bodies this one is written to a file
  // of its own rather than wrapped in markers.
  return `${named}\n`
}
