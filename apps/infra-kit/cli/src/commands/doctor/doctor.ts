import { z } from 'zod'
import { $ } from 'zx'

import { logger } from 'src/lib/logger'
import type { ToolsExecutionResult } from 'src/types'

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

/**
 * Check installation and authentication status of gh, doppler, and aws CLIs
 */
export const doctor = async (): Promise<ToolsExecutionResult> => {
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
    content: [
      {
        type: 'text',
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  }
}

// MCP Tool Registration
export const doctorMcpTool = {
  name: 'doctor',
  description: 'Check installation and authentication status of gh, doppler, and aws CLIs',
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
}
