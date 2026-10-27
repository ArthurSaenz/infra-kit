import { describe, expect, it } from 'vitest'

import { infraKitConfigObject } from 'src/lib/infra-kit-config'

import { CONFIG_STUB, buildUserGlobalExample, buildUserProjectExample, buildVendorExample } from '../config-templates'

const SCHEMA_KEYS = Object.keys(infraKitConfigObject.shape)

// The templates are annotated JSONC: every documented key lives inside a `//` comment.
// Stripping the comment lines must leave nothing but the outer braces.
const stripComments = (template: string): string => {
  return template
    .split('\n')
    .filter((line) => {
      return !/^\s*\/\/.*$/.test(line)
    })
    .join('\n')
}

const CONFIG_EXAMPLES: [name: string, template: string][] = [
  ['user-global (layer 2)', buildUserGlobalExample()],
  ['user-project (layer 3)', buildUserProjectExample('x')],
]

describe('config templates', () => {
  it('exposes the empty-but-valid JSON stub', () => {
    expect(CONFIG_STUB).toBe('{}\n')
    expect(JSON.parse(CONFIG_STUB)).toEqual({})
  })

  it('knows all eleven top-level schema keys', () => {
    expect(SCHEMA_KEYS).toEqual([
      '$schema',
      'configVersion',
      'envManagement',
      'defaultEnv',
      'worktrees',
      'protectedEnvs',
      'mcp',
      'vendorSource',
      'vendorTarget',
      'audit',
      'aliasRepo',
    ])
  })

  describe.each(CONFIG_EXAMPLES)('%s', (_name, template) => {
    // Anti-drift: adding a schema key without documenting it fails here.
    it.each(SCHEMA_KEYS)('documents the "%s" key', (key) => {
      expect(template).toContain(`"${key}"`)
    })

    it('is comment-only — stripping the comments leaves an empty object', () => {
      expect(JSON.parse(stripComments(template))).toEqual({})
    })
  })

  describe('buildUserProjectExample', () => {
    it('is deterministic and free of host-specific paths or timestamps', () => {
      const first = buildUserProjectExample('x')

      expect(buildUserProjectExample('x')).toBe(first)
      // `~/…` is literal documentation, never an expanded homedir.
      expect(first).not.toContain('/Users/')
      expect(first).not.toContain('/home/')
      expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    })

    it('names the project in the header path', () => {
      expect(buildUserProjectExample('hulyo-monorepo')).toContain('~/.infra-kit/projects/hulyo-monorepo/infra-kit.json')
    })
  })

  describe('buildVendorExample', () => {
    it('documents the factory registry properties and stays comment-only', () => {
      const template = buildVendorExample()

      expect(template).toContain('"workspaceDir"')
      expect(template).toContain('"targets"')
      expect(JSON.parse(stripComments(template))).toEqual({})
    })
  })
})
