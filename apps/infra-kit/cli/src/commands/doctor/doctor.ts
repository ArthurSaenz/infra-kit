import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { $ } from 'zx'

import { AGENTS_MARKER_END, AGENTS_MARKER_START } from 'src/commands/init/agent-files'
import { MARKER_END, MARKER_START, buildShellBlock } from 'src/commands/init/init'
import {
  caFingerprintMatches,
  defaultIsListening,
  defaultIsProxyServing,
  formatPortlessCommand,
  handshakeChainsToCa,
  listRoutes,
  readCaPath,
  resolvePortlessBin,
} from 'src/dev/proxy/portless-driver'
import type { HandshakeResult, PortlessRoute } from 'src/dev/proxy/portless-driver'
import { getDopplerProject, listDopplerProjects } from 'src/integrations/doppler'
import { describeOverrides, readOverrideSummary } from 'src/lib/config-overrides'
import { DEFAULT_WARM_TTL_SECONDS, ENV_LOAD_FILE, getProjectWarmCacheDir } from 'src/lib/constants'
import { getProjectRoot } from 'src/lib/git-utils/git-utils'
import {
  DEFAULT_DEV_PROXY_PORT,
  getInfraKitConfig,
  getInfraKitConfigPaths,
  resetInfraKitConfigCache,
  resolveConfiguredIdes,
} from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { hasManagedBlock } from 'src/lib/managed-block'
import { tildify } from 'src/lib/path-display'
import { canonicalizeProjectRoot } from 'src/lib/warm-cache'
import { defineMcpTool, textContent } from 'src/types'

interface CheckResult {
  name: string
  status: 'pass' | 'fail'
  message: string
}

const checkCommand = async (
  name: string,
  command: string[],
  successMsg: string,
  failMsg: string,
): Promise<CheckResult> => {
  try {
    await $`${command}`

    return { name, status: 'pass', message: successMsg }
  } catch {
    return { name, status: 'fail', message: failMsg }
  }
}

const checkZshrcInitialized = (): CheckResult => {
  const name = 'zshrc init block'
  const zshrcPath = path.join(os.homedir(), '.zshrc')

  if (!fs.existsSync(zshrcPath)) {
    return { name, status: 'fail', message: '~/.zshrc not found. Run: infra-kit init' }
  }

  const content = fs.readFileSync(zshrcPath, 'utf-8')
  const startIdx = content.indexOf(MARKER_START)
  const endIdx = content.indexOf(MARKER_END)

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return {
      name,
      status: 'fail',
      message: 'infra-kit shell block missing from ~/.zshrc. Run: infra-kit init',
    }
  }

  const installedBlock = content.slice(startIdx, endIdx + MARKER_END.length).trim()
  const expectedBlock = buildShellBlock().trim()

  if (installedBlock !== expectedBlock) {
    return {
      name,
      status: 'fail',
      message: 'infra-kit shell block in ~/.zshrc is out of date. Run: infra-kit init',
    }
  }

  return { name, status: 'pass', message: 'infra-kit shell block in ~/.zshrc is up to date' }
}

/**
 * Surface the state of the project-scoped warm env cache (populated by an
 * auto-loaded shell startup). Informational only — always passes — since a
 * missing or stale warm file just means the next auto-load will (re)populate
 * it rather than indicating a problem.
 */
const checkWarmCache = async (): Promise<CheckResult> => {
  const name = 'warm cache'

  let root: string

  try {
    root = await getProjectRoot()
  } catch {
    return { name, status: 'pass', message: 'warm cache: not a git project' }
  }

  const canon = canonicalizeProjectRoot(root)

  if (!canon) {
    return { name, status: 'pass', message: 'warm cache: unavailable' }
  }

  const warmFile = path.join(getProjectWarmCacheDir(canon), ENV_LOAD_FILE)

  if (!fs.existsSync(warmFile)) {
    return { name, status: 'pass', message: 'warm cache: none yet (populated on next auto-load)' }
  }

  const ageSeconds = Math.floor((Date.now() - fs.statSync(warmFile).mtimeMs) / 1000)
  const ageMinutes = Math.floor(ageSeconds / 60)
  const ttlMinutes = Math.floor(DEFAULT_WARM_TTL_SECONDS / 60)

  if (ageSeconds >= DEFAULT_WARM_TTL_SECONDS) {
    return {
      name,
      status: 'pass',
      message: `warm cache: present but stale (${ageMinutes}m old, TTL ${ttlMinutes}m) — will refresh`,
    }
  }

  return { name, status: 'pass', message: `warm cache: present, ${ageMinutes}m old` }
}

