import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import type { PackageCheck, PackageValidationResult } from 'src/lib/package-validator'
import { reconcileMcpProxies } from 'src/lib/plugin-pointer/mcp-proxy-registration'
import type { ProxyEntryReport } from 'src/lib/plugin-pointer/mcp-proxy-registration'

/**
 * Root-only: is `.mcp.json` in step with `infra-kit.json`'s `mcp` block?
 *
 * Every non-`unchanged` entry is a FAILURE, including a stale `ik-mcp` entry — "reported" would be
 * decorative otherwise, and the residual hole (the entry keeps spawning the old command with the old
 * env names until someone acts) is real. `fix` rewrites what can be regenerated and nothing else:
 * stale and conflicting entries stay red with their manual fix in the message.
 */
// Returns null (no check row) when the project declares no `mcp` block, and when the loader itself
// throws — a repo with no or invalid infra-kit.json is already failing `audit` on that; a second
// row here would blame the proxy for it.
export const checkMcpProxies = async (root: string, fix: boolean): Promise<PackageValidationResult | null> => {
  let proxies: Awaited<ReturnType<typeof getInfraKitConfig>>['mcp']

  try {
    proxies = (await getInfraKitConfig()).mcp
  } catch {
    return null
  }

  if (!proxies || Object.keys(proxies).length === 0) return null

  const result = reconcileMcpProxies({ projectRoot: root, proxies, write: fix })

  if (result.status !== 'ok' && result.status !== 'failed') {
    return {
      packageDir: root,
      packageName: 'mcp',
      checks: [
        {
          name: 'mcp:.mcp.json',
          status: 'fail',
          message: `${result.path} could not be read as JSON — fix it and re-run`,
        },
      ],
      passed: false,
    }
  }

  // After a `fix`, a rewrite reports `written`; that is a pass for the check, not drift.
  const failures = result.entries.filter((entry): entry is ProxyEntryReport => {
    return entry.status !== 'unchanged' && entry.status !== 'written'
  })

  const checks: PackageCheck[] =
    failures.length === 0
      ? [
          {
            name: 'mcp:.mcp.json',
            status: 'pass',
            message: 'every mcp.<name> has a matching ik-mcp entry in .mcp.json',
          },
        ]
      : failures.map((entry): PackageCheck => {
          return { name: `mcp:${entry.name}`, status: 'fail', message: entry.message }
        })

  return { packageDir: root, packageName: 'mcp', checks, passed: failures.length === 0 }
}
