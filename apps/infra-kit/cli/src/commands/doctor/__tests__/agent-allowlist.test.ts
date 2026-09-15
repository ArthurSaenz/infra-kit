import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { commandCatalog } from 'src/lib/command-catalog'

import {
  INVOCATIONS,
  bashGlobOf,
  globReaches,
  inspectAgentAllowlist,
  mutatingCommandsReachedBy,
  readAllowPatterns,
} from '../agent-allowlist'

/**
 * The matching rule behind the `Agent allowlist` row (plan §3.8): which `Bash(...)` allow patterns
 * reach a `mutating: true` catalog row, through every spelling that lands on the binary. The rule is
 * over-approximate by design — a broad allow that happens to cover a mutating argv is a finding — so
 * the negatives here are the patterns that CANNOT reach one, not merely the ones a human would not
 * write.
 */

const MUTATING = commandCatalog
  .filter((entry) => {
    return entry.mutating
  })
  .map((entry) => {
    return entry.groupPath.join(' ')
  })

/**
 * Read-only LEAVES. A group row (`vendor`, `config`) is `mutating: false` itself but is the prefix of
 * mutating children, so an allow on it does reach them — correctly — and it is left out here.
 */
const READ_ONLY = commandCatalog
  .filter((entry) => {
    return (
      !entry.mutating &&
      !commandCatalog.some((other) => {
        return other !== entry && other.groupPath.join(' ').startsWith(`${entry.groupPath.join(' ')} `)
      })
    )
  })
  .map((entry) => {
    return entry.groupPath.join(' ')
  })

describe('bashGlobOf', () => {
  it('turns the :* suffix into a trailing wildcard', () => {
    expect(bashGlobOf('Bash(infra-kit release remove:*)')).toBe('infra-kit release remove*')
  })

  it('keeps an exact pattern exact', () => {
    expect(bashGlobOf('Bash(infra-kit release list --json)')).toBe('infra-kit release list --json')
  })

  it('reads a bare Bash as everything', () => {
    expect(bashGlobOf('Bash')).toBe('*')
    expect(bashGlobOf('Bash(*)')).toBe('*')
  })

  it('ignores patterns about other tools', () => {
    expect(bashGlobOf('Read(**)')).toBeNull()
    expect(bashGlobOf('mcp__plugin_infra-kit_infra-kit__release-remove')).toBeNull()
    expect(bashGlobOf('WebFetch(domain:example.com)')).toBeNull()
  })
})

describe('globReaches', () => {
  it('reaches through a prefix wider than the command', () => {
    expect(globReaches('infra-kit*', 'infra-kit release remove')).toBe(true)
    expect(globReaches('infra-kit release*', 'infra-kit release remove')).toBe(true)
  })

  it('reaches through an allow NARROWER than the command — the allow still covers a re-run', () => {
    expect(globReaches('infra-kit release remove --yes*', 'infra-kit release remove')).toBe(true)
    expect(globReaches('infra-kit release remove --yes', 'infra-kit release remove')).toBe(true)
  })

  it('reaches on an exact match', () => {
    expect(globReaches('infra-kit release remove', 'infra-kit release remove')).toBe(true)
  })

  it('does not reach a sibling command', () => {
    expect(globReaches('infra-kit release list*', 'infra-kit release remove')).toBe(false)
    expect(globReaches('infra-kit release list', 'infra-kit release remove')).toBe(false)
  })

  it('does not reach through a longer word that shares the prefix', () => {
    expect(globReaches('infra-kit release listing', 'infra-kit release list')).toBe(false)
  })

  it('reaches through a wildcard in the middle', () => {
    expect(globReaches('infra-kit * remove*', 'infra-kit release remove')).toBe(true)
    expect(globReaches('* infra-kit release remove*', 'pnpm exec infra-kit release remove')).toBe(true)
  })
})

