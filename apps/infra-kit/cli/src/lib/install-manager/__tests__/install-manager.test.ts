import { describe, expect, it, vi } from 'vitest'

import { detectInstallManager, formatUpdateCommand, isLocalNodeModulesInstall } from 'src/lib/install-manager'
import type { DetectInstallManagerInput, InstallManagerInfo, RealpathFn } from 'src/lib/install-manager'

const NPM_LATEST = ['npm', 'install', '-g', 'infra-kit@latest']

/** What an npm global install now resolves to: the prefix comes from our own path, so npm cannot miss it. */
const npmAtPrefix = (prefix: string): string[] => {
  return ['npm', 'install', '-g', '--prefix', prefix, 'infra-kit@latest']
}

/**
 * An npm global root WITHOUT the posix `lib` segment (this is the Windows `%APPDATA%\npm` shape). It is
 * the only npm layout the self-path derivation cannot read, so every test that means to exercise the
 * `npm root -g` fallback must use it — a `lib/node_modules` path is settled before the probe is reached.
 */
const NPM_ROOT_NO_LIB = '/Users/x/AppData/Roaming/npm/node_modules'
const SELF_UNDER_NPM_ROOT_NO_LIB = `${NPM_ROOT_NO_LIB}/infra-kit/dist/cli.js`

/** Roots in these cases are already canonical, so canonicalising them is a no-op. */
const identity: RealpathFn = (dir) => {
  return dir
}

interface Case extends Omit<DetectInstallManagerInput, 'realpath'> {
  name: string
  expected: InstallManagerInfo
}

