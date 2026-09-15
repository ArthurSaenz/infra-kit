import { describe, expect, it } from 'vitest'

import { hasSegment, isBrewKegOf, isWithin, npmPrefixOfPackage } from 'src/lib/install-manager'
import type { RealpathFn } from 'src/lib/install-manager'

/**
 * The four path predicates, exercised against the FIVE-NAME matrix the dependency registry needs
 * (`docs/archive/mcp/mcp-setup-dependency-plan.md` §5.1). Red here looks like a predicate accepting a path from a
 * different tool's row.
 *
 * `install-manager.test.ts` covers these only through `detectInstallManager`, and only ever for
 * `infra-kit` — so it cannot tell a predicate that reads the formula name from one that reads the
 * binary name. For these five tools those names DIVERGE (aws's binary is `aws`, its formula `awscli`),
 * which is exactly where a single conflated name would synthesise `brew upgrade aws` against a formula
 * that does not exist.
 */

/** Roots in these cases are already canonical, so canonicalising them is a no-op. */
const identity: RealpathFn = (dir) => {
  return dir
}

/** Where the AWS-documented `install.sh` puts a user-scope install — no keg, no npm prefix. */
const AWS_SCRIPT_BIN = '/Users/x/.local/share/aws-cli/v2/2.17.0/dist/aws'

describe('isBrewKegOf', () => {
  it.each([
    // [path, formula asked about, expected]
    ['/opt/homebrew/Cellar/gh/2.60.0/bin/gh', 'gh', true],
    ['/opt/homebrew/Cellar/awscli/2.17.0/bin/aws', 'awscli', true],
    ['/opt/homebrew/Cellar/doppler/3.68.0/bin/doppler', 'doppler', true],
    ['/opt/homebrew/Cellar/gnupg/2.5.20/bin/gpg', 'gnupg', true],
    // The false-positive this helper exists to prevent: an `npm i -g` under a node keg. brew has never
    // heard of `gh` here, yet a bare `Cellar` segment is right there in the path.
    ['/opt/homebrew/Cellar/node/24.0.0/lib/node_modules/gh/bin/gh', 'gh', false],
    // The script-installed aws is not a keg at all. Reading it as one would run `brew upgrade awscli`,
    // installing a SECOND aws and leaving PATH order to decide which `aws --version` answers (PM-2).
    [AWS_SCRIPT_BIN, 'awscli', false],
    // The keg is named for the FORMULA, not the tap that serves it: doppler is installed via
    // `dopplerhq/cli/doppler` but lands in `Cellar/doppler`.
    ['/opt/homebrew/Cellar/doppler/3.68.0/bin/doppler', 'dopplerhq', false],
    // Binary name and formula name diverge for aws; asking with the wrong one must miss.
    ['/opt/homebrew/Cellar/awscli/2.17.0/bin/aws', 'aws', false],
  ])('%s asked about %s -> %s', (binPath, formula, expected) => {
    expect(isBrewKegOf(binPath, formula)).toBe(expected)
  })
})

describe('npmPrefixOfPackage', () => {
  it('reads the prefix that owns a global npm install of the named package', () => {
    expect(npmPrefixOfPackage('/usr/local/lib/node_modules/portless/dist/cli.js', 'portless')).toBe('/usr/local')
  })

  it('misses when the package name differs, so one tool cannot answer for another', () => {
    expect(npmPrefixOfPackage('/usr/local/lib/node_modules/portless/dist/cli.js', 'infra-kit')).toBeNull()
  })

  it('misses a project-local install, which has no `lib` segment', () => {
    expect(npmPrefixOfPackage('/repo/node_modules/portless/dist/cli.js', 'portless')).toBeNull()
  })

  it('cannot be spoofed by nesting, because the inner copy still has no `lib` parent', () => {
    expect(npmPrefixOfPackage('/repo/node_modules/foo/node_modules/portless/cli.js', 'portless')).toBeNull()
  })

  it('reads a root-level prefix as `/` rather than the empty string', () => {
    expect(npmPrefixOfPackage('/lib/node_modules/portless/cli.js', 'portless')).toBe('/')
  })
})

describe('hasSegment', () => {
  it('matches a whole segment only', () => {
    expect(hasSegment('/a/node_modules/b', 'node_modules')).toBe(true)
    expect(hasSegment('/a/node_modules_backup/b', 'node_modules')).toBe(false)
  })
})

describe('isWithin', () => {
  it('is boundary-aware, so a sibling with a shared prefix is not a child', () => {
    expect(isWithin('/Users/x/pnpm', '/Users/x/pnpm/global/5/bin/portless', identity)).toBe(true)
    expect(isWithin('/Users/x/pnpm', '/Users/x/pnpm-ish/bin/portless', identity)).toBe(false)
  })

  it('is not satisfied by a path equal to the parent', () => {
    expect(isWithin('/Users/x/pnpm', '/Users/x/pnpm', identity)).toBe(false)
  })
})
