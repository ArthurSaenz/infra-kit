/**
 * @fileoverview
 *
 * The `portless node` and `portless service target` rows: is `~/.infra-kit/node` a healthy copy of this
 * Node, and has the installed system service caught up to the stable link and node? `doctor` renders
 * the rows; `setup` asks the same question through {@link portlessServiceTargetState}, so the two
 * commands can never disagree about whether to print the `service install` line.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import { resolveGitRoot } from 'src/lib/init/agent-files'
import { isWithin, safeRealpath } from 'src/lib/install-manager'
import { tildify } from 'src/lib/path-display'

import {
  DARWIN_SERVICE_LABEL,
  DARWIN_SERVICE_PLIST_PATH,
  LINUX_SERVICE_UNIT_NAME,
  LINUX_SERVICE_UNIT_PATH,
  portlessStateDir,
} from './portless-driver'
import type { ExistsCheck } from './portless-driver'
import { portlessLinkCliPath, portlessLinkPath, realPortlessStableDeps, serviceInstallCommand } from './portless-link'
import type { ServiceInstallSeams } from './portless-link'
import { portlessNodePath, readPortlessNodeSidecar } from './portless-node'
import type { PortlessNodeFs, PortlessNodeSidecar, PortlessNodeStat } from './portless-node'
import { parseServiceArgv } from './service-file'

/** A doctor row as this module builds one — a `CheckResult` without the dependency `detail`. */
export interface PortlessRow {
  name: string
  status: 'pass' | 'fail' | 'warn' | 'skip'
  message: string
}

/**
 * The seams of `portless service target` (and of the `service install` line every remediation prints).
 * Split out of {@link PortlessCheckDeps} because `setup` asks this one row the same question doctor does
 * ({@link portlessServiceTargetState}) without the wire seams the other portless rows need.
 */
export interface ServiceTargetDeps {
  /** `process.platform` — picks the service-file grammar; anything but darwin/linux skips the row. */
  platform?: NodeJS.Platform
  /** The OS service file's text, or `null` when it is not present (= the service is not installed). */
  readServiceFile?: (filePath: string) => string | null
  /** Small text reads (`proxy.pid`, the link target's `package.json`); `null` on any failure. */
  readFile?: (filePath: string) => string | null
  exists?: ExistsCheck
  realpath?: (target: string) => string
  /** A file's mtime, or `null` when it cannot be stat'ed. */
  mtime?: (filePath: string) => Date | null
  execPath?: string
  home?: string
  cwd?: string
  /** The git toplevel of `cwd`, or `null` outside a repo (or in `$HOME`); the containment root of the "checkout" row. */
  repoRoot?: () => Promise<string | null>
  /** portless's state dir — where the daemon's `proxy.pid` lives. */
  stateDir?: () => string
  /** When `pid` started, or `null` when the process table cannot answer (dead pid, no `ps`). */
  processStartTime?: (pid: number) => Date | null
  /** `process.version` / `process.arch` — with `platform`, the triple the sidecar must name. */
  version?: string
  arch?: string
  /**
   * `<node> -p process.version` under a 2 s cap — the ONLY witness that a copy of the binary runs (a
   * hardlink is this process's own inode, which needs no spawn). One spawn at most per doctor/setup run.
   */
  nodeVersionOf?: (node: string) => NodeVersionProbe
  /** The boot hook's global-install gate: `false` turns the node row into a skip, never into a verdict. */
  isGlobal?: () => boolean
  /** The reads behind `~/.infra-kit/node` and its sidecar — an object seam, since `vi.spyOn` cannot intercept named fs imports. */
  nodeFs?: PortlessNodeFs
}

/**
 * What running `<node> -p process.version` observed. Kept as three fields rather than a boolean so the
 * `portless node` row can say WHICH way the file failed: an AMFI/Gatekeeper kill arrives as a signal with
 * a `null` status, a foreign binary as a non-zero exit, a wrong Node as a version that merely differs.
 */
export interface NodeVersionProbe {
  version: string | null
  status: number | null
  signal: NodeJS.Signals | null
}
export const SERVICE_TARGET_NAME = 'portless service target'

/**
 * An advisory service-target row. Every warn in this table is by design NOT a broken machine — an old Node
 * that still exists, a version-specific script path that still exists, a daemon one release behind — so a
 * red row would tell a working user to go run sudo now, and a green one would count it as passed.
 */
