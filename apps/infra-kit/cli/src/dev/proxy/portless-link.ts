/**
 * @fileoverview
 *
 * `~/.infra-kit/portless` — a stable symlink to the portless PACKAGE directory bundled with the running
 * infra-kit, kept pointing at the current install by every process boot.
 *
 * Why it exists: `portless service install` bakes `process.execPath` and `process.argv[1]` verbatim into
 * the root launchd plist (`ProgramArguments`), and it offers no `--entry` flag to say otherwise. Under
 * pnpm 12 the script half of that pair is version-unstable — every `pnpm add -g infra-kit@x` mints a
 * fresh `global/v11/{pid}-{timestamp}/` project and removes the previous one, and the path also embeds
 * `infra-kit@<version>`. With silent auto-update on, the daemon's argv dangles after every release,
 * launchd cannot start it at the next boot, and the "fix" is another sudo. Node does NOT realpath
 * `argv[1]` (it keeps whatever string it was given) but DOES realpath `execPath`, so only the script half
 * can be made stable: point the plist at `<link>/dist/cli.js` and keep the link current.
 *
 * Why tmp + rename, never unlink first: `rename(2)` replaces a symlink atomically, so there is no
 * instant at which the path is absent. An unlink-then-symlink sequence has one — and a reboot inside it
 * leaves launchd with no script at all; `KeepAlive` retries the same dangling path forever, and `:443`
 * stays dark until a human runs `service install` again.
 *
 * Why the boot call must run on `version --json`: that is the exact invocation the background updater
 * spawns to verify a fresh install (`run-update-check.ts`, `readInstalledVersion`: `cwd = homedir()`,
 * `--json`, piped stdio). It is the FIRST process the new binary ever runs — and the one that re-points
 * the link after an auto-update, before any shell command does. So `bootPortlessLink` must not sit
 * behind `warnIfLocalInstall`'s `--json` guard, and it must not have an env opt-out: the link is state,
 * not advisory output.
 *
 * Every write is guarded by `isGlobalInstall`: a checkout or a project-local dependency never aims the
 * root daemon at itself (that would dangle the moment the worktree is removed). Nothing here spawns a
 * subprocess, touches stdout, or throws — the `ik-mcp` proxy calls it at boot with stdout carrying the
 * JSON-RPC transport, and the CLI calls it before Commander parses argv.
 */
import fs from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { USER_CONFIG_DIR_NAME } from 'src/lib/constants'
import { isGlobalInstall, safeRealpath } from 'src/lib/install-manager'

import { formatPortlessCommand, resolvePortlessBin } from './portless-driver'
import type { ExistsCheck } from './portless-driver'

/** `<home>/.infra-kit/portless` — the link path; the same `home` seam the rest of the config layer uses. */
export const portlessLinkPath = (home: string): string => {
  return join(home, USER_CONFIG_DIR_NAME, 'portless')
}

/**
 * `<link>/dist/cli.js` when the link resolves to a portless with that file, else `null` — the path the
 * printed `service install` command (and the plist it writes) should carry. `exists` follows the
 * symlink, so a dangling link answers `null` and callers fall back to the real path.
 */
export const portlessLinkCliPath = (
  home: string,
  exists: (target: string) => boolean = fs.existsSync,
): string | null => {
  const cliPath = join(portlessLinkPath(home), 'dist', 'cli.js')

  return exists(cliPath) ? cliPath : null
}

/** Where the link is looked up and which node to print; every seam is injectable so tests never read a real `~/.infra-kit`. */
export interface ServiceInstallSeams {
  home: string
  exists?: ExistsCheck
  execPath?: string
}

/**
 * The one-time, out-of-band, ROOT command that installs the `:443` daemon. infra-kit never runs it — it
 * only ever prints it (principle 3: infra-kit probes and prints, it never elevates). `doctor`, `setup`
 * and `dev` all print it from here so no two surfaces can disagree about the path that ends up as root.
 *
 * Rendered THROUGH `~/.infra-kit/portless/dist/cli.js` whenever that link resolves: portless bakes the
 * script path it was invoked with into the plist, so the command printed here decides whether the root
 * daemon survives the next `pnpm add -g infra-kit` (the link is re-pointed on every boot; the version-
 * specific path is deleted). `bin` — the resolved `dist/cli.js`, never a bare `portless` (see
 * {@link formatPortlessCommand}) — is the fallback only, for a machine where nothing has created the
 * link yet.
 */
export const serviceInstallCommand = (bin: string, seams: ServiceInstallSeams): string => {
  return formatPortlessCommand(['service', 'install'], {
    sudo: true,
    bin: portlessLinkCliPath(seams.home, seams.exists) ?? bin,
    execPath: seams.execPath,
  })
}

export type PortlessLinkOutcome =
  'created' | 'repointed' | 'unchanged' | 'skipped-local' | 'skipped-unresolved' | 'failed'

export interface PortlessLinkResult {
  outcome: PortlessLinkOutcome
  /** The portless package dir the link should point at; `null` only for `'skipped-unresolved'`. */
  target: string | null
  link: string
}

/**
 * The six fs calls the link needs, as an OBJECT seam. Named `node:fs` imports cannot be intercepted by
 * `vi.spyOn` (the binding is a live import, not a property), so the default export is the injectable
 * shape and tests hand in an in-memory fake instead of touching a real `~/.infra-kit`.
 */
