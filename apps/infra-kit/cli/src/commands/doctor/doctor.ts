import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

// The one source of truth for "does `--fix` repair this row". Imported rather than restated so the
// `fixable` field on the payload cannot drift from the `--fix` code paths, exactly as `report.ts`'s
// own comment requires of its hint.
import { FIXABLE_NAMES } from 'src/commands/doctor/report'
import { probeOrca } from 'src/integrations/orca'
import { ROOT_VERSION_PREFIX, inspectPackageGuidance, readGuidanceFile } from 'src/lib/agent-guidance'
import { agentMode } from 'src/lib/agent-mode'
import { readAutoSetupRecord } from 'src/lib/auto-setup/record'
import { checkClaudeInChrome } from 'src/lib/claude-chrome'
import { describeOverrides, readOverrideSummary } from 'src/lib/config-overrides'
// The probe reports FACTS about an install and can neither name nor run a fix — the same one-way seam
// as the registry import below. `lib/dependency-plan` is the module that turns a probe into a recipe,
// and `doctor` deliberately stops one module short of it.
import { defaultProbeDeps, probeAll } from 'src/lib/dependency-probe'
import type { ProbeDeps } from 'src/lib/dependency-probe'
// Probe argv only. `doctor` must never import the install recipes: the registry owns "how do I ask this
// tool for its version", `setup-dependency*` owns "what would fix it", and the direction is one-way.
import { specFor } from 'src/lib/dependency-registry'
import type { DependencyId } from 'src/lib/dependency-registry'
import { getProjectRoot } from 'src/lib/git-utils/git-utils'
import { getInfraKitConfigPaths } from 'src/lib/infra-kit-config'
import { buildZshenvBlock } from 'src/lib/init'
// `resolveGitRoot` is the WRITER's gate, imported rather than re-derived so the reader's row set and
// the writer's reach cannot drift apart (see the gate comment beside the plugin rows below).
import { AGENTS_MARKER_END, AGENTS_MARKER_START, resolveGitRoot } from 'src/lib/init/agent-files'
import { MARKER_END, MARKER_START, buildShellBlock } from 'src/lib/init/init'
import { extractVersion, hasManagedBlock } from 'src/lib/managed-block'
import { discoverPackages } from 'src/lib/package-validator/loader'
import { tildify } from 'src/lib/path-display'
import { isNewerVersion } from 'src/lib/update-check/semver'
import { sortVersions } from 'src/lib/version-utils'
import { defineMcpTool, textContent } from 'src/types'

import packageJson from '../../../package.json' with { type: 'json' }
import type { AllowlistCatalogEntry } from './agent-allowlist'
import { allChecksPassed } from './check-result'
import type { CheckResult, DependencyDetail } from './check-result'
import { agentAllowlistRow, checkAgentMode, checkAutoSetup, checkMergeDevResolutions } from './checks/agent'
import { checkClaudeCli, checkClaudePlugin } from './checks/claude-plugin'
import type { DoctorOrigin } from './checks/claude-plugin'
import { checkCommand } from './checks/command'
import { checkEnvTokensConfigured, checkTokenStorePerms, checkTokenStorePresent } from './checks/env-tokens'
import { checkPortless, pruneStalePortlessRoutes } from './checks/portless'
import type { PortlessCheckDeps } from './checks/portless'
import { readDoctorConfig } from './doctor-config'
import type { DoctorConfig } from './doctor-config'

/**
 * The rows that carry a {@link DependencyDetail} — every registry id except `portless`, whose
 * exclusion is argued in `probe-argv-single-source.test.ts`. Declared here rather than derived from
 * `DEPENDENCY_IDS` minus a filter: the exclusion is a decision, and a decision should be readable.
 */
const DETAILED_IDS: readonly DependencyId[] = ['brew', 'git', 'gh', 'doppler', 'aws']

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

