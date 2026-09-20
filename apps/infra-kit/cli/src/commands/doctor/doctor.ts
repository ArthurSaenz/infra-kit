import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import { decidePrune, isDevSessionRunning } from 'src/commands/doctor/prune-routes'
// The one source of truth for "does `--fix` repair this row". Imported rather than restated so the
// `fixable` field on the payload cannot drift from the `--fix` code paths, exactly as `report.ts`'s
// own comment requires of its hint.
import { FIXABLE_NAMES } from 'src/commands/doctor/report'
import { parseServiceArgv } from 'src/commands/doctor/service-file'
import { buildDopplerChildEnv } from 'src/commands/env-load/env-load'
import { buildZshenvBlock } from 'src/commands/init'
// `resolveGitRoot` is the WRITER's gate, imported rather than re-derived so the reader's row set and
// the writer's reach cannot drift apart (see the gate comment beside the plugin rows below).
import { AGENTS_MARKER_END, AGENTS_MARKER_START, resolveGitRoot } from 'src/commands/init/agent-files'
import { MARKER_END, MARKER_START, buildShellBlock } from 'src/commands/init/init'
import {
  DARWIN_SERVICE_LABEL,
  DARWIN_SERVICE_PLIST_PATH,
  LINUX_SERVICE_UNIT_NAME,
  LINUX_SERVICE_UNIT_PATH,
  caFingerprintMatches,
  createPortlessDriver,
  defaultIsListening,
  defaultIsProxyServing,
  formatPortlessCommand,
  handshakeChainsToCa,
  listRoutes,
  portlessStateDir,
  readCaPath,
  resolvePortlessBin,
} from 'src/dev/proxy/portless-driver'
import type { ExistsCheck, HandshakeResult, PortlessRoute } from 'src/dev/proxy/portless-driver'
import {
  portlessLinkCliPath,
  portlessLinkPath,
  realPortlessStableDeps,
  serviceInstallCommand,
} from 'src/dev/proxy/portless-link'
import type { ServiceInstallSeams } from 'src/dev/proxy/portless-link'
import { portlessNodePath, readPortlessNodeSidecar } from 'src/dev/proxy/portless-node'
import type { PortlessNodeFs, PortlessNodeSidecar, PortlessNodeStat } from 'src/dev/proxy/portless-node'
import { INFRA_KIT_ENV_TOKEN_VAR, probeEnvToken, resolveEnvToken } from 'src/integrations/doppler'
import type { EnvTokenProbe, EnvTokenSource, ResolvedEnvToken } from 'src/integrations/doppler'
import type { IdeProvider } from 'src/integrations/ide'
import { probeOrca } from 'src/integrations/orca'
import { inspectPackageGuidance, readGuidanceFile } from 'src/lib/agent-guidance'
import { agentMode, resolveAgentModeSource } from 'src/lib/agent-mode'
import type { ResolveAgentModeInput } from 'src/lib/agent-mode'
import { describeOverrides, readOverrideSummary } from 'src/lib/config-overrides'
import { DEFAULT_WARM_TTL_SECONDS, ENV_LOAD_FILE, getProjectWarmCacheDir } from 'src/lib/constants'
// The probe reports FACTS about an install and can neither name nor run a fix — the same one-way seam
// as the registry import below. `lib/dependency-plan` is the module that turns a probe into a recipe,
// and `doctor` deliberately stops one module short of it.
import { defaultProbeDeps, probeAll } from 'src/lib/dependency-probe'
import type { DependencyState, ProbeDeps } from 'src/lib/dependency-probe'
// Probe argv only. `doctor` must never import the install recipes: the registry owns "how do I ask this
// tool for its version", `setup-dependency*` owns "what would fix it", and the direction is one-way.
import { specFor } from 'src/lib/dependency-registry'
import type { DependencyId } from 'src/lib/dependency-registry'
import { getTokenStorePath, readTokenStore } from 'src/lib/env-tokens'
import type { TokenStore } from 'src/lib/env-tokens'
import { getProjectRoot } from 'src/lib/git-utils/git-utils'
import {
  DEFAULT_DEV_PROXY_PORT,
  getInfraKitConfig,
  getInfraKitConfigPaths,
  resetInfraKitConfigCache,
  resolveConfiguredIdes,
} from 'src/lib/infra-kit-config'
import type { InfraKitConfig } from 'src/lib/infra-kit-config'
import { isWithin, safeRealpath } from 'src/lib/install-manager'
import { hasManagedBlock } from 'src/lib/managed-block'
import { discoverPackages } from 'src/lib/package-validator/loader'
import { tildify } from 'src/lib/path-display'
import {
  MARKETPLACE_NAME,
  MARKETPLACE_REPO,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_KEY,
  PLUGIN_UPDATE_COMMAND,
  inspectLegacyMcpRegistration,
  isMarketplaceRegistered,
  readInstalledPluginVersion,
  resolvePluginInstall,
} from 'src/lib/plugin-pointer'
import type { McpRegistration, PluginInstallState } from 'src/lib/plugin-pointer'
import { readMarketplacePluginVersion } from 'src/lib/plugin-pointer/install-state'
import { MCP_FILE_NAME, SERVERS_KEY } from 'src/lib/plugin-pointer/mcp-registration'
import { listProjectEnvNames } from 'src/lib/project-envs'
import { quietShell } from 'src/lib/quiet-shell'
import { isNewerVersion } from 'src/lib/update-check/semver'
import { sortVersions } from 'src/lib/version-utils'
import { canonicalizeProjectRoot } from 'src/lib/warm-cache'
import { defineMcpTool, textContent } from 'src/types'

import packageJson from '../../../package.json' with { type: 'json' }
import { SETTINGS_FILES, inspectAgentAllowlist } from './agent-allowlist'

/**
 * What the probe knows about one external tool, riding along on the row that already answers "is it
 * installed" — so an agent asking that question reads ONE list, never a sibling array with its own
 * semantics. Deliberately probe facts ONLY: no `action`, no `commands`. Widening it to the install
 * report is how `doctor --fix` would arrive by another door, and `probe-argv-single-source.test.ts`
 * asserts the absence of those two keys at the type level for that reason.
 *
 * `present` and `onPath` are separate because they genuinely disagree: the AWS-documented installer
 * writes `$HOME/.local/bin`, so `aws` can be `status: 'fail'` (the row means "resolves on PATH") while
 * `detail.present` is `true`.
 */
export interface DependencyDetail {
  manager: DependencyState['manager']
  version: string | null
  present: boolean
  onPath: boolean
}

/**
 * One diagnosis. `name` is a stable public identifier — it is returned under `--json`, keyed by the
 * report's section map (`report.ts`), and pasted into bug reports — so renaming one is a breaking change.
 *
 * `detail` is OPTIONAL and carried by the four dependency rows alone, which is what keeps the ~23 other
 * check functions untouched. `portless installed` deliberately has none: it resolves out of
 * `node_modules` rather than off `PATH`, so a probe payload would describe a different question than
 * the row asks (`probe-argv-single-source.test.ts`).
 */
export interface CheckResult {
  name: string
  /**
   * `warn` is a third verdict, not a soft fail: the report counts it apart, `--fix` never claims it,
   * and `allPassed` ignores it. It exists for one class of row — a setting that is legal but defeats a
   * guard the CLI relies on (`Agent allowlist`) — where red would be a lie and green would hide it.
   */
  status: 'pass' | 'fail' | 'warn'
  message: string
  detail?: DependencyDetail
}

/**
 * The rows that carry a {@link DependencyDetail} — every registry id except `portless`, whose
 * exclusion is argued in `probe-argv-single-source.test.ts`. Declared here rather than derived from
 * `DEPENDENCY_IDS` minus a filter: the exclusion is a decision, and a decision should be readable.
 */
const DETAILED_IDS: readonly DependencyId[] = ['brew', 'gh', 'doppler', 'aws']

/**
 * Probe the detailed ids once, keyed by id. Runs alongside the `--version` rows rather than replacing
 * them: the rows keep their published meaning ("resolves on PATH"), and the probe answers the richer
 * question beside it.
 */
const probeDependencyDetails = async (deps: ProbeDeps): Promise<Map<DependencyId, DependencyDetail>> => {
  const states = await probeAll(DETAILED_IDS, deps)

  return new Map(
    states.map((state): [DependencyId, DependencyDetail] => {
      return [
        state.id,
        { manager: state.manager, version: state.version, present: state.present, onPath: state.onPath },
      ]
    }),
  )
}

const checkCommand = async (
  name: string,
  command: string[],
  successMsg: string,
  failMsg: string,
): Promise<CheckResult> => {
  try {
    await quietShell()`${command}`

    return { name, status: 'pass', message: successMsg }
  } catch {
    return { name, status: 'fail', message: failMsg }
  }
}

/**
 * Three verdicts, not a binary probe: the Orca CLI can be on PATH while the desktop app is closed, and
 * every reveal/teardown in `worktrees add|remove` degrades on exactly that state — so a green row must
 * mean "the runtime will take a `terminal create`", which only `probeOrca` can answer.
 */
