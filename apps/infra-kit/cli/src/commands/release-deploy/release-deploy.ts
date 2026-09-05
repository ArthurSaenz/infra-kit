import { ghReleaseDeployAll } from 'src/commands/gh-release-deploy-all'
import { ghReleaseDeploySelected } from 'src/commands/gh-release-deploy-selected'
import { localDeployAll, localDeploySelected } from 'src/commands/local-deploy'
import { commandEcho } from 'src/lib/command-echo'
import { logger } from 'src/lib/logger'
import { assertFlagsMatchSource, resolveDeploySource } from 'src/lib/release-deploy'

export interface ReleaseDeployArgs {
  from?: string
  version?: string
  env?: string
  services?: string[]
  skipTerraform?: boolean
  yes?: boolean
  dryRun?: boolean
  printEnv?: boolean
}

type Selection = 'all' | 'selected'

/**
 * The shared body of `release deploy-all` and `release deploy-selected`.
 *
 * Both take `--from`, which decides where the deploy runs: `ci` dispatches the GitHub workflow for a
 * release ref, `local` runs `devops/scripts/deploy-*.sh` here against the current checkout. That used
 * to be encoded in which command group you typed (`release …` vs `local …`) — never restated at the
 * confirm prompt, and never stated at all once you were past the command name.
 *
 * What is deliberately NOT merged: the `-all` / `-selected` split. On the CI side those dispatch
 * different workflow files that declare DIFFERENT environment lists, so folding them into one
 * `--services`-present-or-absent flag would make the env picker's domain depend on that flag — and
 * would turn the palette's bare-path dispatch (which today opens a service checkbox) into a
 * deploy-everything.
 */
const runReleaseDeploy = async (args: ReleaseDeployArgs, selection: Selection, echoFrom = true) => {
  const { from, version, env, services, skipTerraform, yes, dryRun, printEnv } = args

  const source = await resolveDeploySource(from)

  // Echoed only on the commands that ACCEPT `--from`. When the runner was picked rather than typed,
  // the printed command is the only record of which one ran — but the deprecated `local …` aliases
  // register no `--from`, so echoing it there produced a line that commander rejects with
  // `unknown option '--from'`. A printed command that cannot be re-run is worse than none.
  if (echoFrom) commandEcho.addOption('--from', source)

  assertFlagsMatchSource(source, {
    '--version': version,
    '--skip-terraform': skipTerraform,
    '--dry-run': dryRun,
    '--print-env': printEnv,
  })

  if (source === 'local') {
    // `--services` is the one service flag on the merged surface; the local entrypoints still take
    // `service`, which is what their MCP tools declare and must keep declaring.
    return selection === 'all'
      ? localDeployAll({ env, yes, dryRun, printEnv })
      : localDeploySelected({ env, service: services, yes, dryRun, printEnv })
  }

  return selection === 'all'
    ? ghReleaseDeployAll({ version, env, skipTerraform, confirmedCommand: yes })
    : ghReleaseDeploySelected({ version, env, services, skipTerraform, confirmedCommand: yes })
}

/** Deploy every service the environment accepts, from a release ref or from this working tree. */
export const releaseDeployAll = async (args: ReleaseDeployArgs) => {
  return runReleaseDeploy(args, 'all')
}

/** Deploy a chosen subset of services, from a release ref or from this working tree. */
export const releaseDeploySelected = async (args: ReleaseDeployArgs) => {
  return runReleaseDeploy(args, 'selected')
}

/**
 * Back-compat shim for `local deploy-all` / `local deploy-selected`.
 *
 * The old commands keep working for one release so a muscle-memory invocation does not simply fail,
 * but they are gone from the palette (`menuGroup: null`) and say so on every run. They pin
 * `--from local`, which is exactly what they always meant.
 */
export const deprecatedLocalDeploy = async (
  // Narrower than `Omit<…, 'from'>`: the aliases register no `--version`/`--skip-terraform`, so
  // admitting them would describe a call no caller can make.
  args: Pick<ReleaseDeployArgs, 'env' | 'services' | 'yes' | 'dryRun' | 'printEnv'>,
  selection: Selection,
) => {
  const replacement = `release deploy-${selection} --from local`

  logger.warn(`\`local deploy-${selection}\` is deprecated and will be removed — use \`${replacement}\` instead.`)

  // `echoFrom: false` — these aliases have no `--from` to print. They pin the runner internally.
  return runReleaseDeploy({ ...args, from: 'local' }, selection, false)
}
