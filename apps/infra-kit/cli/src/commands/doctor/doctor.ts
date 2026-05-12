import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod/v4'
import { $ } from 'zx'

import { MARKER_END, MARKER_START, buildShellBlock } from 'src/commands/init/init'
import { getProjectRoot } from 'src/lib/git-utils/git-utils'
import { getInfraKitConfig, getInfraKitConfigPaths, resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
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
    // eslint-disable-next-line sonarjs/slow-regex
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
      message: 'infra-kit.yml is valid (user overrides applied if present)',
    }
  } catch (err) {
    return { name, status: 'fail', message: (err as Error).message }
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
 * //   message: '~/.infra-kit/projects/api/infra-kit.yml (not yet created) — project: api',
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
 * Check installation and authentication status of gh, doppler, aws, and rtk CLIs
 */
export const doctor = async () => {
  const checks: CheckResult[] = await Promise.all([
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
    checkRtkConfigured(),
    Promise.resolve(checkZshrcInitialized()),
    checkPnpmWorkspaceVirtualStore(),
    checkInfraKitConfigValid(),
    checkUserOverridePath(),
  ])

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
