import { PACKAGE_VERSION_PREFIX } from '../markers'
import type { PackageType } from '../package-type'
import { RESOURCES } from '../resources'
import { renderTemplate } from '../template'

export interface BuildPackageBodyArgs {
  /** CLI version that generated the block; recorded in the version line. */
  version: string
  /** Resolved package type; selects the resource file and rides in the version line. */
  type: PackageType
  /** The package's `name` from `package.json`, rendered as the heading. */
  packageName: string
  /** Package directory relative to the repo root, posix-separated (e.g. `apps/client/ui`). */
  relDir: string
  /** Whether the package has a `README.md`. The bullet naming it is omitted when it does not. */
  hasReadme: boolean
  /**
   * Whether the package already has a `DESIGN.md`. Accepted for future use and
   * deliberately not rendered: the bullet appears for every `frontend` / `mobile`
   * package regardless, because it tells the agent what to do when the file is
   * absent (ask, do not invent one). Callers pass it so the body can react to it
   * later without a signature change.
   */
  hasDesign: boolean
}

/** The version line, e.g. `<!-- infra-kit:package:version 0.4.0 frontend -->`. */
const buildVersionLine = (version: string, type: PackageType): string => {
  return `${PACKAGE_VERSION_PREFIX}${version} ${type} -->`
}

/**
 * Text of the README bullet, without its `- ` marker — the marker lives in the
 * resource file so prettier sees a list item rather than a bare paragraph
 * placeholder. An empty string removes the whole line (see `renderTemplate`).
 */
const README_BULLET = '`README.md` — what this package is and how to run it.'

/**
 * Render a package's guidance body — the text that goes *between* the package
 * markers, version line first. The body never contains a marker itself; the
 * caller wraps it via `upsertManagedBlock`.
 *
 * The prose lives in `resources/package/<type>.md`, one complete body per type.
 * Edit that file to change the text; nothing here needs to change with it.
 *
 * @example
 * buildPackageBody({ version: '0.4.0', type: 'frontend', packageName: '@hulyo/client-ui',
 *   relDir: 'apps/client/ui', hasReadme: true, hasDesign: false })
 * // => '<!-- infra-kit:package:version 0.4.0 frontend -->\n\n# @hulyo/client-ui\n…'
 */
export const buildPackageBody = (args: BuildPackageBodyArgs): string => {
  const { version, type, packageName, relDir, hasReadme } = args

  const body = renderTemplate(RESOURCES[`package/${type}`], {
    packageName,
    relDir,
    type,
    readmeBullet: hasReadme ? README_BULLET : '',
  })

  return [buildVersionLine(version, type), '', body].join('\n')
}