const checkPnpmWorkspaceVirtualStore = async (): Promise<CheckResult> => {
  const name = 'pnpm enableGlobalVirtualStore'

  try {
    const root = await getProjectRoot()
    const yamlPath = path.join(root, 'pnpm-workspace.yaml')

    if (!fs.existsSync(yamlPath)) {
      return { name, status: 'fail', message: `pnpm-workspace.yaml not found at ${yamlPath}` }
    }

    const content = fs.readFileSync(yamlPath, 'utf-8')
    // eslint-disable-next-line sonarjs/super-linear-regex -- the input is a local file the user owns, not untrusted text
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

export const checkInfraKitConfigValid = (read: DoctorConfig): CheckResult => {
  const name = 'infra-kit config valid'

  if (read.error) return { name, status: 'fail', message: read.error.message }

  return {
    name,
    status: 'pass',
    message: 'infra-kit.json is valid (user overrides applied if present)',
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
 * //   message: '~/.infra-kit/projects/api/infra-kit.json (2 override(s): worktrees, mcp) — project: api' }
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
 * A `skip` when the paths can't resolve: nothing to surface if there's no resolvable target.
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
    return { name, status: 'skip', message: 'infra-kit config paths could not be resolved' }
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
 * Versions recorded by well-formed package guidance blocks.
 *
 * `discoverPackages` is wrapped because it reads `pnpm-workspace.yaml` with an unguarded
 * `readFile` + `yaml.parse`: a single-package repo (and the doctor inventory fixture, a temp
 * directory holding only `infra-kit.json` and `CLAUDE.md`) has no such file, and an ENOENT here
 * would propagate out of `doctor()` and crash the command. Any throw degrades to "no packages".
 * Read-only by construction — nothing on this path writes.
 */
const collectPackageBlockVersions = async (root: string): Promise<string[]> => {
  let packageDirs: string[]

  try {
    packageDirs = await discoverPackages(root)
  } catch {
    return []
  }

  return packageDirs.flatMap((dir) => {
    const inspection = inspectPackageGuidance(readGuidanceFile(path.join(dir, 'CLAUDE.md')))

    return inspection.state === 'ok' && inspection.version !== undefined ? [inspection.version] : []
  })
}

/** `versions` in ascending SemVer order (`sortVersions` wants the `v` prefix). */
const sortPlainVersions = (versions: string[]): string[] => {
  return sortVersions(
    versions.map((version) => {
      return `v${version}`
    }),
  ).map((version) => {
    return version.slice(1)
  })
}

/**
 * The `Guidance version` row: are the root and package guidance blocks at the running CLI's
 * version? Version-only — whether the TEXT differs is `audit`'s `agent-guidance:drift` check.
 * Never a `fail`: every release bumps the version, so an older block is routine until the next
 * `audit --fix`, and a newer block means this CLI is the stale side.
 */
const guidanceVersionCheck = async (root: string, rootContent: string, current: string): Promise<CheckResult> => {
  const name = 'Guidance version'
  const rootVersion = extractVersion(rootContent, ROOT_VERSION_PREFIX)
  const packageVersions = await collectPackageBlockVersions(root)
  const all = rootVersion === null ? packageVersions : [rootVersion, ...packageVersions]

  const newer = all.filter((version) => {
    return isNewerVersion(version, current)
  })

  if (newer.length > 0) {
    const newest = sortPlainVersions(newer).at(-1)!

    return {
      name,
      status: 'warn',
      message: `${newer.length} guidance ${newer.length === 1 ? 'block was' : 'blocks were'} generated by a newer infra-kit (newest ${newest}, current ${current}) — CLI behind the block, run: pnpm add -g infra-kit@${newest}`,
    }
  }

  const rootStale = rootVersion !== null && isOlderVersion(rootVersion, current)

  const stalePackages = packageVersions.filter((version) => {
    return isOlderVersion(version, current)
  })

  if (!rootStale && stalePackages.length === 0) {
    return { name, status: 'pass', message: `guidance blocks match infra-kit ${current}` }
  }

  const parts = [
    ...(rootStale ? [`the root block is from infra-kit ${rootVersion} — run: infra-kit audit --fix --root`] : []),
    ...(stalePackages.length > 0
      ? [
          `${stalePackages.length} package guidance ${stalePackages.length === 1 ? 'block was' : 'blocks were'} generated by an older infra-kit (oldest ${sortPlainVersions(stalePackages)[0]}, current ${current}) — run: infra-kit audit --fix --all`,
        ]
      : []),
  ]

  return { name, status: 'warn', message: parts.join('; ') }
}

/**
 * Check that the repo agent-instruction guidance managed by `infra-kit setup` exists — the
 * `CLAUDE.md block` row, presence only — and whether the guidance blocks are at this CLI's
 * version — the `Guidance version` row. Repo-gated: outside an infra-kit repo both rows are a
 * `skip`, never an absence, so the report says it did not look. A repo that predates the
 * AGENTS.md→CLAUDE.md migration reports the block as failing until `infra-kit setup` is re-run.
 */
export const checkAgentFiles = async (): Promise<CheckResult[]> => {
  const notARepo: CheckResult[] = [
    { name: 'CLAUDE.md block', status: 'skip', message: 'no infra-kit config in this repo' },
    { name: 'Guidance version', status: 'skip', message: 'no infra-kit config in this repo' },
  ]

  let mainConfigPath: string

  try {
    mainConfigPath = (await getInfraKitConfigPaths()).main
  } catch {
    return notARepo
  }

  if (!fs.existsSync(mainConfigPath)) return notARepo

  const root = path.dirname(mainConfigPath)
  const claudePath = path.join(root, 'CLAUDE.md')
  const content = fs.existsSync(claudePath) ? fs.readFileSync(claudePath, 'utf-8') : ''
  const present = hasManagedBlock(content, AGENTS_MARKER_START, AGENTS_MARKER_END)

  return [
    {
      name: 'CLAUDE.md block',
      status: present ? 'pass' : 'fail',
      message: present
        ? 'CLAUDE.md block present'
        : 'infra-kit block missing from CLAUDE.md. Run: infra-kit setup --skip-tools',
    },
    await guidanceVersionCheck(root, content, packageJson.version),
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
 * Check installation and authentication status of gh, doppler, and aws CLIs
 */
export const doctor = async (
  options: {
    fix?: boolean
    probeDeps?: ProbeDeps
    portlessDeps?: PortlessCheckDeps
    /** The command catalog the `Agent allowlist` row matches against; without it the row is a `skip`. */
    catalog?: readonly AllowlistCatalogEntry[]
  } = {},
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
      'git',
      checkCommand(
        'git installed',
        specFor('git').probeArgv,
        'git is installed',
        'git is not installed. Install with: brew install git',
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
    checkPnpmWorkspaceVirtualStore(),
    Promise.resolve(checkInfraKitConfigValid(read)),
    checkTokenStorePresent(),
    checkEnvTokensConfigured(read),
    checkTokenStorePerms(options.fix ?? false),
    checkUserOverridePath(),
    checkLegacyUserGlobalConfig(),
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

  // The Claude Code plugin rows read `~/.claude/` and answer from anywhere; the allowlist row is
  // about a PROJECT and so is gated — but NOT on the same predicate as the guidance check. It belongs
  // to any git toplevel that is not `$HOME` (`resolveGitRoot`) — the same set `setup` inspects — while
  // the guidance writer still requires an `infra-kit.json` there. Gating it on `infra-kit.json` too
  // would hide a broad allow in exactly the repos that lack one.
  //
  // `resolveGitRoot` is also what keeps a blank `git rev-parse` from being answered: it returns
  // `null` rather than `''`, so the row is a `skip` instead of a verdict on `process.cwd()`.
  const repoRoot = await resolveCheckedRepoRoot()
  const gitRoot = await resolveGitRoot()
  const origin: DoctorOrigin = { projectDir: process.env.CLAUDE_PROJECT_DIR || null, cwd: process.cwd(), gitRoot }

  const pluginChecks: CheckResult[] = [
    // First in the section: the binary the install step drives. Read the prerequisite before the
    // rows whose failure it explains.
    await checkClaudeCli(),
    ...checkClaudePlugin(repoRoot, origin),
    checkClaudeInChrome(),
    // `flag` is the resolved source, not a re-parse of argv: `preAction` has already run, and a
    // `--agent` on this very invocation is what set it.
    checkAgentMode({ env: process.env, stdinIsTTY: process.stdin.isTTY === true, flag: agentMode.source === 'flag' }),
    agentAllowlistRow(gitRoot, options.catalog),
  ]

  const checks: CheckResult[] = [
    ...baseChecks,
    await checkMergeDevResolutions(gitRoot),
    ...portlessChecks,
    ...(await checkAgentFiles()),
    ...pluginChecks,
    checkAutoSetup(readAutoSetupRecord(), packageJson.version),
  ]

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
    allPassed: allChecksPassed(checks),
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
          status: z
            .enum(['pass', 'fail', 'warn', 'skip'])
            .describe(
              'Check result; warn is advisory and never fails the run; skip is not evaluated; the message says why; never a failure',
            ),
          message: z.string().describe('Details about the check result'),
          fixable: z.boolean().describe('Whether `infra-kit doctor --fix` repairs this row'),
          // Present on the five dependency rows only. `status` answers "resolves on PATH"; this answers
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
    allPassed: z.boolean().describe('Whether no check failed (warnings and skips do not count)'),
    cliVersion: z.string().describe('Version of the infra-kit CLI that produced this report'),
  },
  // Read-only on purpose: `--fix` is NOT reachable through this handler, and that is what keeps the
  // catalog's `mutating: false` honest — the ungated-mutating gate reads the flag, not this code.
  handler: () => {
    return doctor()
  },
})