const cases: Case[] = [
  {
    name: 'volta, via its tools segment — volta IS the right tool, so we may run it',
    selfRealPath: '/Users/x/.volta/tools/image/packages/infra-kit/bin/infra-kit',
    env: {},
    expected: { manager: 'volta', updateCommand: ['volta', 'install', 'infra-kit'], canSelfSpawn: true },
  },
  {
    name: 'volta, via VOLTA_HOME',
    selfRealPath: '/opt/volta-home/tools/image/packages/infra-kit/bin/infra-kit',
    env: { VOLTA_HOME: '/opt/volta-home' },
    expected: { manager: 'volta', updateCommand: ['volta', 'install', 'infra-kit'], canSelfSpawn: true },
  },
  {
    name: 'homebrew, via our own keg — suggest only, never spawn',
    selfRealPath: '/opt/homebrew/Cellar/infra-kit/1.2.3/bin/infra-kit',
    env: {},
    expected: { manager: 'homebrew', updateCommand: ['brew', 'upgrade', 'infra-kit'], canSelfSpawn: false },
  },
  {
    // brew's `std_npm_args` layout for a node-CLI formula. It carries a `node_modules` segment INSIDE the
    // keg, so the keg test must not try to exclude one.
    //
    // This is also what pins the matcher ORDER: the keg ends in `lib/node_modules/infra-kit`, so deriving
    // an npm prefix from the path would claim a brew-owned install and run `npm i -g` into the keg. The
    // wrapper matchers must stay ahead of the derivation.
    name: 'homebrew, via our keg in the node-CLI libexec layout',
    selfRealPath: '/opt/homebrew/Cellar/infra-kit/1.2.3/libexec/lib/node_modules/infra-kit/dist/cli.js',
    env: {},
    expected: { manager: 'homebrew', updateCommand: ['brew', 'upgrade', 'infra-kit'], canSelfSpawn: false },
  },
  {
    // Same ordering point for the other wrapper: volta ships node as `image/node/<v>/lib/node_modules`,
    // so `volta install` must win over a derived `npm i -g --prefix`.
    name: 'volta, in the node image layout — the wrapper wins over a derived npm prefix',
    selfRealPath: '/Users/x/.volta/tools/image/node/22.0.0/lib/node_modules/infra-kit/dist/cli.js',
    env: {},
    expected: { manager: 'volta', updateCommand: ['volta', 'install', 'infra-kit'], canSelfSpawn: true },
  },
  {
    // Regression: an npm prefix pointed at a NODE keg (`npm config set prefix "$(brew --prefix node)"`,
    // or any keg-only node@X) drops `npm i -g` packages inside someone else's keg. A bare `Cellar`
    // segment test called that homebrew — brew has never heard of this package.
    name: 'npm-global inside the node keg is npm, NOT homebrew — the Cellar segment is not ours',
    selfRealPath: '/opt/homebrew/Cellar/node/26.0.0/lib/node_modules/infra-kit/dist/cli.js',
    env: { HOMEBREW_PREFIX: '/opt/homebrew' },
    expected: {
      manager: 'npm',
      updateCommand: npmAtPrefix('/opt/homebrew/Cellar/node/26.0.0'),
      canSelfSpawn: true,
    },
  },
  {
    // Regression: brew-installed node makes $HOMEBREW_PREFIX npm's global prefix, so an `npm i -g`
    // install sits under it while brew knows nothing about it. Reporting `homebrew` here printed
    // `brew upgrade infra-kit` (no such formula) AND left the auto-updater stuck on `cannot-self-spawn`.
    name: 'npm-global under HOMEBREW_PREFIX (brew-installed node) is npm, NOT homebrew',
    selfRealPath: '/opt/homebrew/lib/node_modules/infra-kit/dist/cli.js',
    env: { HOMEBREW_PREFIX: '/opt/homebrew' },
    expected: { manager: 'npm', updateCommand: npmAtPrefix('/opt/homebrew'), canSelfSpawn: true },
  },
  {
    // THE reported bug, reproduced: `ik` lives in a prefix whose node is long gone, and the `npm` now
    // first on PATH belongs to a different node manager, so `npm root -g` answers for a tree that does
    // not contain us. Every matcher missed, detection said `unknown`, and the user got the same notice
    // on every command for as long as the install lived. The prefix is right there in our own path.
    name: 'npm-global whose owning npm is no longer on PATH — derived from the path, not from npm root -g',
    selfRealPath: '/opt/homebrew/lib/node_modules/infra-kit/dist/cli.js',
    env: {},
    lazyNpmRoot: () => {
      return '/Users/x/Library/pnpm/nodejs/24.18.0/lib/node_modules'
    },
    expected: { manager: 'npm', updateCommand: npmAtPrefix('/opt/homebrew'), canSelfSpawn: true },
  },
  {
    // Worse than a missed update, and the reason the derivation outranks containment: PNPM_HOME CONTAINS
    // this path, but `pnpm add -g` writes to `<PNPM_HOME>/global/<v>/node_modules` instead. The install
    // reports success, the binary on PATH stays old, and nothing is ever printed.
    name: 'plain npm install under a pnpm-managed node is npm-at-that-prefix, NOT `pnpm add -g`',
    selfRealPath: '/Users/x/Library/pnpm/nodejs/24.18.0/lib/node_modules/infra-kit/dist/cli.js',
    env: { PNPM_HOME: '/Users/x/Library/pnpm' },
    expected: {
      manager: 'npm',
      updateCommand: npmAtPrefix('/Users/x/Library/pnpm/nodejs/24.18.0'),
      canSelfSpawn: true,
    },
  },
  {
    // Same layout under linuxbrew, with no `npm root -g` to fall back on. It used to degrade to `unknown`;
    // the path alone is now enough, and what must NOT happen is a brew formula that does not exist.
    name: 'linuxbrew prefix with no npm root -g is npm-at-that-prefix, not homebrew and not unknown',
    selfRealPath: '/home/linuxbrew/.linuxbrew/lib/node_modules/infra-kit/dist/cli.js',
    env: { HOMEBREW_PREFIX: '/home/linuxbrew/.linuxbrew' },
    lazyNpmRoot: () => {
      return undefined
    },
    expected: { manager: 'npm', updateCommand: npmAtPrefix('/home/linuxbrew/.linuxbrew'), canSelfSpawn: true },
  },
  {
    // nvm/fnm/asdf all install node per version. `npm root -g` answers for the ACTIVE version, so the
    // moment the user switches, the running CLI is outside it and detection used to give up.
    name: 'nvm-style per-version prefix, with npm root -g pointing at a different node version',
    selfRealPath: '/Users/x/.nvm/versions/node/v22.0.0/lib/node_modules/infra-kit/dist/cli.js',
    env: {},
    lazyNpmRoot: () => {
      return '/Users/x/.nvm/versions/node/v24.0.0/lib/node_modules'
    },
    expected: {
      manager: 'npm',
      updateCommand: npmAtPrefix('/Users/x/.nvm/versions/node/v22.0.0'),
      canSelfSpawn: true,
    },
  },
  {
    name: 'pnpm, via PNPM_HOME',
    selfRealPath: '/Users/x/Library/pnpm/global/5/node_modules/infra-kit/dist/cli.js',
    env: { PNPM_HOME: '/Users/x/Library/pnpm' },
    expected: { manager: 'pnpm', updateCommand: ['pnpm', 'add', '-g', 'infra-kit@latest'], canSelfSpawn: true },
  },
  {
    name: 'pnpm, via the global-store path with no env at all',
    selfRealPath: '/Users/x/Library/pnpm/global/5/node_modules/infra-kit/dist/cli.js',
    env: {},
    expected: { manager: 'pnpm', updateCommand: ['pnpm', 'add', '-g', 'infra-kit@latest'], canSelfSpawn: true },
  },
  {
    name: 'bun, via BUN_INSTALL',
    selfRealPath: '/opt/bun/install/global/node_modules/infra-kit/dist/cli.js',
    env: { BUN_INSTALL: '/opt/bun' },
    expected: { manager: 'bun', updateCommand: ['bun', 'add', '-g', 'infra-kit@latest'], canSelfSpawn: true },
  },
  {
    name: 'bun, via the default .bun global install segment',
    selfRealPath: '/Users/x/.bun/install/global/node_modules/infra-kit/dist/cli.js',
    env: {},
    expected: { manager: 'bun', updateCommand: ['bun', 'add', '-g', 'infra-kit@latest'], canSelfSpawn: true },
  },
  {
    name: 'yarn, via its classic global segment',
    selfRealPath: '/Users/x/.config/yarn/global/node_modules/infra-kit/dist/cli.js',
    env: {},
    expected: { manager: 'yarn', updateCommand: ['yarn', 'global', 'add', 'infra-kit@latest'], canSelfSpawn: true },
  },
  {
    // `npm_config_prefix` agrees with the path here, so the answer is the same either way — but it is
    // pinned to the prefix rather than left ambient, which is what protects the install when the env var
    // is absent from the detached update worker.
    name: 'npm, with npm_config_prefix agreeing with the derived prefix',
    selfRealPath: '/usr/local/lib/node_modules/infra-kit/dist/cli.js',
    env: { npm_config_prefix: '/usr/local' },
    expected: { manager: 'npm', updateCommand: npmAtPrefix('/usr/local'), canSelfSpawn: true },
  },
  {
    // The `npm root -g` probe still earns its place for the layout with no `lib` segment.
    name: 'npm, via the lazy `npm root -g` fallback, for a global root with no lib segment',
    selfRealPath: SELF_UNDER_NPM_ROOT_NO_LIB,
    env: {},
    lazyNpmRoot: () => {
      return NPM_ROOT_NO_LIB
    },
    expected: { manager: 'npm', updateCommand: NPM_LATEST, canSelfSpawn: true },
  },
  {
    // A project-local install has a `node_modules` segment but no `lib` parent, so no prefix is derived —
    // a repo's `devDependencies` copy must never be mistaken for a global one to install over.
    name: 'a project-local node_modules install derives no prefix',
    selfRealPath: '/repo/node_modules/infra-kit/dist/cli.js',
    env: {},
    lazyNpmRoot: () => {
      return undefined
    },
    expected: { manager: 'unknown', updateCommand: NPM_LATEST, canSelfSpawn: false },
  },
  {
    // Nesting cannot spoof the layout: the segment before `node_modules` is the parent package, not `lib`.
    name: 'a transitively nested copy derives no prefix',
    selfRealPath: '/usr/local/lib/node_modules/some-tool/node_modules/infra-kit/dist/cli.js',
    env: {},
    lazyNpmRoot: () => {
      return undefined
    },
    expected: { manager: 'unknown', updateCommand: NPM_LATEST, canSelfSpawn: false },
  },
  {
    // A `lib/node_modules` holding a DIFFERENT package tells us nothing about where ours lives.
    name: 'the derivation requires our own package as the immediate child of node_modules',
    selfRealPath: '/usr/local/lib/node_modules/other-tool/bin/infra-kit',
    env: {},
    lazyNpmRoot: () => {
      return undefined
    },
    expected: { manager: 'unknown', updateCommand: NPM_LATEST, canSelfSpawn: false },
  },
  {
    // Degenerate but reachable in a container: the prefix is the filesystem root, not the empty string.
    name: 'a root-level prefix derives `/`, not an empty argument',
    selfRealPath: '/lib/node_modules/infra-kit/dist/cli.js',
    env: {},
    expected: { manager: 'npm', updateCommand: npmAtPrefix('/'), canSelfSpawn: true },
  },
  {
    name: 'unknown when nothing matches and npm root -g is unavailable — suggest, never guess-spawn',
    selfRealPath: '/opt/custom/bin/infra-kit',
    env: {},
    lazyNpmRoot: () => {
      return undefined
    },
    expected: { manager: 'unknown', updateCommand: NPM_LATEST, canSelfSpawn: false },
  },
  {
    name: 'unknown when npm root -g points somewhere else entirely',
    selfRealPath: '/opt/custom/bin/infra-kit',
    env: {},
    lazyNpmRoot: () => {
      return '/usr/local/lib/node_modules'
    },
    expected: { manager: 'unknown', updateCommand: NPM_LATEST, canSelfSpawn: false },
  },
  {
    name: 'a `pnpm-ish` directory is NOT pnpm — containment is segment-wise, not substring-wise',
    selfRealPath: '/opt/pnpm-ish/global/bin/infra-kit',
    env: {},
    expected: { manager: 'unknown', updateCommand: NPM_LATEST, canSelfSpawn: false },
  },
  {
    name: 'PNPM_HOME set but self lives outside it — a sibling prefix must not match',
    selfRealPath: '/Users/x/Library/pnpm-old/bin/infra-kit',
    env: { PNPM_HOME: '/Users/x/Library/pnpm' },
    expected: { manager: 'unknown', updateCommand: NPM_LATEST, canSelfSpawn: false },
  },
]

