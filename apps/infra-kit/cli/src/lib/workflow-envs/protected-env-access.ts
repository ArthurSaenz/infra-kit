import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { isMcpMode } from 'src/lib/mcp-mode'

import { PROTECTED_ENV_DENIED } from './protected-envs'
import type { ProtectedEnvAccess } from './protected-envs'

/**
 * Resolve whether THIS project may reach the delivery-shaped environments, and why not when it may
 * not.
 *
 * The only impure member of the protected-env pair: it reads the merged config and the MCP-mode flag,
 * so `protected-envs.ts` stays a dependency-free policy leaf with a mock-free unit test. This is also
 * the single place the three-value `protectedEnvs` setting is interpreted — every call site downstream
 * sees the resolved {@link ProtectedEnvAccess} and nothing else.
 *
 * NEVER THROWS. A repo with no `infra-kit.json`, an unreadable one, or one the merge chain rejects all
 * resolve to denied. Refusing a protected env on a config we cannot read is correct; turning every
 * deploy into a config-parse error is not — and `getInfraKitConfig` genuinely throws for a missing
 * file.
 *
 * `isMcpMode()` is called INSIDE this function on purpose. `mcpMode` is a mutable object read at call
 * time, and the flag is assigned during MCP server bootstrap (`mcp/server.ts`), which happens after
 * this module is imported. Hoisting the read to module scope — `const inMcp = mcpMode.enabled` at the
 * top — would freeze `false` and silently degrade `'cli-only'` into `'allow'` for every agent.
 *
 * @example
 * await resolveProtectedEnvAccess() // no `protectedEnvs` key => { allowed: false, reason: 'disallow' }
 */
export const resolveProtectedEnvAccess = async (): Promise<ProtectedEnvAccess> => {
  let setting

  try {
    setting = (await getInfraKitConfig()).protectedEnvs ?? 'disallow'
  } catch {
    return PROTECTED_ENV_DENIED
  }

  if (setting === 'disallow') return PROTECTED_ENV_DENIED

  if (setting === 'cli-only' && isMcpMode()) {
    return { allowed: false, reason: 'mcp-blocked' }
  }

  return { allowed: true, reason: 'allowed' }
}
