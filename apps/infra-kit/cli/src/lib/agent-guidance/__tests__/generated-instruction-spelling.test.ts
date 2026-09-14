import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const CLI_ROOT = path.resolve(import.meta.dirname, '../../../..')
const REPO_ROOT = path.resolve(CLI_ROOT, '../../..')

/**
 * Files whose text is read as an instruction by a human or an agent: the guidance
 * bodies that render into every consumer's committed `CLAUDE.md`, and the two
 * READMEs that describe how to run the CLI.
 */
const instructionFiles = (): string[] => {
  const resources = path.join(CLI_ROOT, 'resources')

  const walk = (dir: string): string[] => {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) return walk(full)

      return entry.name.endsWith('.md') ? [full] : []
    })
  }

  return [...walk(resources), path.join(CLI_ROOT, 'readme.md'), path.join(REPO_ROOT, 'plugins/infra-kit/README.md')]
}

/**
 * The invariant is positional: `setup` may never LEAD a command spelling.
 *
 * The name resolves three ways in every repo that carries this text, and all three
 * mutate — `pnpm setup` (the pnpm builtin, which rewrites the global bin dir),
 * `pnpm run setup` (`runtime-set-node && pnpm install`, identical in all four consumer
 * repos), and `infra-kit setup` (this CLI's installer). A wrong guess does not error;
 * it succeeds at the wrong thing, which is why this is a test and not a convention.
 * Whatever binary precedes the word disambiguates it, and only `ik` / `infra-kit`
 * name this one.
 */
const isBareSetupInvocation = (spelling: string): boolean => {
  return spelling === 'setup' || spelling.startsWith('setup ')
}

/**
 * Every command spelling on a line: the contents of each inline-code span, plus each
 * line of a fenced block. A bare `setup` outside code is prose ("repo setup", "Set up
 * infra-kit") and is not an invocation anyone can type.
 */
const commandSpellings = (markdown: string): string[] => {
  const lines = markdown.split('\n')
  const spellings: string[] = []
  let fenced = false
  // Section-scoped exemption, and the only one. Under `## MCP Exposed Tools` the
  // names are MCP tool identities (the bare `setup` of `mcp__…__setup`), never shell argv — the ambiguity with `pnpm run setup` cannot be reached from a
  // tool name, and writing `infra-kit setup` there would name a tool that does not
  // exist.
  let exempt = false

  for (const line of lines) {
    if (line.startsWith('```')) {
      fenced = !fenced
      continue
    }

    if (!fenced && line.startsWith('#')) exempt = /^#+\s+MCP Exposed Tools\s*$/u.test(line)

    if (exempt) continue

    if (fenced) {
      spellings.push(line.trim())
      continue
    }

    for (const span of line.matchAll(/`([^`]+)`/gu)) spellings.push((span[1] ?? '').trim())
  }

  return spellings
}

const unqualifiedSetupSpellings = (markdown: string): string[] => {
  return commandSpellings(markdown).filter(isBareSetupInvocation)
}

describe('i-13 — generated instructions spell `setup` binary-qualified', () => {
  it.each(instructionFiles())('%s names no bare `setup` invocation', (file) => {
    expect(unqualifiedSetupSpellings(fs.readFileSync(file, 'utf8'))).toEqual([])
  })

  // The positive control. Without it the assertion above is green on any file set,
  // any regex that matches nothing, and any refactor that stops reading code spans.
  it('flags the two spellings that would collide with `pnpm run setup`', () => {
    expect(unqualifiedSetupSpellings('- run `setup` to install everything.')).toEqual(['setup'])
    expect(unqualifiedSetupSpellings('- `setup --tools gh` — narrow the converge.')).toEqual(['setup --tools gh'])
  })

  it('accepts both qualified spellings and leaves prose alone', () => {
    expect(unqualifiedSetupSpellings('- `ik setup` — set up infra-kit on this machine.')).toEqual([])
    expect(unqualifiedSetupSpellings('- `infra-kit setup --skip-tools` — the additive form.')).toEqual([])
    expect(unqualifiedSetupSpellings('- `ik doctor` — check auth and repo setup.')).toEqual([])
  })

  /**
   * A procedure body (the plugin's `setup` skill) names the `setup` TOOL in a code span outside any
   * exempt section, on either route's spelling. Neither is an invocation anyone can type, and neither
   * leads with `setup`.
   *
   * That is the whole reason the positional rule, and not a word match, is the invariant — pinned
   * here so a rewrite of `isBareSetupInvocation` to a substring test reddens on the identity it
   * would start flagging, rather than on every consumer's next `audit --fix`.
   */
  it('does not mistake an MCP tool identity for a bare invocation, on either route', () => {
    for (const tool of ['mcp__plugin_infra-kit_infra-kit__setup', 'mcp__infra-kit__setup']) {
      expect(unqualifiedSetupSpellings(`The tool is \`${tool}\`. Call it.`)).toEqual([])
    }
  })
})