export interface PortlessLinkFs {
  mkdirSync: (dir: string, options: { recursive: true }) => unknown
  lstatSync: (target: string, options: { throwIfNoEntry: false }) => { isSymbolicLink: () => boolean } | undefined
  readlinkSync: (target: string) => string
  symlinkSync: (target: string, linkPath: string) => void
  renameSync: (from: string, to: string) => void
  unlinkSync: (target: string) => void
}

export interface EnsurePortlessLinkDeps {
  /** `resolvePortlessBin` — the bundled portless's `dist/cli.js`, or `null` when it is not installed. */
  resolveBin: () => string | null
  /** `isGlobalInstall` bound to this process — the ONLY gate between a checkout and the root daemon. */
  isGlobal: () => boolean
  home: string
  fs?: PortlessLinkFs
}

/** What currently sits at the link path, beyond "a symlink to X". */
const ABSENT = Symbol('absent')
const NOT_A_SYMLINK = Symbol('not-a-symlink')

const readCurrentLink = (link: string, linkFs: PortlessLinkFs): string | typeof ABSENT | typeof NOT_A_SYMLINK => {
  const stat = linkFs.lstatSync(link, { throwIfNoEntry: false })

  if (stat === undefined) return ABSENT
  if (!stat.isSymbolicLink()) return NOT_A_SYMLINK

  return linkFs.readlinkSync(link)
}

/**
 * Publish `target` at `link` through a pid-suffixed sibling and one `rename`, so the path never goes
 * absent (see the file header). The sibling is cleared BEFORE the symlink as well as after a failed
 * rename: a crash between the two calls leaves `.tmp-<pid>` behind forever, and pid reuse would then
 * turn a later boot's `symlinkSync` into EEXIST — a `'failed'` for a link that is fine. The name is
 * ours alone, never user data, so removing whatever sits there is safe; `ENOENT` is the normal case.
 */
const writeLink = (target: string, link: string, linkFs: PortlessLinkFs): void => {
  const tmp = `${link}.tmp-${process.pid}`

  try {
    linkFs.unlinkSync(tmp)
  } catch {
    // Nothing to clear — the ordinary path.
  }

  linkFs.symlinkSync(target, tmp)

  try {
    linkFs.renameSync(tmp, link)
  } catch (error) {
    try {
      linkFs.unlinkSync(tmp)
    } catch {
      // Best effort: the failed rename is the error worth surfacing, not the leftover sibling.
    }

    throw error
  }
}

/**
 * Converge `~/.infra-kit/portless` on the portless bundled with THIS install. Never throws; every
 * outcome is a value so callers can log it without a try/catch of their own.
 *
 * A non-symlink at the link path is `'failed'` and left exactly as found: this code owns a symlink, not
 * whatever a user or another tool put there, and removing a directory to make room would be the one
 * destructive action a boot hook must never take.
 *
 * @example
 * ensurePortlessLink({ resolveBin: () => '/g/node_modules/portless/dist/cli.js', isGlobal: () => true, home: '/Users/x' })
 * // => { outcome: 'created', target: '/g/node_modules/portless', link: '/Users/x/.infra-kit/portless' }
 */
export const ensurePortlessLink = (deps: EnsurePortlessLinkDeps): PortlessLinkResult => {
  const { resolveBin, isGlobal, home, fs: linkFs = fs } = deps
  const link = portlessLinkPath(home)
  const bin = resolveBin()

  if (bin === null) return { outcome: 'skipped-unresolved', target: null, link }

  const target = dirname(dirname(bin))

  if (!isGlobal()) return { outcome: 'skipped-local', target, link }

  try {
    linkFs.mkdirSync(dirname(link), { recursive: true })

    const current = readCurrentLink(link, linkFs)

    if (current === target) return { outcome: 'unchanged', target, link }
    if (current === NOT_A_SYMLINK) return { outcome: 'failed', target, link }

    writeLink(target, link, linkFs)

    return { outcome: current === ABSENT ? 'created' : 'repointed', target, link }
  } catch {
    return { outcome: 'failed', target, link }
  }
}

/** `(fields, message)` — the shape of `logger.debug`, so the CLI can pass it straight through. */
type PortlessLinkLog = (result: PortlessLinkResult, message: string) => void

/**
 * The real seams. Shared with `setup`, which needs the RESULT back to report its step, so the two
 * writers can never disagree about which install is "global" or where the link goes.
 */
export const realPortlessLinkDeps = (): EnsurePortlessLinkDeps => {
  const home = homedir()

  return {
    resolveBin: resolvePortlessBin,
    isGlobal: () => {
      return isGlobalInstall({
        selfRealPath: fs.realpathSync(fileURLToPath(import.meta.url)),
        env: process.env,
        realpath: safeRealpath,
        home,
        exists: fs.existsSync,
      })
    },
    home,
  }
}

/**
 * The process-boot entry for both bins. fs-only, no subprocess, never throws, never exits, never
 * writes to stdout; the outcome goes to `log` and nowhere else. `deps` is injectable so the "`'failed'`
 * is logged" contract is testable without a real disk.
 */
export const bootPortlessLink = (log: PortlessLinkLog, deps?: EnsurePortlessLinkDeps): void => {
  try {
    log(ensurePortlessLink(deps ?? realPortlessLinkDeps()), 'portless link')
  } catch {
    // A link that could not be converged is `doctor`'s to report; it must never be a boot failure.
  }
}