const warnRow = (message: string): PortlessRow => {
  return { name: SERVICE_TARGET_NAME, status: 'warn', message }
}

/** The plain-text file `service install` wrote on this platform, or `null` where portless writes none we read. */
const serviceFilePath = (platform: NodeJS.Platform): string | null => {
  if (platform === 'darwin') return DARWIN_SERVICE_PLIST_PATH
  if (platform === 'linux') return LINUX_SERVICE_UNIT_PATH

  return null
}

/** The root command that restarts the daemon in place — the only way a running daemon picks up a new portless. */
const restartDaemonCmd = (platform: NodeJS.Platform): string => {
  return platform === 'darwin'
    ? `sudo launchctl kickstart -k system/${DARWIN_SERVICE_LABEL}`
    : `sudo systemctl restart ${LINUX_SERVICE_UNIT_NAME}`
}

/** Absolute path to `ps` — never resolved through `PATH`, which a writable entry could substitute. */
const PS_BIN = '/bin/ps'

/**
 * The daemon's start time via `ps -o lstart=`, the one portable field the process table prints as a
 * date. `null` on any failure — no such pid, no `ps`, unparsable output — and the caller treats `null` as
 * "cannot tell", never as "predates".
 */
const defaultProcessStartTime = (pid: number): Date | null => {
  try {
    const result = spawnSync(PS_BIN, ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8' })

    if (result.status !== 0) return null

    const started = new Date(result.stdout.trim())

    return Number.isNaN(started.getTime()) ? null : started
  } catch {
    return null
  }
}

const readTextFile = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

const fileMtime = (filePath: string): Date | null => {
  try {
    return fs.statSync(filePath).mtime
  } catch {
    return null
  }
}

/**
 * A 2 s cap, not `undefined`: the file is user-writable, so a hung or hostile binary must not hang the
 * report. A spawn that never starts (`ENOENT`, `EACCES`) surfaces as `status: null, signal: null` with the
 * error swallowed — the row reads that pair as "did not start".
 */
const NODE_VERSION_TIMEOUT_MS = 2000

const defaultNodeVersionOf = (node: string): NodeVersionProbe => {
  try {
    const result = spawnSync(node, ['-p', 'process.version'], { encoding: 'utf-8', timeout: NODE_VERSION_TIMEOUT_MS })
    const version = result.stdout?.trim() ?? ''

    return { version: version === '' ? null : version, status: result.status, signal: result.signal }
  } catch {
    return { version: null, status: null, signal: null }
  }
}

/**
 * {@link ServiceTargetDeps} with every seam resolved to a value, plus the `portless node` verdict the
 * rows below render through: `stableNode` (§5.4's three-valued health) and the sidecar behind a healthy
 * one — the clock T7 reads. Both are `null` until {@link resolveHealthySeams} has run the node row.
 */
export interface ServiceTargetSeams extends Required<ServiceInstallSeams> {
  platform: NodeJS.Platform
  readServiceFile: NonNullable<ServiceTargetDeps['readServiceFile']>
  readFile: NonNullable<ServiceTargetDeps['readFile']>
  realpath: NonNullable<ServiceTargetDeps['realpath']>
  mtime: NonNullable<ServiceTargetDeps['mtime']>
  cwd: string
  repoRoot: NonNullable<ServiceTargetDeps['repoRoot']>
  stateDir: string
  processStartTime: NonNullable<ServiceTargetDeps['processStartTime']>
  version: string
  arch: string
  nodeVersionOf: NonNullable<ServiceTargetDeps['nodeVersionOf']>
  isGlobal: NonNullable<ServiceTargetDeps['isGlobal']>
  nodeFs: PortlessNodeFs
  stableNodeSidecar: PortlessNodeSidecar | null
  bin: string
}

const resolveServiceTargetSeams = (deps: ServiceTargetDeps, bin: string): ServiceTargetSeams => {
  return {
    platform: deps.platform ?? process.platform,
    readServiceFile: deps.readServiceFile ?? readTextFile,
    readFile: deps.readFile ?? readTextFile,
    exists: deps.exists ?? fs.existsSync,
    realpath: deps.realpath ?? safeRealpath,
    mtime: deps.mtime ?? fileMtime,
    execPath: deps.execPath ?? process.execPath,
    home: deps.home ?? os.homedir(),
    cwd: deps.cwd ?? process.cwd(),
    repoRoot: deps.repoRoot ?? resolveGitRoot,
    stateDir: (deps.stateDir ?? portlessStateDir)(),
    processStartTime: deps.processStartTime ?? defaultProcessStartTime,
    version: deps.version ?? process.version,
    arch: deps.arch ?? process.arch,
    nodeVersionOf: deps.nodeVersionOf ?? defaultNodeVersionOf,
    // The boot hook's own gate, so doctor and the writer can never disagree about what "global" means.
    isGlobal: deps.isGlobal ?? realPortlessStableDeps().node.isGlobal,
    nodeFs: deps.nodeFs ?? fs,
    stableNode: null,
    stableNodeSidecar: null,
    bin,
  }
}

export const PORTLESS_NODE_NAME = 'portless node'
/** How the rows NAME the file — prose, so `~` is right here; the commands they print never use it (§5.4). */
const NODE_DISPLAY = '~/.infra-kit/node'

/** The `portless node` row and what every later row renders through. `sidecar` is non-null iff `stableNode` is. */
export interface PortlessNodeVerdict {
  row: PortlessRow
  stableNode: string | null
  sidecar: PortlessNodeSidecar | null
}

const nodeFail = (message: string): PortlessNodeVerdict => {
  return { row: { name: PORTLESS_NODE_NAME, status: 'fail', message }, stableNode: null, sidecar: null }
}

const statOrUndefined = (
  stat: PortlessNodeFs['lstatSync'] | PortlessNodeFs['statSync'],
  target: string,
): PortlessNodeStat | undefined => {
  try {
    return stat(target, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
}

/** How the spawn ended, for the N7 row: the signal first, because a Gatekeeper kill has no exit status. */
const describeProbe = (probe: NodeVersionProbe): string => {
  if (probe.signal !== null) return `killed by ${probe.signal}`
  if (probe.status === null) return 'did not start'
  if (probe.status !== 0) return `exit ${probe.status}`

  return `printed ${probe.version ?? 'nothing'}`
}

const runsAsCurrentNode = (probe: NodeVersionProbe, seams: ServiceTargetSeams): boolean => {
  return probe.status === 0 && probe.signal === null && probe.version === seams.version
}

/**
 * N3–N8: is `~/.infra-kit/node` the Node this process runs, and does it run? Healthy — the definition
 * §5.4 hands every other row — is a regular file with a parsable sidecar naming this process's
 * version/arch/platform that is EITHER this process's own inode OR a copy whose recorded source size
 * matches `execPath` and which, spawned, prints `process.version`.
 *
 * The spawn is skipped on the inode-equal path: the asking process IS that inode, so it would prove
 * nothing, and it is not claimed to detect a dylib break there (§5.1).
 */
const resolvePortlessNodeHealth = (seams: ServiceTargetSeams): PortlessNodeVerdict => {
  const node = portlessNodePath(seams.home)
  const current = statOrUndefined(seams.nodeFs.lstatSync, node)

  if (current === undefined) {
    return nodeFail(
      `${NODE_DISPLAY} is missing and could not be written — run \`infra-kit setup\` and see the debug log`,
    )
  }
  if (!current.isFile()) {
    return nodeFail(
      `${NODE_DISPLAY} is not a regular file; infra-kit will not replace it — move it away and run \`infra-kit setup\``,
    )
  }

  const sidecar = readPortlessNodeSidecar(seams.home, seams.nodeFs)

  if (sidecar === null) {
    return nodeFail(
      `${NODE_DISPLAY} has no readable node.source.json and it could not be rewritten — run \`infra-kit setup\``,
    )
  }

  const exec = statOrUndefined(seams.nodeFs.statSync, seams.execPath)

  const describesProcess =
    sidecar.version === seams.version && sidecar.arch === seams.arch && sidecar.platform === seams.platform

  const sameInode = exec !== undefined && current.ino === exec.ino && current.dev === exec.dev
  const consistentCopy = sidecar.method === 'copy' && exec !== undefined && sidecar.sourceSize === exec.size

  if (!describesProcess || !(sameInode || consistentCopy)) {
    // "of <source> … a different file" is what keeps a same-version, different-inode failure (a re-mint
    // whose relink failed) from reading as a typo when both versions print the same string.
    return nodeFail(
      `${NODE_DISPLAY} is Node ${sidecar.version} (${sidecar.method} of ${tildify(sidecar.source)}); infra-kit runs ${seams.version} at ${tildify(seams.execPath)}, a different file, and could not relink it — run \`infra-kit setup\``,
    )
  }
  if (!sameInode) {
    const probe = seams.nodeVersionOf(node)

    if (!runsAsCurrentNode(probe, seams)) {
      return nodeFail(
        `${NODE_DISPLAY} does not run as Node ${seams.version} (${describeProbe(probe)}). Re-run through the current Node: \`${serviceInstallCommand(seams.bin, { ...seams, stableNode: null })}\`, then \`infra-kit setup\``,
      )
    }
  }

  return {
    row: {
      name: PORTLESS_NODE_NAME,
      status: 'pass',
      message: `${NODE_DISPLAY} is Node ${sidecar.version} (${sidecar.arch}, ${sidecar.method} of ${tildify(sidecar.source)})`,
    },
    stableNode: node,
    sidecar,
  }
}

/**
 * The `portless node` row (§5.5 N1–N8). From a checkout the ROW is a skip — the global infra-kit owns
 * the file — but `stableNode` is still resolved against this process's `execPath`, so the `service
 * install` line every other row prints is runnable from anywhere: the global's Node is often the same
 * inode, and when it is not the deep `execPath` line is what renders, exactly as before.
 */
const checkPortlessNode = (seams: ServiceTargetSeams): PortlessNodeVerdict => {
  if (serviceFilePath(seams.platform) === null) {
    return {
      row: { name: PORTLESS_NODE_NAME, status: 'skip', message: 'no portless OS service on this platform' },
      stableNode: null,
      sidecar: null,
    }
  }

  const health = resolvePortlessNodeHealth(seams)

  if (seams.isGlobal()) return health

  return {
    ...health,
    row: {
      name: PORTLESS_NODE_NAME,
      status: 'skip',
      message: `not a global install; the global infra-kit keeps ${NODE_DISPLAY} current`,
    },
  }
}

/**
 * The seams with the node verdict folded in — the ONE place it is resolved, so doctor's `:443`, CA-chain
 * and service-target rows and `setup`'s state all render the same `service install` line. Runs the node
 * row FIRST by construction: nothing below can read `stableNode` before it is set.
 */
export const resolveHealthySeams = (
  deps: ServiceTargetDeps,
  bin: string,
): { seams: ServiceTargetSeams; node: PortlessRow } => {
  const base = resolveServiceTargetSeams(deps, bin)
  const verdict = checkPortlessNode(base)

  return { seams: { ...base, stableNode: verdict.stableNode, stableNodeSidecar: verdict.sidecar }, node: verdict.row }
}

/** `version` of the package at `target`, or `'?'` — a display value; nothing is gated on it, so a corrupt file is `'?'` too. */
const readPortlessVersion = (target: string, seams: ServiceTargetSeams): string => {
  const raw = seams.readFile(path.join(target, 'package.json'))

  try {
    const parsed = raw === null ? null : z.object({ version: z.string() }).safeParse(JSON.parse(raw))

    return parsed?.success === true ? parsed.data.version : '?'
  } catch {
    return '?'
  }
}

/**
 * When the daemon started, via portless's `proxy.pid` marker — the one place this block touches a marker.
 * Acceptable because every unanswerable input (no pid file, an unparsable one, a pid `ps` cannot date)
 * collapses to `null`, which the caller reads as "cannot tell": the marker can only ever ADD an advisory,
 * never turn a healthy row red. A marker-gated `fail` is what the block's design note forbids.
 */
export const daemonStartedAt = (seams: ServiceTargetSeams): Date | null => {
  const pid = Number.parseInt(seams.readFile(path.join(seams.stateDir, 'proxy.pid'))?.trim() ?? '', 10)

  if (!Number.isInteger(pid) || pid <= 0) return null

  return seams.processStartTime(pid)
}

const parseClock = (iso: string): Date | null => {
  const at = new Date(iso)

  return Number.isNaN(at.getTime()) ? null : at
}

/**
 * T7's subject — `Node v…`, `portless …`, or both — or `null` when the daemon is current (T8) or nothing
 * can be dated.
 *
 * The Node clock is the sidecar's `versionChangedAt`, NEVER `refreshedAt` and never the file's mtime: a
 * same-version relink after a `pnpm add -g` re-mint leaves the daemon mapping identical bytes (no restart
 * needed — keying on `refreshedAt` would nag until the next kickstart after every global install), and a
 * hardlink's mtime is the package manager's install time, older than any daemon.
 */
const predatedTargets = (target: string, version: string, seams: ServiceTargetSeams): string | null => {
  const started = daemonStartedAt(seams)

  const before = (at: Date | null): boolean => {
    return started !== null && at !== null && started.getTime() < at.getTime()
  }

  const sidecar = seams.stableNodeSidecar

  const subjects = [
    ...(sidecar !== null && before(parseClock(sidecar.versionChangedAt)) ? [`Node ${sidecar.version}`] : []),
    ...(before(seams.mtime(path.join(target, 'package.json'))) ? [`portless ${version}`] : []),
  ]

  return subjects.length === 0 ? null : subjects.join(' and ')
}

/**
 * Is the link's target inside the repo the user is standing in? A daemon aimed there dangles the moment
 * the worktree is removed. Containment is tested against the git toplevel, not the cwd: from
 * `<repo>/apps/x` a link into `<repo>/node_modules/portless` is just as doomed. Outside a repo the cwd
 * is the root, and `cwd = $HOME` is excluded for the same reason `isGlobalInstall` excludes it: every
 * global layout is below `$HOME`, so from there the test would flag the correct target.
 */
const targetInsideRepo = async (target: string, seams: ServiceTargetSeams): Promise<boolean> => {
  const cwd = seams.realpath(seams.cwd)

  if (cwd === seams.realpath(seams.home)) return false

  return isWithin((await seams.repoRoot()) ?? cwd, target, seams.realpath)
}

/**
 * The row's verdict reduced to what `setup` acts on: `'absent'` (no service file to converge — not
 * installed, or a platform portless writes none for), `'converged'` (the file names the current node and
 * the stable link, and the link is healthy), or `'drifted'` (anything else, an unparsable file included).
 * The daemon-age advisory does not move a `'converged'` file: it asks for a restart, not a reinstall.
 */
export type ServiceTargetState = 'absent' | 'converged' | 'drifted'

/** The rendered row plus the state it encodes — one place decides both, so they cannot disagree. */
export interface ServiceTargetOutcome {
  state: ServiceTargetState
  row: PortlessRow
}

const drifted = (row: PortlessRow): ServiceTargetOutcome => {
  return { state: 'drifted', row }
}

/**
 * The verdict once the service's `[node, script]` are known. Failures (a daemon launchd cannot start at
 * the next boot) are decided before advisories (a daemon that starts, but not the way `dev` expects),
 * and the link's own health before Node's: the plist row order in the plan is a table of states, and a
 * single-status row has to show the most severe one.
 */
const serviceTargetVerdict = async (
  node: string,
  script: string,
  seams: ServiceTargetSeams,
): Promise<ServiceTargetOutcome> => {
  const install = serviceInstallCommand(seams.bin, seams)

  if (!seams.exists(node)) {
    return drifted({
      name: SERVICE_TARGET_NAME,
      status: 'fail',
      message: `The service runs \`${node}\`, which no longer exists (Node was upgraded, or its package dir was re-created). Re-run: \`${install}\``,
    })
  }

  const linkCli = path.join(portlessLinkPath(seams.home), 'dist', 'cli.js')

  if (script !== linkCli) {
    return drifted(
      warnRow(
        `The service points at \`${script}\`, a version-specific location. Re-run once to switch it to the stable link: \`${install}\``,
      ),
    )
  }
  if (portlessLinkCliPath(seams.home, seams.exists) === null) {
    return drifted({
      name: SERVICE_TARGET_NAME,
      status: 'fail',
      message: `~/.infra-kit/portless is broken. Run any infra-kit command from the global install (e.g. \`infra-kit setup\`) to repair it.`,
    })
  }

  const target = seams.realpath(portlessLinkPath(seams.home))

  if (await targetInsideRepo(target, seams)) {
    return drifted({
      name: SERVICE_TARGET_NAME,
      status: 'fail',
      message: `The service runs portless from a project checkout (${target}). Re-run \`service install\` from the global install: \`${install}\``,
    })
  }

  const nodeDrift = nodeDriftVerdict(node, install, seams)

  if (nodeDrift !== null) return nodeDrift

  const version = readPortlessVersion(target, seams)
  const predated = predatedTargets(target, version, seams)

  if (predated !== null) {
    return {
      state: 'converged',
      row: warnRow(
        `The running daemon predates ${predated} that \`dev\` will talk to. Restart it: \`${restartDaemonCmd(seams.platform)}\` (or reboot).`,
      ),
    }
  }

  return {
    state: 'converged',
    row: {
      name: SERVICE_TARGET_NAME,
      status: 'pass',
      message: `service runs \`${node}\` (Node ${seams.version}) + stable link → portless ${version}`,
    },
  }
}

/**
 * T5/T6 — the service's node is not the one `dev` will print. Both are advisories: the old Node still
 * exists (T1 fails otherwise), so the daemon keeps starting. T5 is the healthy-stable-node case, where a
 * single re-run moves the plist off a path the package manager will delete; T6 is the fallback when the
 * node row failed and the only runnable line is the deep `execPath` one. `null` when the plist already
 * names the node the install line would.
 */
const nodeDriftVerdict = (node: string, install: string, seams: ServiceTargetSeams): ServiceTargetOutcome | null => {
  if (seams.stableNode !== null) {
    if (seams.realpath(node) === seams.realpath(seams.stableNode)) return null

    return drifted(
      warnRow(
        `The service runs \`${node}\`, a path its package manager will remove. Re-run once to switch it to the stable node: \`${install}\``,
      ),
    )
  }
  if (seams.realpath(node) === seams.realpath(seams.execPath)) return null

  return drifted(
    warnRow(
      `The service runs \`${node}\`; infra-kit runs \`${seams.execPath}\`. Works until the old Node is removed. Re-run when convenient: \`${install}\``,
    ),
  )
}

/**
 * Which node and which `cli.js` the ROOT daemon will run at the next boot — read back from the service
 * file `service install` wrote, with the same two grammars portless reads it with (`service-file.ts`).
 * The plist is the only witness: the running daemon's argv is what it was, not what launchd will use next.
 *
 * "Not installed" is a `skip` (the `:443` row already says what to do), a file this reader
 * cannot make sense of is an advisory, never a throw.
 */
export const checkPortlessServiceTarget = async (seams: ServiceTargetSeams): Promise<ServiceTargetOutcome> => {
  const filePath = serviceFilePath(seams.platform)

  if (filePath === null) {
    return {
      state: 'absent',
      row: {
        name: SERVICE_TARGET_NAME,
        status: 'skip',
        message: 'no portless OS service file on this platform',
      },
    }
  }

  const content = seams.readServiceFile(filePath)

  if (content === null) {
    return {
      state: 'absent',
      row: {
        name: SERVICE_TARGET_NAME,
        status: 'skip',
        message: `the OS service is not installed (no ${filePath})`,
      },
    }
  }

  const [node, script] = parseServiceArgv(seams.platform, content) ?? []

  if (node === undefined || script === undefined) {
    return drifted(
      warnRow(`could not parse ${filePath} — re-run \`${serviceInstallCommand(seams.bin, seams)}\` to rewrite it.`),
    )
  }

  return serviceTargetVerdict(node, script, seams)
}

/**
 * `setup`'s view of the rows above: the service-target state and the node verdict its printed line
 * renders through, from the same seams and the same grammars, so the two commands can never disagree
 * about whether the installed service has caught up to the stable link — or about which node is healthy.
 * `bin` is the fallback the row's remediation renders when no link resolves; the caller prints its own
 * line, so it is display-only here. Never throws: every unreadable input is a state, not an error.
 */
export const portlessServiceTargetState = async (
  deps: ServiceTargetDeps,
  bin: string,
): Promise<{ state: ServiceTargetState; stableNode: string | null }> => {
  const { seams } = resolveHealthySeams(deps, bin)

  return { state: (await checkPortlessServiceTarget(seams)).state, stableNode: seams.stableNode }
}
