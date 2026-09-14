/**
 * Pure detection of *how* this CLI was installed, so the background updater knows whether it may act at
 * all, and the advisory it prints can name the one command that will actually work. No fs, no spawn, no `process.env` read — every input is injected, which is
 * what lets the whole matrix be table-tested.
 *
 * Detection is env-first and LAZY: the only signal that costs a subprocess (`npm root -g`) is passed in
 * as `lazyNpmRoot` and consulted solely when every cheaper matcher has missed.
 */
import path from 'node:path'

/** The published package this CLI updates itself to. Single source for every suggested argv. */
export const PACKAGE_NAME = 'infra-kit'

const LATEST = `${PACKAGE_NAME}@latest`

export type InstallManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'volta' | 'homebrew' | 'unknown'

export interface InstallManagerInfo {
  manager: InstallManager
  /** The command to run. Only safe to spawn ourselves when `canSelfSpawn`; otherwise print it. */
  updateCommand: string[]
  /** False when we must not run the command for the user — either it needs sudo/a tap, or we guessed. */
  canSelfSpawn: boolean
}

/**
 * Canonicalises a candidate *root* directory. Required, not optional: `selfRealPath` has already had its
 * symlinks followed, so comparing it against a raw `PNPM_HOME`/`npm root -g`/`cwd` compares a resolved
 * path to an unresolved one and silently never matches. macOS is the everyday proof — `/var` is a symlink
 * to `/private/var`, so a global install under `/var/...` reports `unknown` unless both sides are resolved.
 * Callers inject the real thing; tests inject a stub.
 */
export type RealpathFn = (dir: string) => string

export interface DetectInstallManagerInput {
  /** Fully-resolved (symlinks followed) path to this CLI's entry file. */
  selfRealPath: string
  env: NodeJS.ProcessEnv
  /** Canonicalises each candidate root before comparison. See {@link RealpathFn}. */
  realpath: RealpathFn
  /** `npm root -g`, deferred: invoked at most once, and only when no cheaper matcher hit. */
  lazyNpmRoot?: () => string | undefined
  /**
   * The exact version to install, when the caller has already resolved it. Omitted, the command targets
   * the `latest` dist-tag — fine to PRINT, unsafe to RUN: see {@link pinSpec}.
   */
  version?: string
}

/**
 * Swap the `@latest` token for `@<version>`.
 *
 * `pnpm add -g infra-kit@latest` resolves the tag from pnpm's on-disk metadata cache and does not
 * revalidate it when a cached version already satisfies the tag (pnpm 12.3.4, measured: two runs 90+
 * minutes after a publish both reinstalled the stale `latest` while `pnpm view` already reported the new
 * one). The updater had fetched the real latest itself moments earlier, ran the tag command, got exit 0
 * — nothing was reinstalled — and recorded `installed`, so the stale binary looked up to date until the
 * next cycle repeated the same no-op. A concrete version the cache has never seen forces the fetch.
 */
const pinSpec = (command: string[], version: string | undefined): string[] => {
  if (version === undefined) return command

  return command.map((token) => {
    return token === LATEST ? `${PACKAGE_NAME}@${version}` : token
  })
}

/**
 * Is `child` inside the `parent` subtree? Boundary-aware: a naive `startsWith` would call
 * `/Users/x/pnpm-ish` a child of `/Users/x/pnpm`. `parent` is canonicalised first because it arrives raw
 * from the environment while `child` is already a realpath.
 */
