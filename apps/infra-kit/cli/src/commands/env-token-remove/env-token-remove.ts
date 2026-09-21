import { getDopplerProject } from 'src/integrations/doppler'
import { getTokenStorePath, readTokenStore, removeToken } from 'src/lib/env-tokens'
import { logger } from 'src/lib/logger'
import { tildify } from 'src/lib/path-display'
import { textContent } from 'src/types'

export interface EnvTokenRemoveArgs {
  /** Environment whose token to drop from the local store. */
  env: string
}

/** Where a token is actually revoked. Deleting it here only makes THIS machine stop using it. */
const DOPPLER_DASHBOARD_URL = 'https://dashboard.doppler.com/workplace/projects'

/**
 * The thing a user is most likely to get wrong about this command, so it is the thing it says
 * loudest: a local delete is not a revocation. The token stays live in Doppler — on someone's
 * clipboard, in a CI secret, in shell history — until it is revoked in the dashboard.
 */
const buildRevokeNotice = (project: string, env: string): string[] => {
  return [
    `Removing it locally does NOT revoke it — the token still works anywhere else it is stored.`,
    `Revoke it in Doppler (project "${project}", config "${env}"): ${DOPPLER_DASHBOARD_URL}/${project}`,
  ]
}

/**
 * Drop one environment's service token from the local store and tell the user where to actually
 * revoke it.
 *
 * No confirm step, under --agent included (LOW_RISK_MUTATING_ALLOWLIST): the host's permission prompt
 * on the argv is the gate, and the loss is local — the Doppler token survives and `env-token-set` puts
 * it back.
 */
export const envTokenRemove = async ({ env }: EnvTokenRemoveArgs) => {
  const store = await readTokenStore()
  const existed = Boolean(store?.envs[env])

  await removeToken(env)

  const project = await getDopplerProject()
  const storePath = await getTokenStorePath()

  if (existed) {
    logger.info(`Removed the "${env}" service token from ${tildify(storePath)}.`)
  } else {
    logger.info(`No "${env}" service token was stored in ${tildify(storePath)} — nothing to remove.`)
  }

  for (const line of buildRevokeNotice(project, env)) {
    logger.warn(line)
  }

  const structuredContent = {
    env,
    removed: existed,
    storePath,
    revokeUrl: `${DOPPLER_DASHBOARD_URL}/${project}`,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}
