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
 * Ordered, first-hit-wins. Order matters: volta and homebrew wrap an npm-shaped layout, so they must be
 * consulted before the generic npm prefix matcher would claim them.
 */
const MATCHERS: Matcher[] = [
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
 * `lazyNpmRoot` is the fallback probe and is invoked at most once, only after every env/path matcher has
 * missed — a global `npm root -g` subprocess is never paid for a pnpm or volta install. When nothing
 * matches we report `unknown` with an npm command that is a *suggestion only* (`canSelfSpawn: false`):
 * running a guessed global install is worse than printing one.
 *
 * @example
 * detectInstallManager({ selfRealPath: '/Users/x/Library/pnpm/global/5/node_modules/infra-kit/dist/cli.js', env: {} })
 * // => { manager: 'pnpm', updateCommand: ['pnpm', 'add', '-g', 'infra-kit@latest'], canSelfSpawn: true }
 */
export const detectInstallManager = (input: DetectInstallManagerInput): InstallManagerInfo => {
  const { selfRealPath, env, realpath, lazyNpmRoot } = input
  const hit = MATCHERS.find(({ test }) => {
    return test({ selfRealPath, env, realpath })
  })

  if (hit) return { manager: hit.manager, updateCommand: hit.updateCommand, canSelfSpawn: hit.canSelfSpawn }

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
