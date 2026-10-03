import { readRelease } from './read-release'
import { slugifyHostLabel } from './release-slug'
import { readRepoSlug } from './repo-slug'

/**
 * The portless alias NAME (`<release>.<label>.<repo>`, no `.localhost`) for the package in `appDir`.
 *
 * `<repo>` is what keeps two repos apart: travelist and hulyo both have a `website-ui` and both cut
 * same-named branches, and without it their aliases were identical, so `dev --reuse` adopted the other
 * repo's server. The dev-server registers this name, and `infraKitE2e()` and `infra-kit e2e` aim at it,
 * so all three must come from here.
 *
 * @throws When the package name yields no legal DNS label.
 * @example
 * readAppAliasName('@hulyo/website-ui', '/projects/hulyo-monorepo/apps/website/ui') // => 'dev.hulyo-website-ui.hulyo-monorepo'
 */
export const readAppAliasName = (packageName: string, appDir: string): string => {
  const label = slugifyHostLabel(packageName)

  if (label === '') {
    throw new Error(`infra-kit: package name "${packageName}" has no letters or digits to build a hostname from.`)
  }

  return `${readRelease(appDir)}.${label}.${readRepoSlug(appDir)}`
}

/** {@link readAppAliasName} as the hostname a browser dials (`<release>.<label>.<repo>.localhost`). */
export const readAppAliasHost = (packageName: string, appDir: string): string => {
  return `${readAppAliasName(packageName, appDir)}.localhost`
}
