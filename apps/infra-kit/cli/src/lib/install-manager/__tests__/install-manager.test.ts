import { describe, expect, it, vi } from 'vitest'

import { detectInstallManager, isLocalNodeModulesInstall } from 'src/lib/install-manager'
import type { DetectInstallManagerInput, InstallManagerInfo, RealpathFn } from 'src/lib/install-manager'

const NPM_LATEST = ['npm', 'install', '-g', 'infra-kit@latest']

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
    name: 'homebrew, via our keg in the node-CLI libexec layout',
    selfRealPath: '/opt/homebrew/Cellar/infra-kit/1.2.3/libexec/lib/node_modules/infra-kit/dist/cli.js',
    env: {},
    expected: { manager: 'homebrew', updateCommand: ['brew', 'upgrade', 'infra-kit'], canSelfSpawn: false },
  },
  {
    // Regression: an npm prefix pointed at a NODE keg (`npm config set prefix "$(brew --prefix node)"`,
    // or any keg-only node@X) drops `npm i -g` packages inside someone else's keg. A bare `Cellar`
    // segment test called that homebrew — brew has never heard of this package.
    name: 'npm-global inside the node keg is npm, NOT homebrew — the Cellar segment is not ours',
    selfRealPath: '/opt/homebrew/Cellar/node/26.0.0/lib/node_modules/infra-kit/dist/cli.js',
    env: { HOMEBREW_PREFIX: '/opt/homebrew' },
    lazyNpmRoot: () => {
      return '/opt/homebrew/Cellar/node/26.0.0/lib/node_modules'
    },
    expected: { manager: 'npm', updateCommand: NPM_LATEST, canSelfSpawn: true },
  },
  {
    // Regression: brew-installed node makes $HOMEBREW_PREFIX npm's global prefix, so an `npm i -g`
    // install sits under it while brew knows nothing about it. Reporting `homebrew` here printed
    // `brew upgrade infra-kit` (no such formula) AND left the auto-updater stuck on `cannot-self-spawn`.
    name: 'npm-global under HOMEBREW_PREFIX (brew-installed node) is npm, NOT homebrew',
    selfRealPath: '/opt/homebrew/lib/node_modules/infra-kit/dist/cli.js',
    env: { HOMEBREW_PREFIX: '/opt/homebrew' },
    lazyNpmRoot: () => {
      return '/opt/homebrew/lib/node_modules'
    },
    expected: { manager: 'npm', updateCommand: NPM_LATEST, canSelfSpawn: true },
  },
  {
    // Same layout under linuxbrew — and with no `npm root -g` to fall back on it must degrade to
    // `unknown` (a printed suggestion), never to a brew formula that does not exist.
    name: 'linuxbrew prefix with no npm root -g falls back to unknown, not homebrew',
    selfRealPath: '/home/linuxbrew/.linuxbrew/lib/node_modules/infra-kit/dist/cli.js',
    env: { HOMEBREW_PREFIX: '/home/linuxbrew/.linuxbrew' },
    lazyNpmRoot: () => {
      return undefined
    },
    expected: { manager: 'unknown', updateCommand: NPM_LATEST, canSelfSpawn: false },
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
    name: 'npm, via npm_config_prefix',
    selfRealPath: '/usr/local/lib/node_modules/infra-kit/dist/cli.js',
    env: { npm_config_prefix: '/usr/local' },
    expected: { manager: 'npm', updateCommand: NPM_LATEST, canSelfSpawn: true },
  },
  {
    name: 'npm, via the lazy `npm root -g` fallback',
    selfRealPath: '/usr/local/lib/node_modules/infra-kit/dist/cli.js',
    env: {},
    lazyNpmRoot: () => {
      return '/usr/local/lib/node_modules'
    },
    expected: { manager: 'npm', updateCommand: NPM_LATEST, canSelfSpawn: true },
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
      return '/usr/local/lib/node_modules'
    })

    const info = detectInstallManager({
      selfRealPath: '/usr/local/lib/node_modules/infra-kit/dist/cli.js',
      env: {},
      realpath: identity,
      lazyNpmRoot,
    })

    expect(lazyNpmRoot).toHaveBeenCalledTimes(1)
    expect(info.manager).toBe('npm')
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

  const selfUnderRealRoot = '/real/pfx/lib/node_modules/infra-kit/dist/cli.js'

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
        return '/link/pfx/lib/node_modules'
      },
    })

    expect(info.manager).toBe('npm')
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