const checkPnpmWorkspaceVirtualStore = async (): Promise<CheckResult> => {
  const name = 'pnpm enableGlobalVirtualStore'

  try {
    const root = await getProjectRoot()
    const yamlPath = path.join(root, 'pnpm-workspace.yaml')

    if (!fs.existsSync(yamlPath)) {
      return { name, status: 'fail', message: `pnpm-workspace.yaml not found at ${yamlPath}` }
    }

    const content = fs.readFileSync(yamlPath, 'utf-8')
    // eslint-disable-next-line sonarjs/super-linear-regex
    const enabled = /^\s*enableGlobalVirtualStore\s*:\s*true\s*$/m.test(content)

    if (!enabled) {
      return {
        name,
        status: 'fail',
        message: 'enableGlobalVirtualStore: true is missing in pnpm-workspace.yaml',
      }
    }

    return { name, status: 'pass', message: 'enableGlobalVirtualStore: true is set' }
  } catch (err) {
    return {
      name,
      status: 'fail',
      message: `Failed to read pnpm-workspace.yaml: ${(err as Error).message}`,
    }
  }
}

const checkInfraKitConfigValid = async (): Promise<CheckResult> => {
  const name = 'infra-kit config valid'

  try {
    resetInfraKitConfigCache()
    await getInfraKitConfig()

    return {
      name,
      status: 'pass',
      message: 'infra-kit.json is valid (user overrides applied if present)',
    }
  } catch (err) {
    return { name, status: 'fail', message: (err as Error).message }
  }
}

/**
 * Verify the Doppler project configured in infra-kit.json (`envManagement.config.name`)
 * actually exists in the authenticated account — the proactive catch for the
 * mismatch that otherwise only surfaces as a cryptic `env-load` failure. Skips
 * (informational pass) when the config can't be read or the project list can't be
 * fetched (auth/network), so a logged-out user isn't misdiagnosed as
 * missing-project — the adjacent `doppler authenticated` check owns that failure.
 */
export const checkDopplerProjectExists = async (): Promise<CheckResult> => {
  const name = 'doppler project exists'

  let project: string

  try {
    project = await getDopplerProject()
  } catch {
    return { name, status: 'pass', message: 'Skipped — infra-kit config could not be read (see config check)' }
  }

  const projects = await listDopplerProjects()

  if (projects === null) {
    return { name, status: 'pass', message: 'Skipped — could not list Doppler projects (see doppler auth check)' }
  }

  if (projects.includes(project)) {
    return { name, status: 'pass', message: `Doppler project "${project}" exists` }
  }

  return {
    name,
    status: 'fail',
    message: `Doppler project "${project}" not found (set in infra-kit.json → envManagement.config.name). Available: ${
      projects.length > 0 ? projects.join(', ') : 'none'
    }`,
  }
}

/**
 * Surface where this developer's user-scope override file lives and what it CONTAINS. Always passes
 * (informational) inside a git repo; fails only when the config paths can't be resolved at all.
 *
 * Three-way on purpose. Every non-excluded command now seeds layer 3 in its preAction hook — and
 * `doctor` is one of them, so by the time this check runs the file should already exist. An ABSENT
 * file therefore no longer means "not yet created", it means the seed FAILED (read-only `$HOME`, a
 * sandbox, a locked-down CI image). That failure path is `logger.debug` only, so this line is the
 * ONLY place a permanently-failing seed becomes visible — it must not be confusable with a healthy
 * empty file. Content reporting is shared with `config path` via `readOverrideSummary` /
 * `describeOverrides` (one JSON-tolerance policy: raw keys, malformed degrades, never throws).
 *
 * @example
 * await checkUserOverridePath()
 * // {
 * //   name: 'user override path',
 * //   status: 'pass',
 * //   message: '~/.infra-kit/projects/api/infra-kit.json (2 override(s): ide, dev) — project: api',
 * // }
 * // absent  -> '… (not created — seed failed?) — project: api'
 * // empty   -> '… (empty — no overrides) — project: api'
 * // corrupt -> '… (unreadable — invalid JSON) — project: api'
 */
