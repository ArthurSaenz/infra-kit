import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { $ } from 'zx'

import { KILL_SWITCHES } from './mcp-harness'

/**
 * @fileoverview
 *
 * The repo + home + session an `env-load` form lane spawns the server into
 * (docs/session-env-picker-plan.md §6.4).
 *
 * Three throwaway directories, every one of them load-bearing:
 *  - `repo` — a `git init`'d project whose ONE workflow, `deploy-all.yml`, declares the environments
 *    the form must offer (`env-list` unions every workflow; the deploy-all form reads that file by
 *    name, so one file serves both), plus an `infra-kit.json` naming the Doppler project. The config
 *    file is a deviation from the plan's fixture, accepted by the lead: without it
 *    `getDopplerProject()` throws "infra-kit.json not found" from `env-list` and `env-load` alike,
 *    BEFORE any token is consulted, so no lane could ever reach the `env-token-set` assertion.
 *  - `home` — `$HOME` for the child, holding a token store with ONE token so the form's prose has
 *    both a token-bearing env and token-less ones to name, and so the load of `stage` fails on the
 *    MISSING token rather than on a doppler binary this suite deliberately does not stub.
 *  - `cacheHome` — `XDG_CACHE_HOME`, so a load that did succeed could only ever write into
 *    `sessionDir`, never into the developer's real session cache.
 *
 * `INFRA_KIT_ENV_TOKEN` is deleted from the child env: an ambient token would make every env
 * "token-bearing" and the auth-error assertions would pass for the wrong reason — or, worse, the
 * load would really run against Doppler.
 *
 * `gh` IS stubbed on the child's PATH, `doppler` is NOT. The deploy-all form needs open release PRs
 * to offer a `version` at all (an empty list means no form, by design), and `gh pr list` is the only
 * source; nothing in the env-load lanes consults `gh`. The stub answers exactly the two `pr list`
 * shapes `fetchAllReleasePRs` issues and fails loudly on anything else, so a lane that reached a
 * real dispatch would red rather than dispatch.
 */

export interface EnvPickerFixture {
  /** Spawn `cwd`. REALPATH'd: git reports the toplevel canonicalized (`/var` → `/private/var`). */
  repo: string
  /** Where a successful `env-load` would write `env-load.sh`. Does not exist until something writes into it. */
  sessionDir: string
  /** The environments the fixture workflow declares, in declaration order — what `env-list` must report. */
  envNames: readonly string[]
  /** The env every one of these lanes accepts — declared in the workflow, NO token stored. */
  tokenlessEnv: string
  /** The `version` label the stubbed `gh` makes the deploy-all form offer. */
  releaseLabel: string
  env: NodeJS.ProcessEnv
  /** Every directory to `rmSync` in `afterAll`. */
  dirs: string[]
}

const ENV_NAMES = ['dev', 'stage', 'prod'] as const

/** The one open release PR the `gh` stub reports — `release/v1.2.5`, which the form labels `1.2.5`. */
const RELEASE_PR = {
  number: 1,
  title: 'Release 1.2.5',
  headRefName: 'release/v1.2.5',
  state: 'OPEN',
  baseRefName: 'dev',
  createdAt: '2026-01-01T00:00:00Z',
}

const GH_STUB = [
  '#!/bin/sh',
  '# Stub `gh` for the MCP e2e fixture: release discovery only, everything else is a loud failure.',
  'case "$*" in',
  `  "pr list "*"--base dev"*) printf '%s\n' '${JSON.stringify([RELEASE_PR])}' ;;`,
  `  "pr list "*"--base main"*) printf '[]\n' ;;`,
  '  *) echo "gh stub: unexpected invocation: $*" >&2; exit 97 ;;',
  'esac',
  '',
].join('\n')

const DEPLOY_WORKFLOW = [
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  '      environment:',
  '        type: choice',
  `        options: [${ENV_NAMES.join(', ')}]`,
  '',
].join('\n')

export const makeEnvPickerFixture = async (): Promise<EnvPickerFixture> => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'env-picker-repo-')))
  const home = mkdtempSync(join(tmpdir(), 'env-picker-home-'))
  const cacheHome = mkdtempSync(join(tmpdir(), 'env-picker-cache-'))
  const stubBin = mkdtempSync(join(tmpdir(), 'env-picker-bin-'))
  const session = 'env-picker'

  await $({ cwd: repo })`git init --quiet`
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(repo, '.github', 'workflows', 'deploy-all.yml'), DEPLOY_WORKFLOW)
  writeFileSync(join(stubBin, 'gh'), GH_STUB)
  chmodSync(join(stubBin, 'gh'), 0o755)
  writeFileSync(
    join(repo, 'infra-kit.json'),
    JSON.stringify({ envManagement: { provider: 'doppler', config: { name: 'env-picker-project' } } }),
  )

  // `~/.infra-kit/projects/<repo>/tokens.json`, keyed by the repo BASENAME (`getRepoName`), which is
  // why `repo` had to be realpath'd above: the server derives the same basename from git's answer.
  const storeDir = join(home, '.infra-kit', 'projects', basename(repo))

  mkdirSync(storeDir, { recursive: true })
  writeFileSync(join(storeDir, 'tokens.json'), JSON.stringify({ version: 1, envs: { dev: 'dp.st.dev.x' } }))

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...KILL_SWITCHES,
    HOME: home,
    XDG_CACHE_HOME: cacheHome,
    INFRA_KIT_SESSION: session,
    PATH: [stubBin, process.env.PATH ?? ''].join(delimiter),
  }

  delete env.INFRA_KIT_ENV_TOKEN
  delete env.CLAUDE_PLUGIN_ROOT
  // A developer's loaded Jira env would make release-create's `[next]` hint live (slow, non-deterministic)
  // and could let its handler succeed against a real Jira; scrubbed so the lane's outcomes are fixed.
  delete env.JIRA_BASE_URL
  delete env.JIRA_EMAIL
  delete env.JIRA_PROJECT_ID
  delete env.JIRA_TOKEN
  delete env.JIRA_API_TOKEN

  return {
    repo,
    sessionDir: join(cacheHome, 'infra-kit', session),
    envNames: ENV_NAMES,
    tokenlessEnv: 'stage',
    releaseLabel: '1.2.5',
    env,
    dirs: [repo, home, cacheHome, stubBin],
  }
}
