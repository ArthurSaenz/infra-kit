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
  /** Whether `docs/e2e-playwright.md` exists at the repo root. Read by the e2e body only. */
  hasE2eDoc?: boolean
  /**
   * The package's `package.json` script names. A check, or the lib body's build step, is named only
   * when the package defines it; omitted, every one is rendered.
   */
  scripts?: readonly string[]
  /** Whether `package.json` declares `exports` or `bin`. Read by the lib body only; omitted = true. */
  hasPublicSurface?: boolean
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

export const E2E_DOC_PATH = 'docs/e2e-playwright.md'

const E2E_DOC_BULLET = `\`${E2E_DOC_PATH}\` at the repo root — env setup, run modes, \`E2E_SLOW_MO\`, traces after a failure.`

const CHECK_SCRIPTS = ['ts-check', 'eslint-check', 'test'] as const

const SURFACE_BULLET =
  'The public surface is what `package.json` exposes — its `exports` map, or `bin` for a CLI; changing it is a breaking change for every dependent package.'

const BUILD_BULLET = 'Run `pnpm run build` before a dependent package can see a change.'

/**
 * A package can be a bare config or data folder with no scripts and no entry point, and a step the
 * package does not define is an instruction that fails — so each one is named only when it exists.
 */
const definesScript = (scripts: readonly string[] | undefined, script: string): boolean => {
  return scripts?.includes(script) ?? true
}

const buildChecksBullet = (scripts: readonly string[] | undefined): string => {
  const commands = CHECK_SCRIPTS.filter((script) => {
    return definesScript(scripts, script)
  }).map((script) => {
    return `pnpm run ${script}`
  })

  if (commands.length === 0) return ''

  return `\`${commands.join(' && ')}\` — this package only.`
}

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
  const { version, type, packageName, relDir, hasReadme, hasE2eDoc, scripts, hasPublicSurface = true } = args

  // `renderTemplate` refuses a variable the template never uses, so the type-only ones are keyed on type.
  const body = renderTemplate(RESOURCES[`package/${type}`], {
    packageName,
    relDir,
    type,
    readmeBullet: hasReadme ? README_BULLET : '',
    checksBullet: buildChecksBullet(scripts),
    ...(type === 'e2e' ? { e2eDocBullet: hasE2eDoc ? E2E_DOC_BULLET : '' } : {}),
    ...(type === 'lib'
      ? {
          surfaceBullet: hasPublicSurface ? SURFACE_BULLET : '',
          buildBullet: definesScript(scripts, 'build') ? BUILD_BULLET : '',
        }
      : {}),
  })

  // Trailing '': see buildRootBody.
  return [buildVersionLine(version, type), '', body, ''].join('\n')
}
