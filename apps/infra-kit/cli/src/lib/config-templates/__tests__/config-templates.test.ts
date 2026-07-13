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

// The `apps` record of a `devServersPresets` entry is keyed by PACKAGE (`<app>/api`,
// `<app>/ui`); a bare `<app>` is a folder and is rejected at resolve time. Pull the
// example keys back out of the doc block so the templates can never regress to one.
const appsExampleKeys = (template: string): string[] => {
  const lines = template.split('\n')
  const start = lines.findIndex((line) => {
    return line.includes('"apps": {')
  })

  expect(start).toBeGreaterThan(-1)

  const keys: string[] = []

  for (const line of lines.slice(start + 1)) {
    const body = line.replace(/^\s*\/\/\s*/, '')

    if (body.startsWith('}')) break

    const match = /^"([^"]+)":/.exec(body)

    if (match) keys.push(match[1]!)
  }

  return keys
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

  it('knows all nine top-level schema keys', () => {
    expect(SCHEMA_KEYS).toEqual([
      'environments',
      'envManagement',
      'ide',
      'taskManager',
      'worktrees',
      'envAutoLoad',
      'dev',
      'devServersPresets',
      'devProxy',
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

    it('keys the devServersPresets "apps" example by package, never a bare app folder', () => {
      const keys = appsExampleKeys(template)

      expect(keys.length).toBeGreaterThan(0)

      for (const key of keys) {
        expect(key).toMatch(/^[^/]+\/(api|ui)$/)
      }
    })

    it('marks devProxy deprecated and never prints a setup command the user cannot run', () => {
      // This template is seeded into the user's real `~/.infra-kit/*.example.jsonc`, so a stale instruction
      // here is not cosmetic — it is a command they will actually run. `--no-tls` would stand up a
      // plain-HTTP daemon on a stack whose every URL is now `https://`, breaking them at setup time. And
      // `1355` was the zero-sudo fallback, which no longer exists: there is no port-carrying mode left.
      //
      // It must also not print `sudo portless service install`: portless is a node_modules dependency, not a
      // PATH binary, so that command fails with `sudo: portless: command not found` (sudo's secure_path
      // defeats even a global install). A static template cannot know the absolute path, so it defers to
      // `infra-kit doctor`, which resolves it at runtime and prints the real command.
      expect(template).toContain('DEPRECATED')
      expect(template).toContain('infra-kit doctor')
      expect(template).not.toContain('sudo portless service install')
      expect(template).not.toContain('portless trust')
      expect(template).not.toContain('--no-tls')
      expect(template).not.toContain('1355')
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