export const checkUserOverridePath = async (): Promise<CheckResult> => {
  const name = 'user override path'

  try {
    const paths = await getInfraKitConfigPaths()
    const exists = fs.existsSync(paths.userProject)
    const summary = await readOverrideSummary(paths.userProject, exists)
    const suffix = exists ? describeOverrides(summary) : '(not created — seed failed?)'

    return {
      name,
      status: 'pass',
      message: `${tildify(paths.userProject)} ${suffix} — project: ${paths.projectName}`,
    }
  } catch (err) {
    return { name, status: 'fail', message: (err as Error).message }
  }
}

/**
 * Surface a lingering legacy `~/.infra-kit/config.json` left behind after the
 * user-global config was renamed to `infra-kit.json`. The on-`init` auto-rename
 * is the migration path, but a user who edits the file and never re-runs `init`
 * would silently have their overrides stop applying — this makes that visible.
 *
 * Branches on whether the canonical `infra-kit.json` already exists so the
 * message is accurate: only the "no infra-kit.json yet" case means overrides are
 * not being applied; when both exist the legacy file is merely stale.
 * Informational pass (no warning) when the paths can't resolve — mirrors
 * {@link checkIdeInstalled}: nothing to surface if there's no resolvable target.
 *
 * @example
 * await checkLegacyUserGlobalConfig()
 * // { name: 'legacy user-global config', status: 'fail', message: 'Legacy user-global config.json found …' }
 */
export const checkLegacyUserGlobalConfig = async (): Promise<CheckResult> => {
  const name = 'legacy user-global config'

  let paths: Awaited<ReturnType<typeof getInfraKitConfigPaths>>

  try {
    paths = await getInfraKitConfigPaths()
  } catch {
    return { name, status: 'pass', message: 'Skipped — infra-kit config paths could not be resolved' }
  }

  const legacyPath = path.join(path.dirname(paths.userGlobal), 'config.json')

  if (!fs.existsSync(legacyPath)) {
    return { name, status: 'pass', message: 'No legacy user-global config.json' }
  }

  if (!fs.existsSync(paths.userGlobal)) {
    return {
      name,
      status: 'fail',
      message: `Legacy user-global config.json found at ${tildify(legacyPath)} — run \`infra-kit init\` to migrate it (your overrides are not being applied).`,
    }
  }

  return {
    name,
    status: 'fail',
    message: `Stale legacy config.json found at ${tildify(legacyPath)} — ${tildify(paths.userGlobal)} is active; remove the old file.`,
  }
}

interface IdeProbe {
  ok: boolean
  label: string
  failMsg: string
}

const IDE_PROBE_META: Record<'cursor' | 'zed', { command: string[]; label: string; failMsg: string }> = {
  cursor: {
    command: ['cursor', '--version'],
    label: 'Cursor',
    failMsg: 'Cursor is not installed. Install from: https://cursor.com/',
  },
  zed: {
    command: ['zed', '--version'],
    label: 'Zed',
    failMsg: 'Zed is not installed. Install from: https://zed.dev/',
  },
}

const probeIde = async (provider: 'cursor' | 'zed'): Promise<IdeProbe> => {
  const meta = IDE_PROBE_META[provider]

  try {
    await $`${meta.command}`

    return { ok: true, label: meta.label, failMsg: meta.failMsg }
  } catch {
    return { ok: false, label: meta.label, failMsg: meta.failMsg }
  }
}

/**
 * Check that every editor configured under `ide` is installed. Reads the merged
 * infra-kit config and probes each matching binary (`cursor`/`zed`). Passes only
 * if all configured editors are present; fails listing any that are missing.
 * Informational pass when no IDE is configured or the config can't be read — an
 * unconfigured editor is a valid setup, and config validity is reported
 * separately by `checkInfraKitConfigValid`.
 */
