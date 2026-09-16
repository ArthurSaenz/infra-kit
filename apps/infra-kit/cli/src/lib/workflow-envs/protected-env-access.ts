import { isAgentMode } from 'src/lib/agent-mode'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'

import { PROTECTED_ENV_DENIED } from './protected-envs'
import type { ProtectedEnvAccess } from './protected-envs'

/**
 * Resolve whether THIS project may reach the delivery-shaped environments, and why not when it may
 * not. The single place the three-value `protectedEnvs` setting is interpreted — every call site
 * downstream sees the resolved {@link ProtectedEnvAccess} and nothing else.
 *
 * NEVER THROWS. A repo with no `infra-kit.json`, an unreadable one, or one the merge chain rejects
 * all resolve to denied.
 *
 * @example
 * await resolveProtectedEnvAccess() // no `protectedEnvs` key => { allowed: false, reason: 'disallow' }
 */
// The only impure member of the protected-env pair: it reads the merged config and the agent-mode
// flag, so `protected-envs.ts` stays a dependency-free policy leaf with a mock-free unit test.
//
// Refusing a protected env on a config we cannot read is correct; turning every deploy into a
// config-parse error is not — and `getInfraKitConfig` genuinely throws for a missing file.
//
// `isAgentMode()` is called INSIDE this function on purpose. `agentMode` is a mutable object read at
// call time, and the source is assigned in the CLI's `preAction` hook, which runs after this module
// is imported. Hoisting the read to module
// scope — `const inAgent = agentMode.source !== null` at the top — would freeze `false` and silently
// degrade `'cli-only'` into `'allow'` for every agent.
export const resolveProtectedEnvAccess = async (): Promise<ProtectedEnvAccess> => {
  let setting

  try {
    setting = (await getInfraKitConfig()).protectedEnvs ?? 'disallow'
  } catch {
    return PROTECTED_ENV_DENIED
  }

  if (setting === 'disallow') return PROTECTED_ENV_DENIED

  if (setting === 'cli-only' && isAgentMode()) {
    return { allowed: false, reason: 'agent-blocked' }
  }

  return { allowed: true, reason: 'allowed' }
}
