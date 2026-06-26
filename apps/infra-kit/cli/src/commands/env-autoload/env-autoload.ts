import { runEnvAutoLoad } from 'src/lib/env-autoload'

/**
 * Internal command invoked (backgrounded) by the `infra-kit init` shell-startup
 * integration. Runs the 'shell-startup' trigger, writing env-load.sh when
 * envAutoLoad is configured for it + eligible; the shell precmd hook sources it on
 * a subsequent prompt. Intentionally writes NOTHING to stdout and never throws —
 * auto-load must never disrupt shell startup.
 */
export const envAutoload = async (): Promise<void> => {
  await runEnvAutoLoad({ expectedTrigger: 'shell-startup' })
}