export const checkIdeInstalled = async (): Promise<CheckResult> => {
  const name = 'ide installed'

  let providers: ('cursor' | 'zed')[]

  try {
    resetInfraKitConfigCache()
    const config = await getInfraKitConfig()

    providers = resolveConfiguredIdes(config).map((ide) => {
      return ide.provider
    })
  } catch {
    return { name, status: 'pass', message: 'Skipped — infra-kit config could not be read (see config check)' }
  }

  if (providers.length === 0) {
    return { name, status: 'pass', message: 'No IDE configured (ide unset)' }
  }

  const probes = await Promise.all(
    providers.map((provider) => {
      return probeIde(provider)
    }),
  )
  const missing = probes.filter((probe) => {
    return !probe.ok
  })

  if (missing.length === 0) {
    return {
      name,
      status: 'pass',
      message: `Installed: ${probes
        .map((probe) => {
          return probe.label
        })
        .join(', ')}`,
    }
  }

  return {
    name,
    status: 'fail',
    message: missing
      .map((probe) => {
        return probe.failMsg
      })
      .join('; '),
  }
}

const RTK_REQUIRED_INDEXES = [1, 2, 3, 5, 7] as const

const checkRtkConfigured = async (): Promise<CheckResult> => {
  const name = 'rtk configured'

  try {
    const result = await $`rtk init --show`
    const statusLines = result.stdout
      .split('\n')
      .map((l) => {
        return l.trim()
      })
      .filter((l) => {
        return l.startsWith('[ok]') || l.startsWith('[--]')
      })

    const failed: number[] = []

    for (const idx of RTK_REQUIRED_INDEXES) {
      const line = statusLines[idx - 1]

      if (!line || !line.startsWith('[ok]')) {
        failed.push(idx)
      }
    }

    if (failed.length > 0) {
      return {
        name,
        status: 'fail',
        message: `rtk setup incomplete (items ${failed.join(', ')} not [ok]). Run: rtk init -g --auto-patch`,
      }
    }

    return {
      name,
      status: 'pass',
      message: 'rtk hook, RTK.md, global CLAUDE.md, settings.json, and Cursor hook are configured',
    }
  } catch (err) {
    return {
      name,
      status: 'fail',
      message: `Failed to run 'rtk init --show': ${(err as Error).message}`,
    }
  }
}

/**
 * Check that the repo agent-instruction guidance managed by `infra-kit init` exists:
 * the guidance block in `CLAUDE.md`. Presence only. Repo-gated: returns no checks
 * when run outside an infra-kit repo so doctor never crashes there. A repo that
 * predates the AGENTS.md→CLAUDE.md migration will report this check as failing until
 * `infra-kit init` is re-run.
 */
export const checkAgentFiles = async (): Promise<CheckResult[]> => {
  let mainConfigPath: string

  try {
    mainConfigPath = (await getInfraKitConfigPaths()).main
  } catch {
    return []
  }

  if (!fs.existsSync(mainConfigPath)) return []

  const claudePath = path.join(path.dirname(mainConfigPath), 'CLAUDE.md')
  const content = fs.existsSync(claudePath) ? fs.readFileSync(claudePath, 'utf-8') : ''
  const present = hasManagedBlock(content, AGENTS_MARKER_START, AGENTS_MARKER_END)

  return [
    {
      name: 'CLAUDE.md block',
      status: present ? 'pass' : 'fail',
      message: present ? 'CLAUDE.md block present' : 'infra-kit block missing from CLAUDE.md. Run: infra-kit init',
    },
  ]
}

/**
 * The one-time, out-of-band, ROOT command that installs the `:443` daemon. infra-kit never runs it — it
 * only ever prints it (principle 3: infra-kit probes and prints, it never elevates).
 *
 * Rendered from the resolved `dist/cli.js`, never as a bare `portless`: portless is an npm dependency in
 * `node_modules`, not a global bin, and `sudo` swaps `PATH` for `secure_path` — so the bare form cannot
 * resolve under sudo even in a shell where it otherwise would. See {@link formatPortlessCommand}.
 */
const installDaemonCmd = (bin: string): string => {
  return formatPortlessCommand(['service', 'install'], { sudo: true, bin })
}

