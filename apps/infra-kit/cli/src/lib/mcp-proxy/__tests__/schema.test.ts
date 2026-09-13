import { describe, expect, it } from 'vitest'

import {
  buildMcpLayerRejectionMessage,
  infraKitConfigObject,
  infraKitOverrideConfigSchema,
} from 'src/lib/infra-kit-config/infra-kit-config'

const GRAFANA = {
  command: 'mcp-grafana',
  args: ['-t', 'stdio'],
  env: ['GRAFANA_URL', 'GRAFANA_SERVICE_ACCOUNT_TOKEN'],
  unset: ['GRAFANA_API_KEY', 'GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE'],
}

/** The smallest config the strict object accepts, so only the `mcp` half is under test. */
const withMcp = (mcp: unknown): unknown => {
  return { envManagement: { provider: 'doppler', config: { name: 'x' } }, mcp }
}

const issuesOf = (value: unknown): string => {
  const result = infraKitConfigObject.safeParse(value)

  return result.success ? '' : JSON.stringify(result.error.issues)
}

describe('mcp schema', () => {
  it('accepts the grafana example and applies defaults', () => {
    const result = infraKitConfigObject.safeParse(withMcp({ grafana: GRAFANA }))

    expect(result.success, issuesOf(withMcp({ grafana: GRAFANA }))).toBe(true)
    expect(result.data?.mcp?.grafana).toEqual(GRAFANA)
  })

  it('fills args and unset with empty arrays when omitted', () => {
    const result = infraKitConfigObject.safeParse(
      withMcp({ gh: { command: 'github-mcp-server', env: ['GITHUB_TOKEN'] } }),
    )

    expect(result.data?.mcp?.gh).toEqual({ command: 'github-mcp-server', args: [], env: ['GITHUB_TOKEN'], unset: [] })
  })

  it('still parses a config with no mcp block at all', () => {
    expect(
      infraKitConfigObject.safeParse({ envManagement: { provider: 'doppler', config: { name: 'x' } } }).success,
    ).toBe(true)
  })

  it.each([
    ['an unknown key', { grafana: { ...GRAFANA, port: 3000 } }, /unrecognized|port/i],
    ['an empty env list', { grafana: { ...GRAFANA, env: [] } }, /env/],
    ['a bad variable name', { grafana: { ...GRAFANA, env: ['GRAFANA-URL'] } }, /POSIX/],
    ['a name with uppercase', { Grafana: GRAFANA }, /lowercase/],
    ['a name containing infra-kit', { 'infra-kit-docs': GRAFANA }, /reserved/],
    ['PATH listed as a credential', { grafana: { ...GRAFANA, env: ['PATH'] } }, /plumbing/],
  ])('rejects %s', (_label, mcp, pattern) => {
    expect(issuesOf(withMcp(mcp)), `expected a rejection for ${_label}`).toMatch(pattern)
  })
})

describe('mcp is refused outside the project layer', () => {
  it('the override schema itself would accept it — which is exactly why loadLayer has to refuse by hand', () => {
    // Documents the trap: `.partial()` keeps every key, so without the explicit refusal a
    // per-machine `mcp` would parse, shallow-merge over the project's block, and be derived.
    expect(infraKitOverrideConfigSchema.safeParse({ mcp: { grafana: GRAFANA } }).success).toBe(true)
  })

  it('names the file, the fix, and the Claude Code local-scope recipe', () => {
    const message = buildMcpLayerRejectionMessage({
      label: 'user-project override config',
      path: '/home/x/.infra-kit/projects/repo/infra-kit.json',
      required: false,
    })

    expect(message).toContain('/home/x/.infra-kit/projects/repo/infra-kit.json')
    expect(message).toContain('project infra-kit.json')
    expect(message).toContain('claude mcp add --scope local')
  })
})