describe('detectInstallManager', () => {
  it.each(cases)('$name', (testCase) => {
    expect(detectInstallManager({ ...testCase, realpath: identity })).toStrictEqual(testCase.expected)
  })

  it('never invokes lazyNpmRoot when an earlier matcher hits (no subprocess we do not need)', () => {
    const lazyNpmRoot = vi.fn(() => {
      return '/usr/local/lib/node_modules'
    })

    detectInstallManager({
      selfRealPath: '/Users/x/Library/pnpm/global/5/node_modules/infra-kit/dist/cli.js',
      env: { PNPM_HOME: '/Users/x/Library/pnpm' },
      realpath: identity,
      lazyNpmRoot,
    })

    expect(lazyNpmRoot).not.toHaveBeenCalled()
  })

  it('invokes lazyNpmRoot exactly once, only on the fallback path', () => {
    const lazyNpmRoot = vi.fn(() => {
      return NPM_ROOT_NO_LIB
    })

    const info = detectInstallManager({
      selfRealPath: SELF_UNDER_NPM_ROOT_NO_LIB,
      env: {},
      realpath: identity,
      lazyNpmRoot,
    })

    expect(lazyNpmRoot).toHaveBeenCalledTimes(1)
    expect(info.manager).toBe('npm')
  })

  it('never invokes lazyNpmRoot for the standard npm global layout — the path already settles it', () => {
    const lazyNpmRoot = vi.fn(() => {
      return '/somewhere/else/lib/node_modules'
    })

    const info = detectInstallManager({
      selfRealPath: '/usr/local/lib/node_modules/infra-kit/dist/cli.js',
      env: {},
      realpath: identity,
      lazyNpmRoot,
    })

    expect(lazyNpmRoot).not.toHaveBeenCalled()
    expect(info.updateCommand).toStrictEqual(npmAtPrefix('/usr/local'))
  })

  it('tolerates an absent lazyNpmRoot', () => {
    expect(
      detectInstallManager({ selfRealPath: '/opt/custom/bin/infra-kit', env: {}, realpath: identity }).manager,
    ).toBe('unknown')
  })
})