/** The sudo-free "trust the local CA" command, rendered from the same resolved bin. */
const trustCmd = (bin: string): string => {
  return formatPortlessCommand(['trust'], { bin })
}

/** TLS chain failures that mean "the daemon's cert does not chain to the `ca.pem` we hold". */
const CA_MISMATCH_CODES = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])

/**
 * A validating probe of an IP literal sends no SNI and lands on portless's default cert, which has no IP
 * SAN — so this code means OUR probe forgot a `servername`, never that the user's CA went bad. It must
 * never reach a `portless trust` remediation: doing so would tell every correctly-configured user to
 * repair a trust store that is fine.
 */
const PROBE_BUG_CODE = 'ERR_TLS_CERT_ALTNAME_INVALID'

/** Every process/fs seam the portless checks touch, injected so tests never reach the real daemon. */
export interface PortlessCheckDeps {
  resolveBin?: () => string | null
  isProxyServing?: (port: number, tls: boolean) => Promise<boolean>
  handshake?: (port: number, servername: string) => Promise<HandshakeResult>
  caTrusted?: () => boolean
  routes?: () => PortlessRoute[]
  isListening?: (port: number) => Promise<boolean>
  caPath?: () => string
}

/** Is the daemon serving portless-over-TLS on the dev proxy port? Proven on the wire; reads no state file. */
const checkPortlessServing = async (
  isProxyServing: NonNullable<PortlessCheckDeps['isProxyServing']>,
  bin: string,
): Promise<CheckResult> => {
  const name = `portless serving TLS on :${DEFAULT_DEV_PROXY_PORT}`
  const serving = await isProxyServing(DEFAULT_DEV_PROXY_PORT, true)

  if (!serving) {
    return {
      name,
      status: 'fail',
      message: `No portless daemon is serving HTTPS on :${DEFAULT_DEV_PROXY_PORT}. Install it once (needs root): \`${installDaemonCmd(bin)}\`.`,
    }
  }

  return { name, status: 'pass', message: `portless is serving HTTPS on :${DEFAULT_DEV_PROXY_PORT}` }
}

/**
 * Does the daemon serve a certificate that chains to the `ca.pem` on disk? The only check that VALIDATES
 * the chain — the serving probe above deliberately does not, so that a down daemon and an untrusted CA stay
 * two distinguishable failures with two different fixes.
 *
 * Probes `localhost` (always in the default cert's SANs, so it works on a fresh machine with zero aliases)
 * and, when one is registered, a real alias — which validates the exact path the browser takes.
 */
const checkPortlessCaChain = async (
  handshake: NonNullable<PortlessCheckDeps['handshake']>,
  routes: PortlessRoute[],
  caPath: string,
  bin: string,
): Promise<CheckResult> => {
  const name = 'portless CA chain valid'
  const servernames = [
    'localhost',
    ...routes.slice(0, 1).map((route) => {
      return route.name
    }),
  ]
  const results = await Promise.all(
    servernames.map(async (servername) => {
      return { servername, result: await handshake(DEFAULT_DEV_PROXY_PORT, servername) }
    }),
  )
  const failed = results.filter((entry) => {
    return !entry.result.ok
  })

  if (failed.length === 0) {
    return {
      name,
      status: 'pass',
      message: `Served certificate chains to ${tildify(caPath)} (${servernames.join(', ')})`,
    }
  }

  const codes = failed.map((entry) => {
    return entry.result.ok ? '' : entry.result.code
  })

  if (codes.includes(PROBE_BUG_CODE)) {
    return {
      name,
      status: 'fail',
      message: `Internal check error: the TLS probe got ${PROBE_BUG_CODE} for servername(s) ${failed
        .map((entry) => {
          return entry.servername
        })
        .join(', ')} — doctor's probe is wrong, your trust store is not implicated. Please report this.`,
    }
  }

  if (
    codes.some((code) => {
      return CA_MISMATCH_CODES.has(code)
    })
  ) {
    return {
      name,
      status: 'fail',
      message: `The daemon is serving a certificate that does not chain to ${tildify(caPath)}. Its CA was regenerated — run \`${trustCmd(bin)}\`, or reinstall: \`${installDaemonCmd(bin)}\`.`,
    }
  }

  return { name, status: 'fail', message: `TLS handshake failed (${codes.join(', ')})` }
}