describe('mutatingCommandsReachedBy', () => {
  it('reaches every mutating command from a whole-CLI allow, in catalog order', () => {
    expect(mutatingCommandsReachedBy('Bash(infra-kit:*)')).toEqual(MUTATING)
    expect(mutatingCommandsReachedBy('Bash')).toEqual(MUTATING)
  })

  it('reaches through every invocation spelling', () => {
    for (const invocation of INVOCATIONS) {
      expect(mutatingCommandsReachedBy(`Bash(${invocation}:*)`), invocation).toEqual(MUTATING)
      expect(mutatingCommandsReachedBy(`Bash(${invocation} release remove:*)`), invocation).toEqual(['release remove'])
    }
  })

  it('reaches a group through its group prefix', () => {
    expect(mutatingCommandsReachedBy('Bash(infra-kit worktrees:*)')).toEqual([
      'worktrees add',
      'worktrees remove',
      'worktrees sync',
    ])
  })

  it('reaches the flat cliName spelling as well as the grouped argv', () => {
    expect(mutatingCommandsReachedBy('Bash(ik release-remove:*)')).toEqual(['release remove'])
  })

  it('reaches nothing from a read-only allow', () => {
    for (const command of READ_ONLY) {
      expect(mutatingCommandsReachedBy(`Bash(infra-kit ${command}:*)`), command).toEqual([])
    }
  })

  /** A group row is read-only itself, but an allow on it covers its mutating children. */
  it('reaches the mutating children of a read-only group row', () => {
    expect(mutatingCommandsReachedBy('Bash(infra-kit vendor:*)')).toEqual(['vendor config'])
    expect(mutatingCommandsReachedBy('Bash(infra-kit vendor check:*)')).toEqual([])
  })

  /** A broad allow on the package manager is a true positive: `pnpm exec infra-kit … --yes` runs under it. */
  it('reaches through a bare pnpm allow', () => {
    expect(mutatingCommandsReachedBy('Bash(pnpm:*)')).toEqual(MUTATING)
  })

  it('reaches nothing from an unrelated allow or another tool', () => {
    expect(mutatingCommandsReachedBy('Bash(git:*)')).toEqual([])
    expect(mutatingCommandsReachedBy('Bash(pnpm run:*)')).toEqual([])
    expect(mutatingCommandsReachedBy('Bash(npx infra-kit:*)')).toEqual([])
    expect(mutatingCommandsReachedBy('Read(**)')).toEqual([])
  })

  it('names each command once, whichever invocations reach it', () => {
    const reached = mutatingCommandsReachedBy('Bash(*infra-kit*)')

    expect(new Set(reached).size).toBe(reached.length)
  })
})

describe('readAllowPatterns / inspectAgentAllowlist', () => {
  let repo: string

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-allowlist-'))
  })

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  const write = (file: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), content, 'utf-8')
  }

  it('reads a missing file as absent', () => {
    expect(readAllowPatterns(repo, '.claude/settings.json')).toEqual({ kind: 'absent' })
  })

  it('reads a file without permissions as an empty list, never unreadable', () => {
    write('.claude/settings.json', '{ "hooks": {} }')

    expect(readAllowPatterns(repo, '.claude/settings.json')).toEqual({ kind: 'read', patterns: [] })
  })

  it('reads invalid JSON and a non-array allow as unreadable', () => {
    write('.claude/settings.json', '{ nope')
    write('.claude/settings.local.json', '{ "permissions": { "allow": "Bash" } }')

    expect(readAllowPatterns(repo, '.claude/settings.json')).toEqual({
      kind: 'unreadable',
      file: '.claude/settings.json',
    })
    expect(readAllowPatterns(repo, '.claude/settings.local.json')).toEqual({
      kind: 'unreadable',
      file: '.claude/settings.local.json',
    })
  })

  it('keeps only string entries', () => {
    write('.claude/settings.json', '{ "permissions": { "allow": ["Bash(git:*)", 3, null] } }')

    expect(readAllowPatterns(repo, '.claude/settings.json')).toEqual({ kind: 'read', patterns: ['Bash(git:*)'] })
  })

  it('collects hits from both files, checked-in file first, and reports the unreadable one', () => {
    write('.claude/settings.json', '{ "permissions": { "allow": ["Bash(git:*)", "Bash(ik env-clear:*)"] } }')
    write('.claude/settings.local.json', '{ "permissions": { "allow": ["Bash(infra-kit release:*)"] } }')

    expect(inspectAgentAllowlist(repo)).toEqual({
      present: ['.claude/settings.json', '.claude/settings.local.json'],
      unreadable: [],
      hits: [
        { file: '.claude/settings.json', pattern: 'Bash(ik env-clear:*)', commands: ['env-clear'] },
        {
          file: '.claude/settings.local.json',
          pattern: 'Bash(infra-kit release:*)',
          commands: [
            'release merge-dev',
            'release create',
            'release desc-edit',
            'release deploy-all',
            'release deploy-selected',
            'release deliver',
            'release remove',
          ],
        },
      ],
    })
  })
})