/**
 * `selfRealPath` always arrives with its symlinks followed, so every candidate root must be resolved too or
 * the two sides are never comparable. macOS makes this the common case, not an exotic one: `/var` is a
 * symlink to `/private/var`, so a global install under `/var/...` was reported `unknown` and self-update
 * silently degraded to "run this yourself" for every manager.
 */
describe('root canonicalisation (symlinked prefixes)', () => {
  /** Stands in for macOS resolving `/var` to `/private/var`, the case that exposed this in the wild. */
  const resolveLink: RealpathFn = (dir) => {
    return dir.startsWith('/link/') ? dir.replace('/link/', '/real/') : dir
  }

  /** No `lib` segment, so the derivation stays out and the root comparison is what decides. */
  const selfUnderRealRoot = '/real/pfx/npm/node_modules/infra-kit/dist/cli.js'

  it('matches a PNPM_HOME that is a symlink to the real root', () => {
    const info = detectInstallManager({
      selfRealPath: '/real/pfx/global/5/node_modules/infra-kit/dist/cli.js',
      env: { PNPM_HOME: '/link/pfx' },
      realpath: resolveLink,
    })

    expect(info.manager).toBe('pnpm')
  })

  it('matches an npm_config_prefix that is a symlink to the real root', () => {
    const info = detectInstallManager({
      selfRealPath: selfUnderRealRoot,
      env: { npm_config_prefix: '/link/pfx' },
      realpath: resolveLink,
    })

    expect(info).toStrictEqual({ manager: 'npm', updateCommand: NPM_LATEST, canSelfSpawn: true })
  })

  it('matches a symlinked `npm root -g` on the lazy fallback path', () => {
    const info = detectInstallManager({
      selfRealPath: selfUnderRealRoot,
      env: {},
      realpath: resolveLink,
      lazyNpmRoot: () => {
        return '/link/pfx/npm/node_modules'
      },
    })

    expect(info.manager).toBe('npm')
  })

  /**
   * The derivation needs no canonicalisation at all — it reads the already-resolved `selfRealPath` and
   * never compares it to a candidate root, which is the whole class of mismatch that used to produce
   * `unknown`. Asserting it here keeps that property from being quietly traded away.
   */
  it('derives the prefix from an already-resolved self path without consulting realpath', () => {
    const realpath = vi.fn(identity)

    const info = detectInstallManager({
      selfRealPath: '/real/pfx/lib/node_modules/infra-kit/dist/cli.js',
      env: { npm_config_prefix: '/link/elsewhere' },
      realpath,
    })

    expect(info.updateCommand).toStrictEqual(npmAtPrefix('/real/pfx'))
    expect(realpath).not.toHaveBeenCalled()
  })

  it('still reports unknown when the resolved root genuinely does not contain self', () => {
    const info = detectInstallManager({
      selfRealPath: '/opt/elsewhere/bin/infra-kit',
      env: { npm_config_prefix: '/link/pfx' },
      realpath: resolveLink,
    })

    expect(info).toStrictEqual({ manager: 'unknown', updateCommand: NPM_LATEST, canSelfSpawn: false })
  })
})

