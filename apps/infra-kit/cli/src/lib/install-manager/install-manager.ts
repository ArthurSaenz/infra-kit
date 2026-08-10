/**
 * Pure detection of *how* this CLI was installed, so a self-update advisory can name the one command
 * that will actually work. No fs, no spawn, no `process.env` read — every input is injected, which is
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
}

/**
 * Is `child` inside the `parent` subtree? Boundary-aware: a naive `startsWith` would call
 * `/Users/x/pnpm-ish` a child of `/Users/x/pnpm`. `parent` is canonicalised first because it arrives raw
 * from the environment while `child` is already a realpath.
 */
const isWithin = (parent: string, child: string, realpath: RealpathFn): boolean => {
  const rel = path.relative(realpath(path.resolve(parent)), path.resolve(child))

  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Does `p` contain `name` as a whole path SEGMENT? `/a/node_modules_backup/b` must not match `node_modules`. */
const hasSegment = (p: string, name: string): boolean => {
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
const isBrewKegOf = (p: string, name: string): boolean => {
  const segments = path.resolve(p).split(path.sep)
  const cellar = segments.indexOf('Cellar')

  return cellar !== -1 && segments[cellar + 1] === name
}

/**
 * The npm global prefix that owns `selfRealPath`, derived from the path ITSELF, or null when the layout is
 * not an npm global one.
 *
 * This is the one signal that cannot point at the wrong tree. Everything else in this module answers
 * "is this file somewhere inside tool X's directory?", and containment is not ownership:
 *   - `npm root -g` answers for whichever `npm` is first on PATH, which is routinely a DIFFERENT node than
 *     the one that installed us (a pnpm/nvm/fnm-managed node, or a node that has since been removed). It
 *     then reports a root that does not contain us, every matcher misses, and detection degrades to
 *     `unknown` — a notice printed forever, on the single most common install method. That is the bug this
 *     exists to close.
 *   - `PNPM_HOME` containment is satisfied by `<PNPM_HOME>/nodejs/<v>/lib/node_modules/<pkg>` (a plain
 *     `npm i -g` under a pnpm-managed node), yet `pnpm add -g` installs to `<PNPM_HOME>/global/<v>/...` —
 *     a different directory. That one is worse than a missed update: the install "succeeds" while the
 *     binary on PATH stays old, silently, with no notice to show for it.
 *
 * `<prefix>/lib/node_modules/<PACKAGE_NAME>` is npm's global layout and no other manager's, so requiring
 * BOTH the `lib` parent and our package as the immediate child is what makes it proof rather than a hint.
 * The `lib` requirement is also what keeps a project-local `<repo>/node_modules/<pkg>` out (it has no
 * `lib`), and nesting cannot spoof it: `.../node_modules/foo/node_modules/<pkg>` fails the `lib` test.
 *
 * Windows global npm has no `lib` segment (`%APPDATA%\npm\node_modules`), so this returns null there and
 * detection falls through to `npm root -g` — which is correct on Windows, where there is normally one npm.
 */
const npmPrefixFromSelfPath = (selfRealPath: string): string | null => {
  const segments = path.resolve(selfRealPath).split(path.sep)
  const nodeModules = segments.lastIndexOf('node_modules')

  if (nodeModules < 2) return null
  if (segments[nodeModules - 1] !== 'lib') return null
  if (segments[nodeModules + 1] !== PACKAGE_NAME) return null

  // Drop `lib/node_modules/...`; the empty result of a root-level prefix (`/lib/node_modules/...`) is `/`.
  return segments.slice(0, nodeModules - 1).join(path.sep) || path.sep
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
    // Our own keg is the ONLY sound signal — see {@link isBrewKegOf}. Two broader tests look plausible
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
 */
export const detectInstallManager = (input: DetectInstallManagerInput): InstallManagerInfo => {
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