const checkOrca = async (): Promise<CheckResult> => {
  const name = 'orca installed'
  const probe = await probeOrca()

  if (probe === 'absent') {
    return {
      name,
      status: 'fail',
      message:
        'orca is not on PATH. Install with: brew install --cask stablyai/orca/orca, then register the CLI in Orca → Settings → Experimental → CLI',
    }
  }

  if (probe === 'unreachable') {
    return { name, status: 'warn', message: 'orca is installed but the app is not running — start it with: orca open' }
  }

  return { name, status: 'pass', message: 'Installed: orca (app running, runtime reachable)' }
}

/**
 * Freshness of one marker-delimited rc block: present, and byte-equal to what `setup` would write today.
 * `what` is the phrase the messages use for the block ("shell" / "session-env"); the file is always
 * read from the home directory. Blind spot shared by both callers: a `/etc/zshenv`-set `ZDOTDIR` makes
 * zsh read `$ZDOTDIR/<file>` instead, so "up to date" here can be true while the block never runs.
 */
const checkManagedRcBlock = (name: string, file: string, what: string, expected: string): CheckResult => {
  const rcPath = path.join(os.homedir(), file)
  const fix = 'Run: infra-kit setup --skip-tools'

  if (!fs.existsSync(rcPath)) {
    return { name, status: 'fail', message: `~/${file} not found. ${fix}` }
  }

  const content = fs.readFileSync(rcPath, 'utf-8')
  const startIdx = content.indexOf(MARKER_START)
  const endIdx = content.indexOf(MARKER_END)

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { name, status: 'fail', message: `infra-kit ${what} block missing from ~/${file}. ${fix}` }
  }

  const installedBlock = content.slice(startIdx, endIdx + MARKER_END.length).trim()

  if (installedBlock !== expected.trim()) {
    return { name, status: 'fail', message: `infra-kit ${what} block in ~/${file} is out of date. ${fix}` }
  }

  return { name, status: 'pass', message: `infra-kit ${what} block in ~/${file} is up to date` }
}

export const checkZshrcInitialized = (): CheckResult => {
  return checkManagedRcBlock('zshrc init block', '.zshrc', 'shell', buildShellBlock())
}

