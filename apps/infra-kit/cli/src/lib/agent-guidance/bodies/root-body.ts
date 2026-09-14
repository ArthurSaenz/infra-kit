import { MCP_TOOL_PREFIX } from 'src/mcp/tool-prefix'

import { ROOT_VERSION_PREFIX } from '../markers'
import { RESOURCES } from '../resources'
import { renderTemplate } from '../template'

/** The version comment line, e.g. `<!-- infra-kit:version 0.1.105 -->`. */
const buildVersionLine = (version: string): string => {
  return `${ROOT_VERSION_PREFIX}${version} -->`
}

/**
 * The repo-root guidance body (without the surrounding markers). Describes the
 * infra-kit CLI surface so any AI agent working in the repo learns it. The prose
 * lives in `resources/root/body.md`; the version line records which CLI version
 * generated it.
 *
 * @example
 * buildRootBody('0.4.0')
 * // => '<!-- infra-kit:version 0.4.0 -->\n\n# infra-kit\n…'
 */
export const buildRootBody = (version: string): string => {
  // The one placeholder this body carries: the MCP tool prefix, spelled through
  // `tool-prefix.ts` rather than as a literal here. `renderTemplate` throws on an
  // unknown or unwired placeholder, so a resource edit that adds another `{{…}}`
  // without a matching entry here fails loudly instead of shipping the literal token.
  const body = renderTemplate(RESOURCES['root/body'], {
    mcpToolPrefix: `${MCP_TOOL_PREFIX}*`,
  })

  return [buildVersionLine(version), '', body].join('\n')
}