/**
 * Was `portless trust` run for the CA now on disk? Fingerprint marker only — it proves the marker was
 * written for THIS `ca.pem` and the CA has not been regenerated since. It does NOT prove the keychain still
 * trusts it: a user who deletes the certificate by hand in Keychain Access leaves the marker behind and
 * passes here. Accepted residual (see `caFingerprintMatches`); the chain check above is what proves what the
 * daemon actually serves.
 */
const checkPortlessCaTrusted = (trusted: boolean, caPath: string, bin: string): CheckResult => {
  const name = 'portless CA trusted'

  if (!trusted) {
    return {
      name,
      status: 'fail',
      message: `The portless CA is not trusted (or was regenerated). Run: \`${trustCmd(bin)}\` (no sudo needed).`,
    }
  }

  return { name, status: 'pass', message: `${tildify(caPath)} matches the recorded ca.trusted fingerprint` }
}

/**
 * Routes whose target port has nothing listening — a worktree whose runner was SIGKILLed. Newly worth
 * surfacing under HTTPS: a dead target is now an opaque 502 from the proxy rather than a connection refusal.
 */
const checkPortlessStaleRoutes = async (
  routes: PortlessRoute[],
  isListening: NonNullable<PortlessCheckDeps['isListening']>,
  bin: string,
): Promise<CheckResult> => {
  const name = 'portless routes'

  if (routes.length === 0) return { name, status: 'pass', message: 'No portless routes registered' }

  const probed = await Promise.all(
    routes.map(async (route) => {
      return { route, live: await isListening(route.port) }
    }),
  )
  const stale = probed
    .filter((entry) => {
      return !entry.live
    })
    .map((entry) => {
      return entry.route.name
    })

  if (stale.length === 0) {
    return { name, status: 'pass', message: `${routes.length} portless route(s), all live` }
  }

  return {
    name,
    status: 'fail',
    message: `${stale.length} stale portless route(s): ${stale.join(', ')}. Remove with \`${formatPortlessCommand(['alias', '--remove', '<name>'], { bin })}\`.`,
  }
}

/**
 * The portless block of doctor: is the HTTPS dev proxy installed, serving, trusted, and free of dead routes?
 * This is the diagnostic surface for the port-free HTTPS dev URLs — it is what tells a developer to run
 * `trust` (sudo-free) or the one-time `service install` (root), and it never conflates the two. Both are
 * printed via {@link formatPortlessCommand} — as `<node> <cli.js> …`, the only form that runs.
 *
 * Every check observes the daemon **on the wire or on our own disk** — never through portless's `proxy.port`
 * / `proxy.pid` / `proxy.tls` markers, which are process-global singletons that ANY daemon start rewrites and
 * ANY daemon stop deletes. Gating on them made doctor report a perfectly healthy `:443` daemon as dead.
 *
 * Reports only: nothing here is auto-run, and nothing requiring sudo ever could be.
 *
 * @example
 * await checkPortless()
 * // [{ name: 'portless installed', status: 'pass', message: '…' }, … 5 checks]
 */
export const checkPortless = async (deps: PortlessCheckDeps = {}): Promise<CheckResult[]> => {
  const resolveBin = deps.resolveBin ?? resolvePortlessBin
  const isProxyServing = deps.isProxyServing ?? defaultIsProxyServing
  const handshake = deps.handshake ?? handshakeChainsToCa
  const caTrusted = deps.caTrusted ?? caFingerprintMatches
  const readRoutes = deps.routes ?? listRoutes
  const isListening = deps.isListening ?? defaultIsListening
  const caPath = (deps.caPath ?? readCaPath)()
  // Resolved ONCE, then threaded into every remediation below: each one is rendered as `<node> <bin> …`, so a
  // check that could not name the binary could not print a runnable fix either.
  const bin = resolveBin()

  if (bin === null) {
    return [
      {
        name: 'portless installed',
        status: 'fail',
        message: 'portless is not resolvable from node_modules — run `pnpm install`.',
      },
    ]
  }

  const installed: CheckResult = {
    name: 'portless installed',
    status: 'pass',
    message: 'portless is resolvable from node_modules',
  }
  const routes = readRoutes()
  const serving = await checkPortlessServing(isProxyServing, bin)
  // Nothing is answering on :443 — there is no certificate to validate, so the chain check would only add a
  // second, derivative failure to the one the user must fix first.
  const chain: CheckResult =
    serving.status === 'fail'
      ? { name: 'portless CA chain valid', status: 'pass', message: 'Skipped — no daemon to handshake with' }
      : await checkPortlessCaChain(handshake, routes, caPath, bin)

  return [
    installed,
    serving,
    chain,
    checkPortlessCaTrusted(caTrusted(), caPath, bin),
    await checkPortlessStaleRoutes(routes, isListening, bin),
  ]
}