export const checkZshenvInitialized = (): CheckResult => {
  return checkManagedRcBlock('zshenv session block', '.zshenv', 'session-env', buildZshenvBlock())
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

/**
 * The merged infra-kit config, read ONCE per `doctor()` run and threaded into every check that needs
 * it. Either half is populated, never both.
 *
 * Reading it once is not an optimization, it is the fix for a real race: `checkInfraKitConfigValid`
 * and `checkIdeInstalled` each called `resetInfraKitConfigCache()` and were dispatched together
 * inside one `Promise.all`, so they clobbered the same module-level cache slot — whichever reset
 * landed second could blow away a config the other had just populated. One read, no shared slot.
 */
export interface DoctorConfig {
  config: InfraKitConfig | null
  error: Error | null
}

/**
 * Read the merged config once for the whole run, resetting the module cache exactly once so `doctor`
 * always reports what is on disk NOW (it is the command a user runs right after editing the file).
 * Never throws: a broken config is the thing `doctor` exists to explain, so it is captured and
 * threaded rather than allowed to abort the run.
 *
 * @example
 * await readDoctorConfig() // => { config: { environments: ['dev'], … }, error: null }
 * //                       // broken file => { config: null, error: Error('…unrecognized key…') }
 */
export const readDoctorConfig = async (): Promise<DoctorConfig> => {
  try {
    resetInfraKitConfigCache()

    return { config: await getInfraKitConfig(), error: null }
  } catch (err) {
    return { config: null, error: err as Error }
  }
}

export const checkInfraKitConfigValid = (read: DoctorConfig): CheckResult => {
  const name = 'infra-kit config valid'

  if (read.error) return { name, status: 'fail', message: read.error.message }

  return {
    name,
    status: 'pass',
    message: 'infra-kit.json is valid (user overrides applied if present)',
  }
}

/** Every seam the three token checks touch — the store, the resolver, Doppler, and the file modes. */
export interface EnvTokenCheckDeps {
  /** Reads `tokens.json`. THROWS on a corrupt store (bad JSON / bad shape) — that throw is the diagnosis. */
  readStore?: () => Promise<TokenStore | null>
  /** Resolves one env's token (`INFRA_KIT_ENV_TOKEN` → store → throw). */
  resolveToken?: (env: string) => Promise<ResolvedEnvToken>
  /** Asks Doppler what a token actually is. Never throws; see {@link probeEnvToken}. */
  probe?: (args: { childEnv: NodeJS.ProcessEnv; project: string; config: string }) => Promise<EnvTokenProbe>
  storePath?: () => Promise<string>
  /** `null` = the path does not exist. */
  statPath?: (target: string) => fs.Stats | null
  chmodPath?: (target: string, mode: number) => void
  /**
   * Reads `INFRA_KIT_ENV_TOKEN` — the CI / agent channel. A SEAM rather than a direct `process.env`
   * read so the store checks are deterministic under test: a developer whose shell has already
   * auto-loaded an env would otherwise run the suite with the variable set and silently exercise the
   * skip branch instead of the one under assertion.
   */
  readEnvToken?: () => string | undefined
}

/** `tokens.json` holds live credentials: owner-only, and owner-only traversal to reach it. */
const TOKEN_FILE_MODE = 0o600
const TOKEN_DIR_MODE = 0o700

/** One env's token as doctor sees it: WHERE it came from, never WHAT it is. */
interface EnvTokenEntry {
  env: string
  /** `null` = no token resolves for this env. */
  source: EnvTokenSource | null
}

/**
 * `env <name>: token (store)` / `env <name>: no token`, for every configured environment. The source
 * ONLY — a doctor line is printed to a terminal, pasted into a bug report, and returned under `--json`,
 * so the one thing it can never carry is the token itself.
 *
 * @example
 * describeEntries([{ env: 'dev', source: 'store' }, { env: 'prod', source: null }])
 * // => 'dev: token (store), prod: no token'
 */
const describeEntries = (entries: EnvTokenEntry[]): string => {
  return entries
    .map((entry) => {
      const held = entry.source === null ? 'no token' : `token (${entry.source})`

      return `${entry.env}: ${held}`
    })
    .join(', ')
}

/** Resolve each env's token to a SOURCE, collapsing "no token" (a throw) into `source: null`. */
const resolveEntries = async (
  environments: string[],
  resolveToken: NonNullable<EnvTokenCheckDeps['resolveToken']>,
): Promise<EnvTokenEntry[]> => {
  return Promise.all(
    environments.map(async (env): Promise<EnvTokenEntry> => {
      try {
        const { source } = await resolveToken(env)

        return { env, source }
      } catch {
        return { env, source: null }
      }
    }),
  )
}

/**
 * Which envs have a service token, and is the one that MATTERS among them?
 *
 * Under token-only auth the `envAutoLoad.config` env is load-bearing: no token there means the
 * developer's shell silently stops getting its environment, so that one is a FAIL. Every other env is
 * a listing line, not a verdict — a developer legitimately holds a `dev` token and no `prod` one, and
 * a doctor that failed on that would train everyone to ignore it.
 *
 * The gap it names is a store that holds tokens, just not the load-bearing one. A store that holds
 * NOTHING is {@link checkTokenStorePresent}'s failure and is deferred to it — see the branch below.
 *
 * @example
 * await checkEnvTokensConfigured({ config, error: null })
 * // => { name: 'env tokens configured', status: 'pass', message: 'auto-load env "dev": token (store). dev: token (store), prod: no token' }
 */
export const checkEnvTokensConfigured = async (
  read: DoctorConfig,
  deps: EnvTokenCheckDeps = {},
): Promise<CheckResult> => {
  const name = 'env tokens configured'
  const readStore = deps.readStore ?? readTokenStore
  const resolveToken = deps.resolveToken ?? resolveEnvToken

  if (!read.config) {
    return { name, status: 'pass', message: 'Skipped — infra-kit config could not be read (see config check)' }
  }

  // A corrupt store throws for EVERY env, which would otherwise render as "no token anywhere" — the
  // same symptom as a fresh machine, with a completely different fix. Surface the store's own
  // (actionable) error instead, and let the remaining checks still run.
  //
  // There is no longer a "store belongs to another repo" case to report here: the store carries no
  // `repoRoot` (see `lib/env-tokens`), so a hand-written store loads and a basename collision between
  // two checkouts is an accepted risk, not a diagnosis. Do not add a branch back for it.
  let store: TokenStore | null

  try {
    store = await readStore()
  } catch (err) {
    return { name, status: 'fail', message: `Token store unreadable — ${(err as Error).message}` }
  }

  // The env universe is the union of what the workflows declare and what we hold tokens for — see
  // `lib/project-envs`. It replaces `config.environments`, which was a hand-maintained third copy.
  const envs = await listProjectEnvNames()
  const autoLoadEnv = read.config.envAutoLoad?.config

  // The auto-load env is load-bearing whether or not anything declares it: it is what the shell tries
  // to load. Probe it even when no workflow names it, so "no token for it" beats "we never looked".
  const universe = autoLoadEnv && !envs.includes(autoLoadEnv) ? [...envs, autoLoadEnv] : envs

  const entries = await resolveEntries(universe, resolveToken)
  const listing = describeEntries(entries)

  if (autoLoadEnv === undefined) {
    return { name, status: 'pass', message: `No envAutoLoad configured — no env is load-bearing. ${listing}` }
  }

  const autoLoadEntry = entries.find((entry) => {
    return entry.env === autoLoadEnv
  })

  if (!autoLoadEntry || autoLoadEntry.source === null) {
    // A store that holds NOTHING (absent, or hand-edited down to `{ envs: {} }`) is already the FAIL
    // of `tokens.json present`, with the same root cause and the same fix command — so this would be
    // the SECOND red line for one problem, on the most ordinary broken setup there is (a fresh
    // checkout that configures `envAutoLoad`). The gap this check exists to name is the narrower one:
    // a store that holds tokens, just not for the load-bearing env. Same deferral as `tokens.json
    // perms` below and `env token valid` above — one problem, one line.
    if (store === null || Object.keys(store.envs).length === 0) {
      return { name, status: 'pass', message: 'Skipped — there is no token store to read (see tokens.json present)' }
    }

    return {
      name,
      status: 'fail',
      message:
        `No Doppler service token for the auto-load env "${autoLoadEnv}" — your shell env will not load. ` +
        `Fix: run \`infra-kit env-token-set ${autoLoadEnv}\`. ${listing}`,
    }
  }

  return {
    name,
    status: 'pass',
    message: `auto-load env "${autoLoadEnv}": token (${autoLoadEntry.source}). ${listing}`,
  }
}

/** The verdict for each probe outcome. `unreachable` is a PASS — see {@link checkEnvTokenValid}. */
const PROBE_VERDICT: Record<EnvTokenProbe['outcome'], { status: CheckResult['status']; describe: string }> = {
  valid: { status: 'pass', describe: 'live and correctly scoped' },
  revoked: { status: 'fail', describe: 'REJECTED by Doppler (revoked or invalid)' },
  'mis-scoped': { status: 'fail', describe: 'live but scoped to a DIFFERENT config' },
  unreachable: { status: 'pass', describe: 'could not be checked (Doppler unreachable)' },
}

/**
 * Is the auto-load env's token actually LIVE and correctly SCOPED? The only check here that leaves the
 * machine, and the only one that can tell a developer why their shell went quiet.
 *
 * An UNREACHABLE probe passes, deliberately: a network failure proves nothing about a token, and a
 * doctor that reported "your token is revoked" to a developer on a plane would be worse than one that
 * said nothing. The same `null`-means-couldn't-tell contract the Doppler listings always carried.
 *
 * @example
 * await checkEnvTokenValid({ config, error: null })
 * // => { name: 'env token valid', status: 'fail', message: 'The token for env "dev" is live but scoped to a DIFFERENT config …' }
 */
export const checkEnvTokenValid = async (read: DoctorConfig, deps: EnvTokenCheckDeps = {}): Promise<CheckResult> => {
  const name = 'env token valid'
  const resolveToken = deps.resolveToken ?? resolveEnvToken
  const probe = deps.probe ?? probeEnvToken

  if (!read.config) {
    return { name, status: 'pass', message: 'Skipped — infra-kit config could not be read (see config check)' }
  }

  const env = read.config.envAutoLoad?.config

  if (env === undefined) {
    return { name, status: 'pass', message: 'Skipped — no envAutoLoad env to probe' }
  }

  let token: string

  try {
    token = (await resolveToken(env)).token
  } catch {
    // Already the FAIL of `env tokens configured`; repeating it here would double-count one problem.
    return { name, status: 'pass', message: `Skipped — no token for env "${env}" (see env tokens configured)` }
  }

  const project = read.config.envManagement.config.name
  const result = await probe({ childEnv: buildDopplerChildEnv(token), project, config: env })
  const verdict = PROBE_VERDICT[result.outcome]
  const suffix =
    result.outcome === 'revoked' || result.outcome === 'mis-scoped'
      ? ` Fix: run \`infra-kit env-token-set ${env}\` with a token scoped to "${env}".`
      : ''

  return {
    name,
    status: verdict.status,
    message: `The token for env "${env}" (project "${project}") is ${verdict.describe}.${suffix}`,
  }
}

/** The live `INFRA_KIT_ENV_TOKEN`, or `undefined`. An EMPTY value is a MISS — the resolver's rule. */
const defaultReadEnvToken = (): string | undefined => {
  return process.env[INFRA_KIT_ENV_TOKEN_VAR] || undefined
}

/**
 * Does this project HOLD any Doppler service token at all?
 *
 * The FIRST question in this section, and the only one that is repo-shaped rather than env-shaped.
 * Fails when `~/.infra-kit/projects/<repo>/tokens.json` is missing OR holds zero envs. Two states
 * are deliberately NOT failures: `INFRA_KIT_ENV_TOKEN` set (the CI / agent channel takes
 * precedence over the store and needs no home config — see {@link INFRA_KIT_ENV_TOKEN_VAR}), and a
 * store that THROWS (`env tokens configured` already reports that one).
 *
 * @example
 * await checkTokenStorePresent()
 * // => { name: 'tokens.json present', status: 'fail', message: 'No token store at ~/.infra-kit/projects/api/tokens.json …' }
 */
// Every project this CLI drives authenticates through that store, so a checkout without one cannot
// load an env, deploy, or read a secret — whatever `envAutoLoad` happens to say. Before this check
// existed that state was reported as THREE passes (`env tokens configured` passes outright when no
// `envAutoLoad` is configured, and the other two skip), so a green report meant nothing on exactly
// the machine that needed the report most.
//
// An EMPTY store fails alongside a missing one: `env-token-set` never writes `{ envs: {} }`, so a
// store with no envs is a hand-edit or an `env-token-remove` of the last token — functionally the
// same as no file, and it must not read as "present, therefore fine".
//
// Failing on `INFRA_KIT_ENV_TOKEN` would redden every CI run; repeating the throwing-store failure
// here would double-count one problem.
export const checkTokenStorePresent = async (deps: EnvTokenCheckDeps = {}): Promise<CheckResult> => {
  const name = 'tokens.json present'
  const readStore = deps.readStore ?? readTokenStore
  const storePath = deps.storePath ?? getTokenStorePath
  const readEnvToken = deps.readEnvToken ?? defaultReadEnvToken

  if (readEnvToken()) {
    return {
      name,
      status: 'pass',
      message: `Skipped — ${INFRA_KIT_ENV_TOKEN_VAR} is set; that channel takes precedence over the store`,
    }
  }

  // Display only — every message below is read by a human, and nothing here touches the path again.
  let displayPath: string

  try {
    displayPath = tildify(await storePath())
  } catch {
    return { name, status: 'pass', message: 'Skipped — the token store path could not be resolved' }
  }

  let store: TokenStore | null

  try {
    store = await readStore()
  } catch {
    return { name, status: 'pass', message: `The store at ${displayPath} is unreadable (see env tokens configured)` }
  }

  const envs = store === null ? [] : Object.keys(store.envs)

  if (envs.length === 0) {
    const state = store === null ? `No token store at ${displayPath}` : `${displayPath} holds no tokens`

    return {
      name,
      status: 'fail',
      message:
        `${state} — every project needs one to authenticate. ` +
        `Fix: run \`infra-kit env-token-set <env>\`. CI / agents: set ${INFRA_KIT_ENV_TOKEN_VAR} instead.`,
    }
  }

  return { name, status: 'pass', message: `${displayPath} holds ${envs.length} token(s): ${envs.join(', ')}` }
}

/** `-rw-------` / `drwx------` — the permission bits of a path, or `null` when it does not exist. */
const modeOf = (target: string, statPath: NonNullable<EnvTokenCheckDeps['statPath']>): number | null => {
  const stats = statPath(target)

  return stats === null ? null : stats.mode & 0o777
}

/**
 * The token store is a credential file, so it must be 0600, reachable only through 0700 directories.
 * `writeTokenStore` sets all four every time it writes — so a violation here means something ELSE
 * touched them (an editor's save-and-rename, a `cp -r`, a synced dotfiles dir), which is exactly the
 * case a self-healing writer cannot fix on its own.
 *
 * Skipped when the store does not exist: a machine with no tokens has nothing to protect, and CI
 * (`INFRA_KIT_ENV_TOKEN`) never writes one.
 *
 * @example
 * await checkTokenStorePerms(false)
 * // => { name: 'tokens.json perms', status: 'fail', message: '~/.infra-kit/projects/api/tokens.json is 0644, expected 0600 …' }
 */
export const checkTokenStorePerms = async (fix: boolean, deps: EnvTokenCheckDeps = {}): Promise<CheckResult> => {
  const name = 'tokens.json perms'
  const storePath = deps.storePath ?? getTokenStorePath
  const statPath = deps.statPath ?? defaultStatPath
  const chmodPath = deps.chmodPath ?? fs.chmodSync

  let target: string

  try {
    target = await storePath()
  } catch {
    return { name, status: 'pass', message: 'Skipped — the token store path could not be resolved' }
  }

  if (modeOf(target, statPath) === null) {
    return { name, status: 'pass', message: `No store to protect at ${tildify(target)} (see tokens.json present)` }
  }

  // Every directory on the way to the file, plus the file: a 0600 file inside a world-readable
  // directory chain is still a credential a `find` away.
  const projectDir = path.dirname(target)
  const projectsDir = path.dirname(projectDir)
  const userConfigDir = path.dirname(projectsDir)
  const audited: Array<{ target: string; expected: number; actual: number | null }> = [
    { target: userConfigDir, expected: TOKEN_DIR_MODE, actual: modeOf(userConfigDir, statPath) },
    { target: projectsDir, expected: TOKEN_DIR_MODE, actual: modeOf(projectsDir, statPath) },
    { target: projectDir, expected: TOKEN_DIR_MODE, actual: modeOf(projectDir, statPath) },
    { target, expected: TOKEN_FILE_MODE, actual: modeOf(target, statPath) },
  ]
  const loose = audited.filter((entry) => {
    return entry.actual !== null && entry.actual !== entry.expected
  })

  if (loose.length === 0) {
    return { name, status: 'pass', message: `${tildify(target)} is 0600 (0700 dirs)` }
  }

  const describe = loose
    .map((entry) => {
      return `${tildify(entry.target)} is ${formatMode(entry.actual!)}, expected ${formatMode(entry.expected)}`
    })
    .join('; ')

  if (!fix) {
    return {
      name,
      status: 'fail',
      message: `${describe}. Fix: run \`infra-kit doctor --fix\`, or chmod them by hand.`,
    }
  }

  for (const entry of loose) {
    chmodPath(entry.target, entry.expected)
  }

  return { name, status: 'pass', message: `Tightened ${loose.length} path(s): ${describe}` }
}

/** `0600`, `0755` — a mode's permission bits in the form a user types at `chmod`. */
const formatMode = (mode: number): string => {
  return `0${mode.toString(8).padStart(3, '0')}`
}

/** `fs.statSync` with "does not exist" as a value rather than a throw. */
const defaultStatPath = (target: string): fs.Stats | null => {
  try {
    return fs.statSync(target)
  } catch {
    return null
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
 * // { name: 'user override path', status: 'pass',
 * //   message: '~/.infra-kit/projects/api/infra-kit.json (2 override(s): ide, dev) — project: api' }
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
 * user-global config was renamed to `infra-kit.json`. The on-`setup` auto-rename
 * is the migration path, but a user who edits the file and never re-runs `setup`
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
      message: `Legacy user-global config.json found at ${tildify(legacyPath)} — run \`infra-kit setup --skip-tools\` to migrate it (your overrides are not being applied).`,
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

const IDE_PROBE_META: Record<IdeProvider, { command: string[]; label: string; failMsg: string }> = {
  cursor: {
    command: ['cursor', '--version'],
    label: 'Cursor',
    failMsg: 'Cursor is not installed. Install from: https://cursor.com/',
  },
}

const probeIde = async (provider: IdeProvider): Promise<IdeProbe> => {
  const meta = IDE_PROBE_META[provider]

  try {
    await quietShell()`${meta.command}`

    return { ok: true, label: meta.label, failMsg: meta.failMsg }
  } catch {
    return { ok: false, label: meta.label, failMsg: meta.failMsg }
  }
}

/**
 * Check that every editor configured under `ide` is installed. Probes each binary (`cursor`)
 * named by the ALREADY-READ config ({@link readDoctorConfig}). Passes only if all configured editors
 * are present; fails listing any that are missing. Informational pass when no IDE is configured or
 * the config can't be read — an unconfigured editor is a valid setup, and config validity is
 * reported separately by `checkInfraKitConfigValid`.
 *
 * @example
 * await checkIdeInstalled({ config: { ide: [{ provider: 'cursor' }] }, error: null })
 * // => { name: 'ide installed', status: 'pass', message: 'Installed: Cursor' }
 */
export const checkIdeInstalled = async (read: DoctorConfig): Promise<CheckResult> => {
  const name = 'ide installed'

  if (!read.config) {
    return { name, status: 'pass', message: 'Skipped — infra-kit config could not be read (see config check)' }
  }

  const providers = resolveConfiguredIdes(read.config).map((ide) => {
    return ide.provider
  })

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

/** A plain `major.minor.patch` version — the only shape the semver comparator below can order. */
const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/

/**
 * True when `candidate` is a strictly lower version than `current`.
 *
 * Ordering is delegated to {@link sortVersions}, which is `v`-prefixed and SemVer-only, so both
 * sides are prefixed for the call and anything that is not a bare `major.minor.patch` is reported
 * as NOT older: a block written by a prerelease or otherwise unparseable build must never be
 * counted as stale on the strength of a `NaN` comparison.
 */
const isOlderVersion = (candidate: string, current: string): boolean => {
  if (candidate === current) return false
  if (!PLAIN_SEMVER.test(candidate) || !PLAIN_SEMVER.test(current)) return false

  return sortVersions([`v${candidate}`, `v${current}`])[0] === `v${candidate}`
}

/**
 * Versions recorded by well-formed package guidance blocks that predate the running CLI.
 *
 * `discoverPackages` is wrapped because it reads `pnpm-workspace.yaml` with an unguarded
 * `readFile` + `yaml.parse`: a single-package repo (and the doctor inventory fixture, a temp
 * directory holding only `infra-kit.json` and `CLAUDE.md`) has no such file, and an ENOENT here
 * would propagate out of `doctor()` and crash the command. Any throw degrades to "no packages".
 * Read-only by construction — nothing on this path writes.
 */
const collectStalePackageVersions = async (root: string, current: string): Promise<string[]> => {
  let packageDirs: string[]

  try {
    packageDirs = await discoverPackages(root)
  } catch {
    return []
  }

  const stale: string[] = []

  for (const dir of packageDirs) {
    const inspection = inspectPackageGuidance(readGuidanceFile(path.join(dir, 'CLAUDE.md')))

    if (inspection.state !== 'ok') continue
    if (inspection.version === undefined) continue
    if (isOlderVersion(inspection.version, current)) stale.push(inspection.version)
  }

  return stale
}

/**
 * The staleness sentence appended to the `CLAUDE.md block` message, or `''` when nothing is behind.
 *
 * Deliberately a message-only dimension: `CheckResult.status` is `'pass' | 'fail'` with no warn
 * state, and drift in per-package blocks is not a broken machine, so this never changes the
 * check's status.
 */
const packageGuidanceStaleness = async (root: string, current: string): Promise<string> => {
  const stale = await collectStalePackageVersions(root, current)

  if (stale.length === 0) return ''

  const oldest = sortVersions(
    stale.map((version) => {
      return `v${version}`
    }),
  )[0]!.slice(1)

  return ` — ${stale.length} package guidance blocks were generated by an older infra-kit (oldest ${oldest}, current ${current}) — run: infra-kit audit --fix --all`
}

/**
 * Check that the repo agent-instruction guidance managed by `infra-kit setup` exists:
 * the guidance block in `CLAUDE.md`. Presence only. Repo-gated: returns no checks
 * when run outside an infra-kit repo so doctor never crashes there. A repo that
 * predates the AGENTS.md→CLAUDE.md migration will report this check as failing until
 * `infra-kit setup` is re-run.
 *
 * The message also carries a read-only per-package staleness report (see
 * {@link packageGuidanceStaleness}). It rides on THIS check rather than a new one on purpose:
 * a new check name would have to be added to `SECTION_MEMBERS` in `report.ts` and to the
 * inventory fixture's counts, and `'CLAUDE.md block'` is already sectioned.
 */
export const checkAgentFiles = async (): Promise<CheckResult[]> => {
  let mainConfigPath: string

  try {
    mainConfigPath = (await getInfraKitConfigPaths()).main
  } catch {
    return []
  }

  if (!fs.existsSync(mainConfigPath)) return []

  const root = path.dirname(mainConfigPath)
  const claudePath = path.join(root, 'CLAUDE.md')
  const content = fs.existsSync(claudePath) ? fs.readFileSync(claudePath, 'utf-8') : ''
  const present = hasManagedBlock(content, AGENTS_MARKER_START, AGENTS_MARKER_END)
  const message = present
    ? 'CLAUDE.md block present'
    : 'infra-kit block missing from CLAUDE.md. Run: infra-kit setup --skip-tools'
  const staleness = await packageGuidanceStaleness(root, packageJson.version)

  return [
    {
      name: 'CLAUDE.md block',
      status: present ? 'pass' : 'fail',
      message: `${message}${staleness}`,
    },
  ]
}

/**
 * The repo root the host-state checks below are asked about, or `null` outside an infra-kit repo.
 * Same gate as {@link checkAgentFiles}: the presence of `infra-kit.json` at the root.
 */
const resolveCheckedRepoRoot = async (): Promise<string | null> => {
  try {
    const mainConfigPath = (await getInfraKitConfigPaths()).main

    return fs.existsSync(mainConfigPath) ? path.dirname(mainConfigPath) : null
  } catch {
    return null
  }
}

/**
 * The one freshness line this row may carry: the marketplace clone is AHEAD of the copy sessions
 * actually load (the record's cache `installPath`, measured in plan §6.1 S0-7(b)). Empty when the
 * clone is absent, unreadable, equal or behind — a "served ahead" clone is a stale fetch, not a lag.
 *
 * Deliberately no comparison against the CLI's own version: the plugin bump is a separate commit
 * after every lockstep release, so served-vs-CLI legitimately drifts for hours at every release and
 * a line printed that often is one nobody reads (plan §8.0 0c, P6).
 */
const fetchedNotAppliedAdvisory = (served: string): string => {
  const fetched = readMarketplacePluginVersion()

  if (fetched === null || !isNewerVersion(fetched, served)) return ''

  return ` — plugin ${fetched} is fetched but not applied. Run: ${PLUGIN_UPDATE_COMMAND}`
}

/** The version row, reported only for an install that covers THIS project. */
const claudePluginVersionCheck = (state: PluginInstallState): CheckResult => {
  const version = state.kind === 'installed' ? readInstalledPluginVersion(state.installation) : null

  return {
    name: 'plugin version',
    status: version === null ? 'fail' : 'pass',
    message:
      version === null
        ? 'No infra-kit plugin installed for this project to read a version from'
        : `Plugin ${PLUGIN_KEY} version ${version}${fetchedNotAppliedAdvisory(version)}`,
  }
}

/** How many other projects the `elsewhere` message names before it summarises the rest as a count. */
const MAX_LISTED_PROJECTS = 3

/**
 * Where this `doctor` was invoked from — the inputs of the subdirectory advisory on `plugin installed`.
 *
 * A project-scope plugin and the repo's `.claude/settings.json` hooks load from the directory Claude
 * Code was LAUNCHED in, and only from there (measured, plan §3.2 F5 / §12 S1-6); a session started in
 * `apps/` has neither. `doctor` cannot see the launch directory, so it reads two proxies for it:
 * `projectDir` (`CLAUDE_PROJECT_DIR`, which Claude Code sets to the launch directory for hooks and
 * set for the retired served tool, never for a Bash call — when present, `≠ gitRoot` is the PRECISE
 * test) and `cwd` (all the typed CLI has — a hint,
 * since a root-launched session whose model `cd`s into `apps/` and types `doctor` is not a
 * subdirectory session, hence the hedged wording).
 */
export interface DoctorOrigin {
  /** `CLAUDE_PROJECT_DIR`, or `null` when unset — the typed CLI. */
  projectDir: string | null
  cwd: string
  /** The git toplevel, or `null` outside a repo (no advisory can be made). */
  gitRoot: string | null
}

/** Realpath'd on both sides: git answers `/private/var/…` where the shell says `/var/…` on macOS. */
const samePath = (a: string, b: string): boolean => {
  return safeRealpath(a) === safeRealpath(b)
}

/**
 * The sentence appended to `plugin installed` when this session may have been launched below the
 * root, or `''`. Message-only — status is a fact about the install record, not about where the
 * caller stands (plan §3.3 A-2 mitigation).
 */
const subdirectoryAdvisory = (origin: DoctorOrigin | undefined): string => {
  if (origin === undefined || origin.gitRoot === null) return ''

  const root = tildify(origin.gitRoot)

  if (origin.projectDir !== null) {
    if (samePath(origin.projectDir, origin.gitRoot)) return ''

    // `realpath` on the child too (`isWithin` resolves the parent only): `/var` vs `/private/var`.
    const where = isWithin(origin.gitRoot, safeRealpath(origin.projectDir), safeRealpath)
      ? 'below the repo root'
      : 'not this checkout'

    return ` — this session was launched from ${tildify(origin.projectDir)}, ${where}: the plugin and this repo's .claude/settings.json hooks load only from ${root} (measured); restart Claude Code there`
  }

  if (samePath(origin.cwd, origin.gitRoot)) return ''

  return ` — if Claude Code was launched from ${tildify(origin.cwd)} rather than ${root}, it loaded neither the plugin nor this repo's hooks; launch it at ${root}`
}

/** The install row. `elsewhere` names the projects the existing records DO cover, which is the fix. */
const claudePluginInstalledCheck = (state: PluginInstallState, origin: DoctorOrigin | undefined): CheckResult => {
  const name = 'plugin installed'
  const advisory = subdirectoryAdvisory(origin)

  if (state.kind === 'installed') {
    const { scope, projectPath } = state.installation
    const where = projectPath === null ? '' : `, ${tildify(projectPath)}`

    return {
      name,
      status: 'pass',
      message: `Plugin ${PLUGIN_KEY} installed (${scope ?? 'unknown'} scope${where})${advisory}`,
    }
  }

  if (state.kind === 'absent') {
    return {
      name,
      status: 'fail',
      message: `Plugin ${PLUGIN_KEY} is not installed. Run: ${PLUGIN_INSTALL_COMMAND}${advisory}`,
    }
  }

  // Capped at three: a machine that has rolled this out to every repo carries a dozen records, and a
  // row naming all of them buries the one thing the reader needs — that none of them is this project.
  const paths = state.installations.map((entry) => {
    return entry.projectPath === null ? '(unnamed project)' : tildify(entry.projectPath)
  })
  const extra = paths.length - MAX_LISTED_PROJECTS
  const suffix = extra > 0 ? ` and ${extra} more` : ''
  const others = `${paths.slice(0, MAX_LISTED_PROJECTS).join(', ')}${suffix}`

  return {
    name,
    status: 'fail',
    message: `Plugin ${PLUGIN_KEY} is installed for ${others} only, not this project. Run: ${PLUGIN_INSTALL_COMMAND}${advisory}`,
  }
}

/**
 * Is the `claude` binary on PATH? The PREREQUISITE row for everything below it: `infra-kit setup`
 * installs the plugin by driving `claude plugin install`, so on a machine without that binary the
 * three rows that follow are failing for a reason none of their own messages names.
 *
 * Deliberately NOT wired into the exit code — only `plugin installed` is. A machine that has chosen
 * not to install Claude Code is reporting a fact, not a broken setup.
 *
 * @example
 * await checkClaudeCli() // => { name: 'claude CLI', status: 'pass', message: 'Installed: claude' }
 */
export const checkClaudeCli = (): Promise<CheckResult> => {
  return checkCommand(
    'claude CLI',
    ['claude', '--version'],
    'Installed: claude',
    'claude CLI not found on PATH — `infra-kit setup` cannot install the plugin; install Claude Code first',
  )
}

/**
 * What the SERVED plugin copy carries by way of an MCP server — which, since the plugin went
 * skills-only, is the STALE state: a copy that still ships `.mcp.json` predates the split and would
 * spawn a server the skills no longer talk to.
 *
 * The served copy is the install record's `installPath` (`~/.claude/plugins/cache/…/<v>/`), NOT the
 * marketplace clone: the clone is what `claude plugin update` fetches, the record is what a session
 * loads (measured, archived plan docs/archive/mcp/mcp-via-plugin-migration-plan.md §6.1 S0-7(b)) — so
 * a clone that is ahead of the record must not change this verdict. Capability-keyed on purpose: the
 * row reads the served `.mcp.json`, never a version floor, so an older copy hand-stripped of the file
 * passes and a newer one that regrew it is reported.
 */
export type ServedPluginServer =
  | { kind: 'not-installed' }
  /** No `.mcp.json` in the served copy — as shipped since the split, or a record with no path. */
  | { kind: 'skills-only'; version: string | null }
  /** A `.mcp.json` is there: a copy from before the split, whatever it keys the server under. */
  | { kind: 'stale-server'; version: string | null; keys: string[] }

const readServedJson = (installPath: string, ...segments: string[]): unknown => {
  try {
    return JSON.parse(fs.readFileSync(path.join(installPath, ...segments), 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Read the served copy's `.mcp.json`. Any `mcpServers` object at all is `stale-server` — the plugin
 * as shipped has no such file, so what the entries say is a detail for the message, not a verdict.
 *
 * @example
 * inspectServedPluginServer(resolvePluginInstall({ projectPath: '/repo' })) // => { kind: 'skills-only', version: '<served>' }
 */
export const inspectServedPluginServer = (state: PluginInstallState): ServedPluginServer => {
  if (state.kind !== 'installed') return { kind: 'not-installed' }

  const version = readInstalledPluginVersion(state.installation)
  const { installPath } = state.installation

  if (installPath === null) return { kind: 'skills-only', version }

  const mcp = readServedJson(installPath, MCP_FILE_NAME)
  const servers = mcp !== null && typeof mcp === 'object' ? (mcp as Record<string, unknown>)[SERVERS_KEY] : undefined

  if (servers === undefined || servers === null || typeof servers !== 'object') return { kind: 'skills-only', version }

  return { kind: 'stale-server', version, keys: Object.keys(servers as Record<string, unknown>) }
}

/** `Plugin <key> <version>` with a readable stand-in when no version could be read. */
const describeServedPlugin = (version: string | null): string => {
  const suffix = version === null ? '(version unreadable)' : version

  return `Plugin ${PLUGIN_KEY} ${suffix}`
}

/**
 * The `plugin MCP server` row, kept under its old name so a pasted report still lines up: does the
 * served plugin STILL carry an MCP server? Skills-only is healthy; a copy with `.mcp.json` is stale
 * and passes with the update advisory — it works, on the old surface, until it is updated.
 *
 * Fixes are the plugin's own commands, never a `.mcp.json` write: `claude plugin update` (which
 * `infra-kit setup` drives) is what advances the record a session loads.
 */
const claudePluginServerCheck = (served: ServedPluginServer): CheckResult => {
  const name = 'plugin MCP server'

  if (served.kind === 'not-installed') {
    return {
      name,
      status: 'fail',
      message: `No infra-kit plugin installed for this project — no skills to drive the CLI. Run: ${PLUGIN_INSTALL_COMMAND}`,
    }
  }

  if (served.kind === 'stale-server') {
    const under = served.keys.length === 0 ? '' : ` (under "${served.keys.join('", "')}")`

    return {
      name,
      status: 'pass',
      message: `${describeServedPlugin(served.version)} still carries an MCP server in its ${MCP_FILE_NAME}${under} — a copy from before the plugin went skills-only. Update it: infra-kit setup (or ${PLUGIN_UPDATE_COMMAND}), then restart Claude Code`,
    }
  }

  return {
    name,
    status: 'pass',
    message: `${describeServedPlugin(served.version)} is skills-only — no ${MCP_FILE_NAME}, as shipped; the /infra-kit:* skills drive the infra-kit CLI`,
  }
}

/**
 * The five host-state rows about the `infra-kit` Claude Code plugin: is its marketplace registered
 * on this machine, is the plugin installed, which version, is the served copy skills-only, and which
 * CLI is reporting it.
 *
 * All five are emitted whatever `root` is, so the row set never changes shape between directories.
 * `root` narrows the VERDICT only: it is the project a project-scope install has to name to count.
 * `origin` feeds the subdirectory advisory on `plugin installed` and nothing else.
 *
 * @example
 * checkClaudePlugin('/repo')
 * // => [{ name: 'marketplace registered', … }, { name: 'plugin installed', … }, … ]
 */
export const checkClaudePlugin = (root: string | null, origin?: DoctorOrigin): CheckResult[] => {
  const state = resolvePluginInstall(root === null ? {} : { projectPath: root })
  const registered = isMarketplaceRegistered()

  return [
    {
      name: 'marketplace registered',
      status: registered ? 'pass' : 'fail',
      message: registered
        ? `Marketplace ${MARKETPLACE_NAME} is known to Claude Code`
        : `Marketplace ${MARKETPLACE_NAME} is not registered. Run: claude plugin marketplace add ${MARKETPLACE_REPO}`,
    },
    claudePluginInstalledCheck(state, origin),
    claudePluginVersionCheck(state),
    claudePluginServerCheck(inspectServedPluginServer(state)),
    { name: 'CLI version', status: 'pass', message: `infra-kit CLI ${packageJson.version}` },
  ]
}

/** The chore text for a leftover entry under `key`: what it spawns today, and the hand deletion that retires it. */
const deleteKeyAdvisory = (key: string): string => {
  return `${MCP_FILE_NAME} still registers "${key}" — delete this key: the plugin no longer serves an MCP server and the entry spawns a retired subcommand that exits immediately (Claude Code lists it as failed). Delete the "${key}" entry from ${MCP_FILE_NAME} by hand in a PR, keeping its siblings (\`claude mcp remove ${key} --scope project\` also works but re-indents the file)`
}

/**
 * One message per `.mcp.json` verdict. `absent` / `missing-file` are the healthy state, `stale` and
 * `wrong-key` the chore spelled out (a chore is not red), `unparseable` the one fault — built by the
 * caller, which has the key for `wrong-key`.
 */
const MCP_MESSAGES: Record<Exclude<McpRegistration['kind'], 'wrong-key'>, string> = {
  stale: deleteKeyAdvisory(MARKETPLACE_NAME),
  absent: `${MCP_FILE_NAME} carries no "${MARKETPLACE_NAME}" key — nothing spawns the retired server`,
  'missing-file': `no ${MCP_FILE_NAME} at the repo root — nothing spawns the retired server`,
  unparseable: `Could not read ${SERVERS_KEY} from ${MCP_FILE_NAME} — fix the JSON and re-run`,
}

/**
 * The verdicts that do NOT fail the row: no key (with or without a file) and a leftover key under any
 * name — the stub keeps such a session working, so the deletion is a chore with no deadline.
 * Exit 1 stays scoped to `plugin installed` alone (`program.ts`), so none of this touches it.
 */
const MCP_NON_FAILING: ReadonlySet<McpRegistration['kind']> = new Set(['absent', 'missing-file', 'stale', 'wrong-key'])

/**
 * The `MCP server key` row: the repo's own `.mcp.json` against the retired infra-kit server, read-only.
 * No longer guarded on what the served plugin carries — the plugin serves nothing, so the repo's entry
 * is a leftover whichever plugin copy is installed.
 *
 * @example
 * checkMcpServerKey('/repo')
 * // => { name: 'MCP server key', status: 'pass', message: '.mcp.json still registers "infra-kit" — delete this key: …' }
 */
export const checkMcpServerKey = (root: string): CheckResult => {
  const name = 'MCP server key'
  const registration = inspectLegacyMcpRegistration(root)

  if (registration.kind === 'wrong-key') {
    return { name, status: 'pass', message: deleteKeyAdvisory(registration.key) }
  }

  return {
    name,
    status: MCP_NON_FAILING.has(registration.kind) ? 'pass' : 'fail',
    message: MCP_MESSAGES[registration.kind],
  }
}

/** The raw inputs, spelled out so a pasted row explains its own verdict. */
const describeAgentModeInputs = ({ env, stdinIsTTY, flag }: ResolveAgentModeInput): string => {
  const agentVar = env.INFRA_KIT_AGENT === undefined ? 'unset' : `= "${env.INFRA_KIT_AGENT}"`

  return [
    `CLAUDECODE ${env.CLAUDECODE === undefined ? 'unset' : 'set'}`,
    `INFRA_KIT_AGENT ${agentVar}`,
    `stdin ${stdinIsTTY ? 'is a TTY' : 'is not a TTY'}`,
    `--agent ${flag ? 'passed' : 'not passed'}`,
  ].join(', ')
}

/**
 * The `Agent mode` row: which source `resolveAgentModeSource` fires on for THIS shell, with the inputs
 * it read. Informational — always a pass — because neither answer is wrong: a human at a PTY and an
 * agent under Claude Code are both correct classifications, and what the row is for is the third case,
 * where someone expected one and got the other (a `!` shell reads as agent; an Orca terminal Claude Code
 * spawned reads as human).
 *
 * Pure over its input so the precedence table (`agent-mode.ts`) is what the test drives, not the
 * test runner's own environment.
 *
 * @example
 * checkAgentMode({ env: { CLAUDECODE: '1' }, stdinIsTTY: false, flag: false })
 * // => { name: 'Agent mode', status: 'pass', message: 'agent — CLAUDECODE is set and stdin is not a TTY (…)' }
 */
export const checkAgentMode = (input: ResolveAgentModeInput): CheckResult => {
  const name = 'Agent mode'
  const source = resolveAgentModeSource(input)
  const inputs = describeAgentModeInputs(input)
  const because = (): string => {
    if (source === 'flag') return 'the --agent flag, which beats every environment value'
    if (input.env.INFRA_KIT_AGENT === '1') return 'INFRA_KIT_AGENT=1'
    if (source === 'env') return 'CLAUDECODE is set and stdin is not a TTY'
    if (input.env.CLAUDECODE !== undefined && input.stdinIsTTY) {
      return 'CLAUDECODE is set but stdin is a TTY, so this is a terminal Claude Code spawned for a person'
    }
    if (input.env.INFRA_KIT_AGENT === '0') return 'INFRA_KIT_AGENT=0 suppresses the CLAUDECODE heuristic'

    return 'no source fires; pass --agent or set INFRA_KIT_AGENT=1 to drive this CLI as an agent'
  }

  return {
    name,
    status: 'pass',
    message: `${source === null ? 'human' : 'agent'} — ${because()} (${inputs})`,
  }
}

/** At most this many command names per pattern before `+N more`: a `Bash(infra-kit:*)` reaches ~20. */
const NAMED_COMMANDS_PER_HIT = 4

const describeReachedCommands = (commands: string[]): string => {
  const named = commands.slice(0, NAMED_COMMANDS_PER_HIT).join(', ')
  const rest = commands.length - NAMED_COMMANDS_PER_HIT

  return rest > 0 ? `${named} +${rest} more` : named
}

/**
 * The `Agent allowlist` row (plan §3.8): WARN when a `permissions.allow` pattern in either project
 * settings file reaches a mutating infra-kit command, naming the pattern and what it reaches. A prefix
 * allow is what lets an agent's `--yes` re-run go unprompted, so the row is the one place that
 * exposure is visible. Never a fail: the setting is legal, and `doctor` does not know the human did not
 * choose it deliberately.
 *
 * @example
 * checkAgentAllowlist('/repo-allowing-Bash(infra-kit:*)')
 * // => { name: 'Agent allowlist', status: 'warn', message: '.claude/settings.local.json allows "Bash(infra-kit:*)", which reaches …' }
 */
export const checkAgentAllowlist = (root: string): CheckResult => {
  const name = 'Agent allowlist'
  const { present, unreadable, hits } = inspectAgentAllowlist(root)

  if (hits.length > 0) {
    const findings = hits.map((hit) => {
      return `${hit.file} allows "${hit.pattern}", which reaches ${hit.commands.length} mutating infra-kit command${hit.commands.length === 1 ? '' : 's'} (${describeReachedCommands(hit.commands)})`
    })

    return {
      name,
      status: 'warn',
      message: `${findings.join('; ')} — a prefix allow lets an agent run the --yes re-run of a mutating command unprompted; narrow it to read-only argv (e.g. Bash(infra-kit release list:*)) so the host prompts for the rest`,
    }
  }

  if (unreadable.length > 0) {
    return {
      name,
      status: 'warn',
      message: `Could not read permissions.allow from ${unreadable.join(' and ')} — fix the JSON and re-run; until then the allowlist is unchecked`,
    }
  }

  if (present.length === 0) {
    return {
      name,
      status: 'pass',
      message: `no ${SETTINGS_FILES.join(' or ')} at the repo root — no Bash allow pattern to reach a mutating infra-kit command`,
    }
  }

  return {
    name,
    status: 'pass',
    message: `no permissions.allow pattern in ${present.join(' or ')} reaches a mutating infra-kit command`,
  }
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

/** Every process/fs seam the portless checks touch, injected so tests never reach the real daemon. */
export interface PortlessCheckDeps extends ServiceTargetDeps {
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
  seams: ServiceInstallSeams,
): Promise<CheckResult> => {
  const name = `portless serving TLS on :${DEFAULT_DEV_PROXY_PORT}`
  const serving = await isProxyServing(DEFAULT_DEV_PROXY_PORT, true)

  if (!serving) {
    return {
      name,
      status: 'fail',
      message: `No portless daemon is serving HTTPS on :${DEFAULT_DEV_PROXY_PORT}. Install it once (needs root): \`${serviceInstallCommand(bin, seams)}\`.`,
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
  seams: ServiceInstallSeams,
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
      message: `The daemon is serving a certificate that does not chain to ${tildify(caPath)}. Its CA was regenerated — run \`${trustCmd(bin)}\`, or reinstall: \`${serviceInstallCommand(bin, seams)}\`.`,
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

const SERVICE_TARGET_NAME = 'portless service target'

/**
 * `warn` rendered in the only vocabulary {@link CheckResult} has: `status` is `'pass' | 'fail'` with no
 * third state (see {@link packageGuidanceStaleness}), so an advisory is a green row whose message leads
 * with `Warning —`. Every warn in the service-target table is by design NOT a broken machine — an old Node
 * that still exists, a version-specific script path that still exists, a daemon one release behind — so a
 * red row would tell a working user to go run sudo now.
 */
const warnRow = (message: string): CheckResult => {
  return { name: SERVICE_TARGET_NAME, status: 'pass', message: `Warning — ${message}` }
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
interface ServiceTargetSeams extends Required<ServiceInstallSeams> {
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

const PORTLESS_NODE_NAME = 'portless node'
/** How the rows NAME the file — prose, so `~` is right here; the commands they print never use it (§5.4). */
const NODE_DISPLAY = '~/.infra-kit/node'

/** The `portless node` row and what every later row renders through. `sidecar` is non-null iff `stableNode` is. */
interface PortlessNodeVerdict {
  row: CheckResult
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
      row: { name: PORTLESS_NODE_NAME, status: 'pass', message: 'Skipped — no portless OS service on this platform' },
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
      status: 'pass',
      message: `Skipped — not a global install; the global infra-kit keeps ${NODE_DISPLAY} current`,
    },
  }
}

/**
 * The seams with the node verdict folded in — the ONE place it is resolved, so doctor's `:443`, CA-chain
 * and service-target rows and `setup`'s state all render the same `service install` line. Runs the node
 * row FIRST by construction: nothing below can read `stableNode` before it is set.
 */
const resolveHealthySeams = (
  deps: ServiceTargetDeps,
  bin: string,
): { seams: ServiceTargetSeams; node: CheckResult } => {
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
const daemonStartedAt = (seams: ServiceTargetSeams): Date | null => {
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
interface ServiceTargetOutcome {
  state: ServiceTargetState
  row: CheckResult
}

const drifted = (row: CheckResult): ServiceTargetOutcome => {
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
 * "Not installed" is a `Skipped —` pass (the `:443` row already says what to do), a file this reader
 * cannot make sense of is an advisory, never a throw.
 */
const checkPortlessServiceTarget = async (seams: ServiceTargetSeams): Promise<ServiceTargetOutcome> => {
  const filePath = serviceFilePath(seams.platform)

  if (filePath === null) {
    return {
      state: 'absent',
      row: {
        name: SERVICE_TARGET_NAME,
        status: 'pass',
        message: 'Skipped — no portless OS service file on this platform',
      },
    }
  }

  const content = seams.readServiceFile(filePath)

  if (content === null) {
    return {
      state: 'absent',
      row: {
        name: SERVICE_TARGET_NAME,
        status: 'pass',
        message: `Skipped — the OS service is not installed (no ${filePath})`,
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

/**
 * The portless block of doctor: is the HTTPS dev proxy installed, serving, trusted, and free of dead routes?
 * This is the diagnostic surface for the port-free HTTPS dev URLs — it is what tells a developer to run
 * `trust` (sudo-free) or the one-time `service install` (root), and it never conflates the two. Both are
 * printed via {@link formatPortlessCommand} — as `<node> <cli.js> …`, the only form that runs.
 *
 * Every check observes the daemon **on the wire or on our own disk** — never through portless's `proxy.port`
 * / `proxy.pid` / `proxy.tls` markers, which are process-global singletons that ANY daemon start rewrites and
 * ANY daemon stop deletes. Gating on them made doctor report a perfectly healthy `:443` daemon as dead.
 * (The one advisory that reads `proxy.pid` — {@link daemonStartedAt} — can only add a warning.)
 *
 * Reports only: nothing here is auto-run, and nothing requiring sudo ever could be.
 *
 * @example
 * await checkPortless()
 * // [{ name: 'portless installed', status: 'pass', message: '…' }, … 7 checks]
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
  // The node row runs first: its verdict is what every remediation below renders `service install` through.
  const { seams, node } = resolveHealthySeams(deps, bin)
  const routes = readRoutes()
  const serving = await checkPortlessServing(isProxyServing, bin, seams)
  // Nothing is answering on :443 — there is no certificate to validate, so the chain check would only add a
  // second, derivative failure to the one the user must fix first.
  const chain: CheckResult =
    serving.status === 'fail'
      ? { name: 'portless CA chain valid', status: 'pass', message: 'Skipped — no daemon to handshake with' }
      : await checkPortlessCaChain(handshake, routes, caPath, bin, seams)

  return [
    installed,
    node,
    (await checkPortlessServiceTarget(seams)).row,
    serving,
    chain,
    checkPortlessCaTrusted(caTrusted(), caPath, bin),
    await checkPortlessStaleRoutes(routes, isListening, bin),
  ]
}

/** Seams for {@link pruneStalePortlessRoutes}: the daemon, the wire and the process table, all injectable. */
export interface PruneRoutesDeps {
  routes?: () => PortlessRoute[]
  isListening?: (port: number) => Promise<boolean>
  /** Is a dev session alive? Defaults to a `ps` scan — see {@link isDevSessionRunning}. */
  devSessionRunning?: () => boolean
  removeAlias?: (name: string) => Promise<void>
}

/**
 * `doctor --fix`: remove the portless routes a dead dev-server left behind.
 *
 * The counterpart to {@link checkPortlessStaleRoutes}, which only ever REPORTS. Acting on the same
 * evidence needs one more guard, and it is not optional: "nothing is listening" cannot distinguish a dead
 * route from a UI whose vite has not bound its port yet (`assignUiPort` registers the alias, then
 * `getFreePort` RELEASES the port until vite boots — and a UI alias has no dev-context fragment to
 * corroborate it with). Every such false positive requires a dev session to be running, so a live dev
 * session withholds the prune entirely. See `prune-routes.ts` for the full argument.
 */
export const pruneStalePortlessRoutes = async (deps: PruneRoutesDeps = {}): Promise<CheckResult> => {
  const name = 'portless routes'
  const readRoutes = deps.routes ?? listRoutes
  const isListening = deps.isListening ?? defaultIsListening
  const devRunning = deps.devSessionRunning ?? isDevSessionRunning
  const routes = readRoutes()

  if (routes.length === 0) return { name, status: 'pass', message: 'No portless routes registered' }

  const probed = await Promise.all(
    routes.map(async (route) => {
      return { name: route.name, port: route.port, live: await isListening(route.port) }
    }),
  )
  const { prunable, withheld } = decidePrune(probed, devRunning())

  if (withheld.length > 0) {
    return {
      name,
      status: 'fail',
      message:
        `${withheld.length} route(s) look stale (${withheld.join(', ')}), but a dev session is running — ` +
        'a UI that has not bound its port yet is indistinguishable from a dead one, so nothing was removed. ' +
        'Stop dev and re-run `infra-kit doctor --fix`.',
    }
  }

  if (prunable.length === 0) {
    return { name, status: 'pass', message: `${routes.length} portless route(s), all live` }
  }

  const removeAlias = deps.removeAlias ?? createPortlessDriver().removeAlias

  // Serial, not `Promise.all`: each removal shells out to portless, which takes its own route lock.
  for (const alias of prunable) {
    await removeAlias(alias)
  }

  return {
    name,
    status: 'pass',
    message: `Removed ${prunable.length} stale portless route(s): ${prunable.join(', ')}`,
  }
}

/**
 * Check installation and authentication status of gh, doppler, and aws CLIs
 */
export const doctor = async (
  options: { fix?: boolean; probeDeps?: ProbeDeps; portlessDeps?: PortlessCheckDeps } = {},
) => {
  // ONE read, before anything is dispatched: the checks below used to reset the shared config cache
  // concurrently from inside the `Promise.all`. See `readDoctorConfig`.
  const read = await readDoctorConfig()
  // Started here and awaited inside `withDetail`, so the probe runs ALONGSIDE the ~95 checks rather
  // than in front of them.
  const details = probeDependencyDetails(options.probeDeps ?? defaultProbeDeps())
  const withDetail = async (id: DependencyId, check: Promise<CheckResult>): Promise<CheckResult> => {
    const [result, detail] = await Promise.all([check, details])
    const found = detail.get(id)

    return found === undefined ? result : { ...result, detail: found }
  }

  const baseChecks: CheckResult[] = await Promise.all([
    withDetail(
      'brew',
      checkCommand(
        'brew installed',
        specFor('brew').probeArgv,
        'Homebrew is installed',
        'Homebrew is not installed. Install from: https://brew.sh/',
      ),
    ),
    withDetail(
      'gh',
      checkCommand(
        'gh installed',
        specFor('gh').probeArgv,
        'GitHub CLI is installed',
        'GitHub CLI is not installed. Install from: https://cli.github.com/',
      ),
    ),
    checkCommand(
      'gh authenticated',
      ['gh', 'auth', 'status'],
      'GitHub CLI is authenticated',
      'GitHub CLI is not authenticated. Run: gh auth login',
    ),
    withDetail(
      'doppler',
      checkCommand(
        'doppler installed',
        specFor('doppler').probeArgv,
        'Doppler CLI is installed',
        'Doppler CLI is not installed. Install from: https://docs.doppler.com/docs/install-cli',
      ),
    ),
    withDetail(
      'aws',
      checkCommand(
        'aws installed',
        specFor('aws').probeArgv,
        'AWS CLI is installed',
        'AWS CLI is not installed. Install from: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
      ),
    ),
    checkCommand(
      'package manager installed',
      ['pnpm', '--version'],
      'Installed: pnpm',
      'pnpm is not installed. Install from: https://pnpm.io/installation',
    ),
    checkCommand(
      'typescript-language-server installed',
      ['typescript-language-server', '--version'],
      'typescript-language-server is installed',
      'typescript-language-server is not installed. Install from: https://github.com/typescript-language-server/typescript-language-server#installing',
    ),
    checkOrca(),
    Promise.resolve(checkZshrcInitialized()),
    Promise.resolve(checkZshenvInitialized()),
    checkWarmCache(),
    checkPnpmWorkspaceVirtualStore(),
    Promise.resolve(checkInfraKitConfigValid(read)),
    checkTokenStorePresent(),
    checkEnvTokensConfigured(read),
    checkEnvTokenValid(read),
    checkTokenStorePerms(options.fix ?? false),
    checkUserOverridePath(),
    checkLegacyUserGlobalConfig(),
    checkIdeInstalled(read),
  ])

  const portlessChecks = await checkPortless(options.portlessDeps)

  // `--fix` SWAPS the read-only stale-route check for the one that actually removes them, so the report
  // never prints a "stale route" failure beside the line that just cleaned it up.
  if (options.fix) {
    const pruned = await pruneStalePortlessRoutes()
    const index = portlessChecks.findIndex((check) => {
      return check.name === pruned.name
    })

    if (index >= 0) portlessChecks[index] = pruned
    else portlessChecks.push(pruned)
  }

  // The Claude Code plugin rows read `~/.claude/` and answer from anywhere; the `.mcp.json` and
  // allowlist rows are about a PROJECT and so are gated — but NOT on the same predicate as the
  // guidance check. Nothing writes the `infra-kit` key any more (the plugin is skills-only), so the
  // key row is a read-only report on a leftover entry, and both belong to any git toplevel that is not
  // `$HOME` (`resolveGitRoot`) — the same set `setup` inspects — while the guidance writer still
  // requires an `infra-kit.json` there. Gating them on `infra-kit.json` too would hide a leftover key
  // or a broad allow in exactly the repos that lack one.
  //
  // `resolveGitRoot` is also what keeps a blank `git rev-parse` from being answered: it returns
  // `null` rather than `''`, so the rows are omitted instead of rendered against `process.cwd()`.
  const repoRoot = await resolveCheckedRepoRoot()
  const gitRoot = await resolveGitRoot()
  const origin: DoctorOrigin = { projectDir: process.env.CLAUDE_PROJECT_DIR || null, cwd: process.cwd(), gitRoot }
  const pluginChecks = [
    // First in the section: the binary the install step drives. Read the prerequisite before the
    // rows whose failure it explains.
    await checkClaudeCli(),
    ...checkClaudePlugin(repoRoot, origin),
    ...(gitRoot === null ? [] : [checkMcpServerKey(gitRoot)]),
    // `flag` is the resolved source, not a re-parse of argv: `preAction` has already run, and a
    // `--agent` on this very invocation is what set it.
    checkAgentMode({ env: process.env, stdinIsTTY: process.stdin.isTTY === true, flag: agentMode.source === 'flag' }),
    ...(gitRoot === null ? [] : [checkAgentAllowlist(gitRoot)]),
  ]

  const checks: CheckResult[] = [...baseChecks, ...portlessChecks, ...(await checkAgentFiles()), ...pluginChecks]

  // NO rendering here, deliberately. `--json` must be one document on stdout with nothing human mixed
  // in, so the handler returns the payload and the CLI action owns presentation (see `report.ts`).
  //
  // `fixable` and `cliVersion` are here because this payload is what a non-terminal caller reads, and
  // neither is recoverable from it otherwise. The `--fix` hint lives in `report.ts`, which `--json`
  // skips entirely, and fixability is deliberately NOT derivable from a message — `portless routes`
  // names a MANUAL removal command in its failure text while `--fix` owns the row, so a caller
  // reading messages would send a user down the hand-removal path. `cliVersion` is a top-level field
  // rather than a parse of the `CLI version` row's message: a version floor is a comparison, and the
  // failure direction of a slipped parse is "assume the floor is met".
  const structuredContent = {
    checks: checks.map((c) => {
      // `detail` is carried unconditionally, `undefined` on the ~23 rows that have none: a conditional
      // spread would type the array as a UNION and make `row.detail` unreadable at every call site.
      // `JSON.stringify` drops an undefined value, so the rendered payload is identical either way.
      return {
        name: c.name,
        status: c.status,
        message: c.message,
        fixable: FIXABLE_NAMES.has(c.name),
        detail: c.detail,
      }
    }),
    // A warning is advisory by definition (see `CheckResult`), so it does not unset this.
    allPassed: checks.every((c) => {
      return c.status !== 'fail'
    }),
    cliVersion: packageJson.version,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

// MCP Tool Registration
export const doctorMcpTool = defineMcpTool({
  name: 'doctor',
  description:
    'Check installation and authentication status of gh, doppler, and aws CLIs. Read-only: a row marked fixable is one `infra-kit doctor --fix` repairs, and that flag is not reachable from this boundary — report such a row to the human instead.',
  inputSchema: {},
  outputSchema: {
    checks: z
      .array(
        z.object({
          name: z.string().describe('Name of the check'),
          status: z.enum(['pass', 'fail', 'warn']).describe('Check result; warn is advisory and never fails the run'),
          message: z.string().describe('Details about the check result'),
          fixable: z.boolean().describe('Whether `infra-kit doctor --fix` repairs this row'),
          // Present on the four dependency rows only. `status` answers "resolves on PATH"; this answers
          // the richer question beside it, which is why `present` and `onPath` are both here and can
          // disagree with each other.
          detail: z
            .object({
              manager: z.string().describe('Which package manager owns this install, read from its resolved path'),
              version: z.string().nullable().describe('The version the tool reported, or null'),
              present: z.boolean().describe('The tool is installed somewhere findable — on PATH or not'),
              onPath: z.boolean().describe('The binary resolves on PATH'),
            })
            .optional()
            .describe('Probe facts about an external dependency. Never a fix: no action, no commands'),
        }),
      )
      .describe('List of all check results'),
    allPassed: z.boolean().describe('Whether no check failed (warnings are advisory and do not count)'),
    cliVersion: z.string().describe('Version of the infra-kit CLI that produced this report'),
  },
  // Read-only on purpose: `--fix` is NOT reachable through this handler, and that is what keeps the
  // catalog's `mutating: false` honest — the ungated-mutating gate reads the flag, not this code.
  handler: () => {
    return doctor()
  },
})
