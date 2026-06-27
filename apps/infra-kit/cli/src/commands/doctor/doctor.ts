import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { $ } from 'zx'

import { AGENTS_MARKER_END, AGENTS_MARKER_START } from 'src/commands/init/agent-files'
import { MARKER_END, MARKER_START, buildShellBlock } from 'src/commands/init/init'
import { getDopplerProject, listDopplerProjects } from 'src/integrations/doppler'
import { getProjectRoot } from 'src/lib/git-utils/git-utils'
import {
  getInfraKitConfig,
  getInfraKitConfigPaths,
  resetInfraKitConfigCache,
  resolveConfiguredIdes,
} from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { hasManagedBlock } from 'src/lib/managed-block'
import { tildify } from 'src/lib/path-display'
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
 * Surface where this developer's user-scope override file would live and
 * whether it has been created. Always passes — informational only — so the
 * user knows the resolved project name and target path at a glance.
 *
 * @example
 * await checkUserOverridePath()
 * // {
 * //   name: 'user override path',
 * //   status: 'pass',
 * //   message: '~/.infra-kit/projects/api/infra-kit.json (not yet created) — project: api',
 * // }
 */
const checkUserOverridePath = async (): Promise<CheckResult> => {
  const name = 'user override path'

  try {
    const paths = await getInfraKitConfigPaths()
    const home = os.homedir()
    const display = paths.userProject.startsWith(home) ? `~${paths.userProject.slice(home.length)}` : paths.userProject
    const exists = fs.existsSync(paths.userProject)
    const suffix = exists ? '(exists)' : '(not yet created)'

    return {
      name,
      status: 'pass',
      message: `${display} ${suffix} — project: ${paths.projectName}`,
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
    // INFO: no need now, util the user does not load the env variables, the aws cli is not authenticated
    // checkCommand(
    //   'aws authenticated',
    //   ['aws', 'sts', 'get-caller-identity'],
    //   'AWS CLI is authenticated',
    //   'AWS CLI is not authenticated. Run: aws configure (or aws sso login)',
    // ),
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
    checkRtkConfigured(),
    Promise.resolve(checkZshrcInitialized()),
    checkPnpmWorkspaceVirtualStore(),
    checkInfraKitConfigValid(),
    checkDopplerProjectExists(),
    checkUserOverridePath(),
    checkLegacyUserGlobalConfig(),
    checkIdeInstalled(),
  ])

  const checks: CheckResult[] = [...baseChecks, ...(await checkAgentFiles())]

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