export const isWithin = (parent: string, child: string, realpath: RealpathFn): boolean => {
  const rel = path.relative(realpath(path.resolve(parent)), path.resolve(child))

  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Does `p` contain `name` as a whole path SEGMENT? `/a/node_modules_backup/b` must not match `node_modules`. */
export const hasSegment = (p: string, name: string): boolean => {
  return path.resolve(p).split(path.sep).includes(name)
}

/**
 * Is `p` inside a Homebrew keg belonging to the `name` FORMULA — i.e. `.../Cellar/<name>/<version>/...`?
 *
 * The formula name is what makes this sound. A bare `Cellar` segment says only "somewhere under a keg",
 * and the keg it lands in is routinely someone else's: when npm's global prefix is a node keg
 * (`npm config set prefix "$(brew --prefix node)"`, or any keg-only `node@X`), an `npm i -g` package
 * installs to `Cellar/node/<v>/lib/node_modules/<pkg>/...` — brew has never heard of it, yet the segment
 * is right there. Requiring `<name>` to sit directly after `Cellar` is what separates "brew installed
 * THIS" from "brew installed the runtime that installed this".
 *
 * Works for both keg layouts, since each is rooted at the formula: a plain formula
 * (`Cellar/infra-kit/1.2.3/bin/infra-kit`) and brew's node-CLI layout
 * (`Cellar/infra-kit/1.2.3/libexec/lib/node_modules/infra-kit/dist/cli.js`). Do NOT try to tell them
 * apart by excluding `node_modules` — the second one contains it.
 */
export const isBrewKegOf = (p: string, name: string): boolean => {
  const segments = path.resolve(p).split(path.sep)
  const cellar = segments.indexOf('Cellar')

  return cellar !== -1 && segments[cellar + 1] === name
}

/**
 * The npm global prefix that owns `binRealPath`, derived from the path ITSELF, or null when the
 * layout is not an npm global one.
 *
 * Matches `<prefix>/lib/node_modules/<packageName>` — npm's global layout and no other manager's
 * — requiring BOTH the `lib` parent and our package as the immediate child. Windows global npm has
 * no `lib` segment (`%APPDATA%\npm\node_modules`), so this returns null there and detection falls
 * through to `npm root -g`, which is correct on Windows, where there is normally one npm.
 */
// This is the one signal that cannot point at the wrong tree. Everything else in this module
// answers "is this file somewhere inside tool X's directory?", and containment is not ownership:
//   - `npm root -g` answers for whichever `npm` is first on PATH, which is routinely a DIFFERENT
//     node than the one that installed us (a pnpm/nvm/fnm-managed node, or a node that has since
//     been removed). It then reports a root that does not contain us, every matcher misses, and
//     detection degrades to `unknown` — a notice printed forever, on the single most common install
//     method. That is the bug this exists to close.
//   - `PNPM_HOME` containment is satisfied by `<PNPM_HOME>/nodejs/<v>/lib/node_modules/<pkg>` (a
//     plain `npm i -g` under a pnpm-managed node), yet `pnpm add -g` installs to
//     `<PNPM_HOME>/global/<v>/...` — a different directory. That one is worse than a missed update:
//     the install "succeeds" while the binary on PATH stays old, silently, with no notice to show
//     for it.
//
// Requiring both segments is what makes the match proof rather than a hint. The `lib` requirement
// is also what keeps a project-local `<repo>/node_modules/<pkg>` out (it has no `lib`), and nesting
// cannot spoof it: `.../node_modules/foo/node_modules/<pkg>` fails the `lib` test.
export const npmPrefixOfPackage = (binRealPath: string, packageName: string): string | null => {
  const segments = path.resolve(binRealPath).split(path.sep)
  const nodeModules = segments.lastIndexOf('node_modules')

  if (nodeModules < 2) return null
  if (segments[nodeModules - 1] !== 'lib') return null
  if (segments[nodeModules + 1] !== packageName) return null

  // Drop `lib/node_modules/...`; the empty result of a root-level prefix (`/lib/node_modules/...`) is `/`.
  return segments.slice(0, nodeModules - 1).join(path.sep) || path.sep
}

// The self-scoped reading, kept as the name every call site below already uses. `dependency-registry`
// asks the same question about OTHER packages (`portless`), which is why the body moved up one level
// rather than gaining a defaulted parameter — a default is how the wrong package silently gets probed.
const npmPrefixFromSelfPath = (selfRealPath: string): string | null => {
  return npmPrefixOfPackage(selfRealPath, PACKAGE_NAME)
}

/**
 * `--prefix` is passed EXPLICITLY rather than trusting the ambient one: the whole point of deriving it is
 * that the `npm` we are about to run may default to a different prefix than the one we are installed in.
 * A command-line flag outranks both `npm_config_prefix` and any `.npmrc`, so this targets the tree we
 * actually run from. With `-g`, npm writes `<prefix>/lib/node_modules` and links bins into `<prefix>/bin`.
 */
const npmPrefixInstallCommand = (prefix: string): string[] => {
  return ['npm', 'install', '-g', '--prefix', prefix, LATEST]
}

/**
 * Render argv as a line the user can paste into a shell.
 *
 * A plain `join(' ')` was fine while every token came from a static table; `--prefix <path>` puts a
 * filesystem path in argv, and `/Users/Ada Lovelace/.nvm/...` pasted unquoted is two arguments and a
 * failed install. Single quotes are sound here without escaping because the callers' validation rejects a
 * token containing a quote — see `SAFE_COMMAND_TOKEN` in src/lib/update-check/auto-update.ts.
 *
 * @example
 * formatUpdateCommand(['npm', 'install', '-g', '--prefix', '/opt/x y', 'infra-kit@latest'])
 * // => "npm install -g --prefix '/opt/x y' infra-kit@latest"
 */
export const formatUpdateCommand = (command: string[]): string => {
  return command
    .map((token) => {
      return token.includes(' ') ? `'${token}'` : token
    })
    .join(' ')
}

/** `env[key]` names a directory that contains `selfRealPath`. Absent/empty env var → no match. */
const underEnvDir = (env: NodeJS.ProcessEnv, key: string, selfRealPath: string, realpath: RealpathFn): boolean => {
  const dir = env[key]

  return dir != null && dir !== '' && isWithin(dir, selfRealPath, realpath)
}

interface Matcher extends Omit<InstallManagerInfo, 'manager'> {
  manager: InstallManager
  test: (input: Required<Pick<DetectInstallManagerInput, 'selfRealPath' | 'env' | 'realpath'>>) => boolean
}

/**
 * Consulted FIRST, before {@link npmPrefixFromSelfPath}. Both of these legitimately wrap an npm-shaped
 * `lib/node_modules` tree — volta at `~/.volta/tools/image/node/<v>/lib/node_modules`, brew at
 * `Cellar/<pkg>/<v>/libexec/lib/node_modules` — so deriving an npm prefix from the path would hijack
 * installs that a wrapper owns and must keep owning.
 */
const WRAPPER_MATCHERS: Matcher[] = [
  {
    manager: 'volta',
    // volta owns the shim; `volta install` is the correct tool, not a workaround — so we may run it.
    test: ({ selfRealPath, env, realpath }) => {
      return (
        underEnvDir(env, 'VOLTA_HOME', selfRealPath, realpath) ||
        hasSegment(selfRealPath, '.volta') ||
        hasSegment(selfRealPath, 'volta')
      )
    },
    updateCommand: ['volta', 'install', PACKAGE_NAME],
    canSelfSpawn: true,
  },
  {
    manager: 'homebrew',
    // `brew upgrade` can touch the prefix, relink, and prompt — never ours to run unattended.
    //
    // Our own keg is the ONLY sound signal — see `isBrewKegOf`. Two broader tests look plausible
    // and are both wrong, because each answers "did brew put something here?" when the question is "does
    // brew own THIS package?":
    //   - `HOMEBREW_PREFIX` containment: when node comes from brew, npm's global prefix IS
    //     $HOMEBREW_PREFIX, so EVERY `npm i -g` package lands under it, unknown to brew.
    //   - a bare `Cellar` segment: an npm prefix pointed at a node keg puts packages inside that keg.
    // Either misfire tells macOS users to run `brew upgrade infra-kit` — a formula that does not exist —
    // and, far worse, makes the background auto-updater bail with `cannot-self-spawn` forever, so the
    // very fix for it can never reach them. Detection runs on the realpath, and a linked brew bin always
    // resolves into its own keg, so the narrow test has no false negatives to trade for this.
    test: ({ selfRealPath }) => {
      return isBrewKegOf(selfRealPath, PACKAGE_NAME)
    },
    updateCommand: ['brew', 'upgrade', PACKAGE_NAME],
    canSelfSpawn: false,
  },
]

/**
 * Consulted LAST, after {@link npmPrefixFromSelfPath} has had its say. Each of these proves only that we
 * live somewhere inside a tool's directory tree, which is weaker than knowing the layout npm itself
 * created — see the `PNPM_HOME`/`nodejs` case in that helper's doc for a containment hit whose install
 * command targets the wrong directory.
 */
const TREE_MATCHERS: Matcher[] = [
  {
    manager: 'pnpm',
    test: ({ selfRealPath, env, realpath }) => {
      return (
        underEnvDir(env, 'PNPM_HOME', selfRealPath, realpath) ||
        (hasSegment(selfRealPath, 'pnpm') && hasSegment(selfRealPath, 'global'))
      )
    },
    updateCommand: ['pnpm', 'add', '-g', LATEST],
    canSelfSpawn: true,
  },
  {
    manager: 'bun',
    test: ({ selfRealPath, env, realpath }) => {
      return underEnvDir(env, 'BUN_INSTALL', selfRealPath, realpath) || hasSegment(selfRealPath, '.bun')
    },
    updateCommand: ['bun', 'add', '-g', LATEST],
    canSelfSpawn: true,
  },
  {
    manager: 'yarn',
    test: ({ selfRealPath }) => {
      return (
        hasSegment(selfRealPath, '.yarn') || (hasSegment(selfRealPath, 'yarn') && hasSegment(selfRealPath, 'global'))
      )
    },
    updateCommand: ['yarn', 'global', 'add', LATEST],
    canSelfSpawn: true,
  },
  {
    manager: 'npm',
    test: ({ selfRealPath, env, realpath }) => {
      return underEnvDir(env, 'npm_config_prefix', selfRealPath, realpath)
    },
    updateCommand: ['npm', 'install', '-g', LATEST],
    canSelfSpawn: true,
  },
]

const NPM_UPDATE_COMMAND = ['npm', 'install', '-g', LATEST]

/**
 * The command to print when nobody has identified this CLI's package manager — the same guess
 * `detectInstallManager` records for an unrecognised location, pinned to `version`. For a caller that
 * must name a command but has no worker verdict to read (no update cache on an opt-out machine).
 *
 * @example
 * fallbackUpdateCommand('0.8.0') // => ['npm', 'install', '-g', 'infra-kit@0.8.0']
 */
export const fallbackUpdateCommand = (version: string): string[] => {
  return pinSpec(NPM_UPDATE_COMMAND, version)
}

/**
 * Identify the package manager that owns `selfRealPath`.
 *
 * Order, and why it is this one: wrappers that own an npm-shaped tree (volta, brew) first, then the npm
 * prefix DERIVED from our own path, then the env/path containment matchers, then the `npm root -g` probe.
 * The derived prefix sits above containment because it is the only signal that cannot name a directory we
 * do not live in — see {@link npmPrefixFromSelfPath}.
 *
 * `lazyNpmRoot` is the last resort and is invoked at most once, only after every matcher has missed — a
 * pnpm or volta install never pays for the subprocess, and neither does any npm global install in the
 * standard layout, which the derived prefix now settles for free. When nothing matches we report `unknown`
 * with an npm command that is a *suggestion only* (`canSelfSpawn: false`): running a guessed global
 * install is worse than printing one.
 *
 * @example
 * detectInstallManager({ selfRealPath: '/Users/x/Library/pnpm/global/5/node_modules/infra-kit/dist/cli.js', env: {} })
 * // => { manager: 'pnpm', updateCommand: ['pnpm', 'add', '-g', 'infra-kit@latest'], canSelfSpawn: true }
 * detectInstallManager({ selfRealPath: '/Users/x/Library/pnpm/global/5/node_modules/infra-kit/dist/cli.js', env: {}, version: '0.5.5' })
 * // => { manager: 'pnpm', updateCommand: ['pnpm', 'add', '-g', 'infra-kit@0.5.5'], canSelfSpawn: true }
 */
export const detectInstallManager = (input: DetectInstallManagerInput): InstallManagerInfo => {
  const { selfRealPath, env, realpath, lazyNpmRoot, version } = input
  const detected = detectUnpinned({ selfRealPath, env, realpath, lazyNpmRoot })

  return { ...detected, updateCommand: pinSpec(detected.updateCommand, version) }
}

const detectUnpinned = (input: DetectInstallManagerInput): InstallManagerInfo => {
  const { selfRealPath, env, realpath, lazyNpmRoot } = input
  const toInfo = (hit: Matcher): InstallManagerInfo => {
    return { manager: hit.manager, updateCommand: hit.updateCommand, canSelfSpawn: hit.canSelfSpawn }
  }
  const matches = ({ test }: Matcher): boolean => {
    return test({ selfRealPath, env, realpath })
  }

  const wrapper = WRAPPER_MATCHERS.find(matches)

  if (wrapper) return toInfo(wrapper)

  const derivedPrefix = npmPrefixFromSelfPath(selfRealPath)

  if (derivedPrefix !== null) {
    return { manager: 'npm', updateCommand: npmPrefixInstallCommand(derivedPrefix), canSelfSpawn: true }
  }

  const tree = TREE_MATCHERS.find(matches)

  if (tree) return toInfo(tree)

  const npmRoot = lazyNpmRoot?.()

  if (npmRoot != null && npmRoot !== '' && isWithin(npmRoot, selfRealPath, realpath)) {
    return { manager: 'npm', updateCommand: NPM_UPDATE_COMMAND, canSelfSpawn: true }
  }

  return { manager: 'unknown', updateCommand: NPM_UPDATE_COMMAND, canSelfSpawn: false }
}

/**
 * Is this CLI running from a *project-local* `node_modules` (as opposed to a global root)?
 *
 * The cwd clause is what does the distinguishing — BOTH a project install and a global root contain a
 * `/node_modules/` segment (`pnpm root -g` is `~/Library/pnpm/global/5/node_modules`). Without it we
 * would nag every global pnpm user to stop using a local install they do not have.
 *
 * Accepted false-negative: invoked from a subdirectory (cwd `project/apps/x`, deps at
 * `project/node_modules`) this returns false and the advisory stays silent. Under-warning is the safe
 * direction for a best-effort, never-throwing advisory — do not "fix" it by dropping the cwd clause.
 *
 * `cwd` is canonicalised before comparison for the same reason `detectInstallManager` canonicalises its
 * roots: `selfRealPath` is a realpath, and comparing it to an unresolved cwd never matches.
 *
 * @example
 * isLocalNodeModulesInstall('/repo/node_modules/infra-kit/dist/cli.js', '/repo', (p) => p) // => true
 */
export const isLocalNodeModulesInstall = (selfRealPath: string, cwd: string, realpath: RealpathFn): boolean => {
  return hasSegment(selfRealPath, 'node_modules') && isWithin(cwd, selfRealPath, realpath)
}

/** Does this path exist at all — directory, file, or symlink? Injected so the walk never touches the real disk in tests. */
export type ExistsFn = (p: string) => boolean

export interface IsGlobalInstallInput {
  /** Fully-resolved (symlinks followed) path to this CLI's entry file. */
  selfRealPath: string
  env: NodeJS.ProcessEnv
  /** Canonicalises `home` and every root {@link detectInstallManager} compares against. */
  realpath: RealpathFn
  /** The user's home directory (`os.homedir()`), raw — canonicalised here before the walk compares it. */
  home: string
  exists: ExistsFn
}

/** Upper bound on the `.git` walk: deeper than any real install layout, so it only ever guards against a pathological path. */
const GIT_WALK_MAX_HOPS = 32

/**
 * Where the `.git` walk starts: the parent of the OUTERMOST `node_modules` segment (`indexOf`, not
 * `lastIndexOf` — pnpm's `.pnpm/<pkg>@<v>/node_modules/<pkg>` nests two, and the checkout that owns the
 * tree sits above the first). A self path with no `node_modules` at all (a plain brew keg's `bin/`) starts
 * at its own directory, so the walk still inspects every ancestor.
 */
const gitWalkStart = (selfRealPath: string): string => {
  const segments = path.resolve(selfRealPath).split(path.sep)
  const outermost = segments.indexOf('node_modules')

  if (outermost === -1) return path.dirname(selfRealPath)

  return segments.slice(0, outermost).join(path.sep) || path.sep
}

/** `start` and its ancestors up to but EXCLUDING `homeReal`, bounded — the directories the `.git` walk may inspect. */
const ancestorsBelowHome = (start: string, homeReal: string): string[] => {
  const dirs: string[] = []
  let dir = start

  while (dir !== homeReal && dirs.length < GIT_WALK_MAX_HOPS) {
    dirs.push(dir)

    const parent = path.dirname(dir)

    if (parent === dir) break

    dir = parent
  }

  return dirs
}

const hasGitAncestor = (start: string, homeReal: string, exists: ExistsFn): boolean => {
  return ancestorsBelowHome(start, homeReal).some((dir) => {
    return exists(path.join(dir, '.git'))
  })
}

/**
 * Is this CLI the machine's *global* install — the one a root-owned daemon or a system-wide link may be
 * aimed at — as opposed to a checkout or a project-local dependency? Probe-free: fs + env only, never a
 * subprocess, because it runs on every boot.
 *
 * True iff {@link detectInstallManager} names a manager AND no `.git` entry (directory or file — a
 * worktree's is a file) exists above the outermost `node_modules`, walking up to but EXCLUDING
 * `realpath(home)`. Never throws: any seam failure reports false, the safe direction for every caller.
 *
 * @example
 * isGlobalInstall({
 *   selfRealPath: '/Users/x/Library/pnpm/global/v11/8a83-1/node_modules/.pnpm/infra-kit@0.5.6/node_modules/infra-kit/dist/cli.js',
 *   env: { PNPM_HOME: '/Users/x/Library/pnpm' },
 *   realpath: (p) => p,
 *   home: '/Users/x',
 *   exists: (p) => p === '/Users/x/.git',
 * }) // => true — the only `.git` is $HOME's own, which the walk never inspects
 */
// Why these two predicates and not the obvious candidates:
//   - Not `canSelfSpawn`: that flag encodes "may I run an unattended `npm i -g`", and homebrew is
//     `canSelfSpawn: false` while being unmistakably global — gating on it would leave a brew install
//     unconverged forever. A global install whose manager cannot be identified in a stripped env (no
//     `PNPM_HOME`, no derivable prefix) reports false: fail-safe, since a skipped write is never wrong and
//     the next shell-run command converges it.
//   - Not `isLocalNodeModulesInstall`: its cwd clause calls every global layout under `$HOME` "local" the
//     moment cwd is `$HOME` — which is exactly the cwd the background updater spawns with, and a plain
//     `cd ~ && infra-kit version` reproduces it. This predicate reads the tree, not the cwd.
//   - Why the `.git` walk at all: the cheap matchers are segment heuristics that also fire on
//     project-local shapes — a repo with a `volta` path segment, Yarn Berry's `.yarn/unplugged/…`, a
//     checkout cloned under `$PNPM_HOME`, a workspace package literally named `lib` — and every one of
//     those is a checkout; every checkout has a `.git`, no global root does.
//   - Why `$HOME` is excluded: dotfiles users `git init ~`, and a `~/.git` would refuse the pnpm-global
//     install permanently. Every checkout under `$HOME` (`~/repo/.git`) is still strictly below it.
//   - Why `.git` ONLY, not `pnpm-workspace.yaml`: pnpm 12 writes one INSIDE the global install dir, so
//     that marker would refuse the very install this is for.
export const isGlobalInstall = (input: IsGlobalInstallInput): boolean => {
  try {
    const { selfRealPath, env, realpath, home, exists } = input

    if (detectInstallManager({ selfRealPath, env, realpath }).manager === 'unknown') return false

    return !hasGitAncestor(gitWalkStart(selfRealPath), realpath(path.resolve(home)), exists)
  } catch {
    return false
  }
}

/**
 * The advisory gate for `warnIfLocalInstall`, pulled out so it is testable without spawning the CLI.
 * Warn only when the install is provably NOT global AND looks project-local: the second clause alone
 * fires on a global pnpm root whenever cwd is `$HOME` (see {@link isGlobalInstall}).
 */
export const shouldWarnLocalInstall = (input: IsGlobalInstallInput & { cwd: string }): boolean => {
  const { selfRealPath, cwd, realpath } = input

  return !isGlobalInstall(input) && isLocalNodeModulesInstall(selfRealPath, cwd, realpath)
}
