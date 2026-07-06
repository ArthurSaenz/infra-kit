import { runEnvAutoLoad } from 'src/lib/env-autoload'

export interface EnvAutoloadArgs {
  /**
   * Canonical (realpath'd) project dir the shell computed (`${dir:A}`) and passed
   * via `--project-dir`. Forwarded to enable the project-scoped warm cache; absent
   * when invoked without the flag (then no warm copy is written).
   */
  projectDir?: string
}

/**
 * Internal command invoked (backgrounded) by the `infra-kit init` shell-startup
 * integration. Runs the 'shell-startup' trigger, writing env-load.sh when
 * envAutoLoad is configured for it + eligible; the shell precmd hook sources it on
 * a subsequent prompt. Intentionally writes NOTHING to stdout and never throws —
 * auto-load must never disrupt shell startup.
 */
export const envAutoload = async ({ projectDir }: EnvAutoloadArgs = {}): Promise<void> => {
  // `force`: the shell may have just WARM-sourced the same config (exporting the
  // auto-load marker this process inherits); without it the refresh would self-skip
  // and stale warm secrets would never be replaced this session.
  await runEnvAutoLoad({ expectedTrigger: 'shell-startup', projectDir, force: true })
}