/**
 * Check installation and authentication status of gh, doppler, aws, and rtk CLIs
 */
export const doctor = async () => {
  const baseChecks: CheckResult[] = await Promise.all([
    checkCommand(
      'gh installed',
      ['gh', '--version'],
      'GitHub CLI is installed',
      'GitHub CLI is not installed. Install from: https://cli.github.com/',
    ),
    checkCommand(
      'gh authenticated',
      ['gh', 'auth', 'status'],
      'GitHub CLI is authenticated',
      'GitHub CLI is not authenticated. Run: gh auth login',
    ),
    checkCommand(
      'doppler installed',
      ['doppler', '--version'],
      'Doppler CLI is installed',
      'Doppler CLI is not installed. Install from: https://docs.doppler.com/docs/install-cli',
    ),
    checkCommand(
      'doppler authenticated',
      ['doppler', 'me'],
      'Doppler CLI is authenticated',
      'Doppler CLI is not authenticated. Run: doppler login',
    ),
    checkCommand(
      'aws installed',
      ['aws', '--version'],
      'AWS CLI is installed',
      'AWS CLI is not installed. Install from: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
    ),
    checkCommand(
      'rtk installed',
      ['rtk', '--version'],
      'RTK is installed',
      'RTK is not installed. Install from: https://github.com/rtk-ai/rtk',
    ),
    checkCommand(
      'typescript-language-server installed',
      ['typescript-language-server', '--version'],
      'typescript-language-server is installed',
      'typescript-language-server is not installed. Install from: https://github.com/typescript-language-server/typescript-language-server#installing',
    ),
    checkCommand(
      'cmux installed',
      ['cmux', '--version'],
      'cmux is installed',
      'cmux is not installed. Install from: https://cmux.com/',
    ),
    checkRtkConfigured(),
    Promise.resolve(checkZshrcInitialized()),
    checkWarmCache(),
    checkPnpmWorkspaceVirtualStore(),
    checkInfraKitConfigValid(),
    checkDopplerProjectExists(),
    checkUserOverridePath(),
    checkLegacyUserGlobalConfig(),
    checkIdeInstalled(),
  ])

  const checks: CheckResult[] = [...baseChecks, ...(await checkPortless()), ...(await checkAgentFiles())]

  logger.info('Doctor check results:\n')

  for (const check of checks) {
    const icon = check.status === 'pass' ? '[PASS]' : '[FAIL]'

    logger.info(`  ${icon} ${check.name}: ${check.message}`)
  }

  const structuredContent = {
    checks: checks.map((c) => {
      return { name: c.name, status: c.status, message: c.message }
    }),
    allPassed: checks.every((c) => {
      return c.status === 'pass'
    }),
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

// MCP Tool Registration
export const doctorMcpTool = defineMcpTool({
  name: 'doctor',
  description: 'Check installation and authentication status of gh, doppler, aws, and rtk CLIs',
  inputSchema: {},
  outputSchema: {
    checks: z
      .array(
        z.object({
          name: z.string().describe('Name of the check'),
          status: z.enum(['pass', 'fail']).describe('Check result'),
          message: z.string().describe('Details about the check result'),
        }),
      )
      .describe('List of all check results'),
    allPassed: z.boolean().describe('Whether all checks passed'),
  },
  handler: doctor,
})