describe('formatUpdateCommand', () => {
  it('leaves an ordinary command untouched', () => {
    expect(formatUpdateCommand(NPM_LATEST)).toBe('npm install -g infra-kit@latest')
  })

  /** A prefix path with a space is two arguments once pasted, which silently installs to the wrong place. */
  it('quotes a prefix containing a space so the printed line is runnable as-is', () => {
    expect(formatUpdateCommand(npmAtPrefix('/Users/Ada Lovelace/.nvm/versions/node/v22.0.0'))).toBe(
      "npm install -g --prefix '/Users/Ada Lovelace/.nvm/versions/node/v22.0.0' infra-kit@latest",
    )
  })
})

describe('isLocalNodeModulesInstall', () => {
  it('is true for a project-local install under the cwd', () => {
    expect(isLocalNodeModulesInstall('/repo/node_modules/infra-kit/dist/cli.js', '/repo', identity)).toBe(true)
  })

  it('is false for a global pnpm root — it also contains a node_modules segment, only the cwd separates them', () => {
    const globalRoot = '/Users/x/Library/pnpm/global/5/node_modules/infra-kit/dist/cli.js'

    expect(isLocalNodeModulesInstall(globalRoot, '/repo', identity)).toBe(false)
  })

  it('is false for a workspace symlink whose realpath escapes node_modules entirely', () => {
    expect(isLocalNodeModulesInstall('/repo/apps/infra-kit/cli/dist/cli.js', '/repo', identity)).toBe(false)
  })

  it('is false for a `node_modules_backup` segment — substring matching would wrongly fire here', () => {
    expect(isLocalNodeModulesInstall('/repo/node_modules_backup/infra-kit/dist/cli.js', '/repo', identity)).toBe(false)
  })

  it('fires for a symlinked cwd — the advisory must not go silent just because cwd is unresolved', () => {
    const resolveLink: RealpathFn = (dir) => {
      return dir.startsWith('/link/') ? dir.replace('/link/', '/real/') : dir
    }

    expect(isLocalNodeModulesInstall('/real/repo/node_modules/infra-kit/dist/cli.js', '/link/repo', resolveLink)).toBe(
      true,
    )
  })
})
