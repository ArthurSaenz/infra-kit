import fs from 'node:fs'
import path from 'node:path'

import { commandCatalog } from 'src/lib/command-catalog'
import type { CommandCatalogEntry } from 'src/lib/command-catalog'

/**
 * @fileoverview
 *
 * The `Agent allowlist` doctor row: does a `Bash(...)` pattern in the repo's `.claude/settings*.json`
 * `permissions.allow` reach a MUTATING infra-kit command?
 *
 * WHY THIS IS A WARNING AT ALL. Claude Code's "don't ask again" writes a prefix allow, and after one
 * click every argv under that prefix runs unprompted for the rest of the project. The CLI's own guard
 * for an agent is preview-then-`--yes` (`.omc/plans/mcp-to-cli-skills-migration.md` §3.3) — a re-run
 * whose argv carries the destructive intent — so a prefix allow that covers the re-run is the one
 * thing that makes that guard silent. The plan chose to accept this and make it visible (§3.8) rather
 * than bind `--yes` to a digest; this row is the "visible" half.
 *
 * The rule over-approximates on purpose: `Bash(pnpm:*)` reaches `pnpm exec infra-kit release remove
 * --yes`, and the row says so. Naming a broad allow that happens to cover a mutating argv is the
 * point, not noise.
 */

/** Both project-scope settings files Claude Code merges, checked-in first. */
export const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'] as const

/**
 * Every spelling that lands on the infra-kit binary from a Bash line. `ik` is the shell alias the init
 * block defines; the `pnpm` forms are what a consumer's scripts and the root CLAUDE.md name.
 */
export const INVOCATIONS = ['infra-kit', 'ik', 'pnpm exec infra-kit', 'pnpm exec ik', 'pnpm infra-kit'] as const

export interface AllowlistHit {
  file: (typeof SETTINGS_FILES)[number]
  pattern: string
  /** The mutating commands the pattern reaches, as the grouped argv the CLI registers (`release remove`). */
  commands: string[]
}

export type AllowlistFileRead =
  | { kind: 'absent' }
  | { kind: 'unreadable'; file: (typeof SETTINGS_FILES)[number] }
  | { kind: 'read'; patterns: string[] }

const escapeRegExp = (text: string): string => {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The glob a `Bash(...)` pattern stands for, or `null` for a pattern about another tool. A bare
 * `Bash` (the whole tool allowed) is the glob `*`. Claude Code's `:*` suffix is its prefix-match
 * spelling; a `*` anywhere else is a wildcard too, so both collapse to one glob syntax.
 */
export const bashGlobOf = (pattern: string): string | null => {
  const trimmed = pattern.trim()

  if (trimmed === 'Bash') return '*'

  const match = /^Bash\((.*)\)$/s.exec(trimmed)

  if (match === null) return null

  const inner = match[1] ?? ''

  return inner.endsWith(':*') ? `${inner.slice(0, -2)}*` : inner
}

/**
 * Can an argv that STARTS with `command` match `glob`? Three ways, and any one is a reach:
 * the glob matches the command itself (`infra-kit*` vs `infra-kit release remove`); the glob's literal
 * head IS the command; or the head extends the command by further args (`infra-kit release remove
 * --yes*` still reaches `release remove` — the allow is narrower than the command, not disjoint).
 *
 * @example
 * globReaches('infra-kit*', 'infra-kit release remove') // => true
 * globReaches('infra-kit release list*', 'infra-kit release remove') // => false
 * globReaches('infra-kit release remove --yes*', 'infra-kit release remove') // => true
 */
export const globReaches = (glob: string, command: string): boolean => {
  const star = glob.indexOf('*')

  if (star === -1) return glob === command || glob.startsWith(`${command} `)

  const head = glob.slice(0, star)
  const matcher = new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`, 's')

  return matcher.test(command) || head === command || head.startsWith(`${command} `)
}

/** `release remove` and — when it differs — the flat `release-remove`, so a pattern spelling either is caught. */
const spellingsOf = (entry: CommandCatalogEntry): string[] => {
  const grouped = entry.groupPath.join(' ')

  return grouped === entry.cliName ? [grouped] : [grouped, entry.cliName]
}

const mutatingEntries = (): CommandCatalogEntry[] => {
  return commandCatalog.filter((entry) => {
    return entry.mutating
  })
}

/**
 * The mutating commands one allow pattern reaches, through any invocation. Grouped-argv names, in
 * catalog order, each at most once — a pattern that reaches `release remove` as `infra-kit …` and as
 * `ik …` is one finding, not two.
 *
 * @example
 * mutatingCommandsReachedBy('Bash(infra-kit worktrees:*)') // => ['worktrees add', 'worktrees remove', 'worktrees sync']
 * mutatingCommandsReachedBy('Bash(infra-kit release list:*)') // => []
 * mutatingCommandsReachedBy('Read(**)') // => []
 */
export const mutatingCommandsReachedBy = (pattern: string): string[] => {
  const glob = bashGlobOf(pattern)

  if (glob === null) return []

  return mutatingEntries()
    .filter((entry) => {
      return INVOCATIONS.some((invocation) => {
        return spellingsOf(entry).some((spelling) => {
          return globReaches(glob, `${invocation} ${spelling}`)
        })
      })
    })
    .map((entry) => {
      return entry.groupPath.join(' ')
    })
}

/**
 * `permissions.allow` of one settings file. Only `ENOENT` is `absent`; any other failure — unreadable,
 * not JSON, `allow` not an array — is `unreadable`, because "no pattern reaches" would be a claim the
 * row cannot back for a file it could not parse.
 */
export const readAllowPatterns = (root: string, file: (typeof SETTINGS_FILES)[number]): AllowlistFileRead => {
  let raw: string

  try {
    raw = fs.readFileSync(path.join(root, file), 'utf-8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', file }
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'unreadable', file }
  }

  const permissions = (parsed as { permissions?: unknown } | null)?.permissions

  if (permissions === undefined || permissions === null) return { kind: 'read', patterns: [] }

  const allow = (permissions as { allow?: unknown }).allow

  if (allow === undefined) return { kind: 'read', patterns: [] }
  if (!Array.isArray(allow)) return { kind: 'unreadable', file }

  return {
    kind: 'read',
    patterns: allow.filter((item): item is string => {
      return typeof item === 'string'
    }),
  }
}

export interface AllowlistInspection {
  /** The files that exist, whether or not they carry an allow list. */
  present: (typeof SETTINGS_FILES)[number][]
  unreadable: (typeof SETTINGS_FILES)[number][]
  hits: AllowlistHit[]
}

/**
 * Every offending pattern across both project settings files, in file order then list order.
 *
 * @example
 * inspectAgentAllowlist('/repo')
 * // => { present: ['.claude/settings.local.json'], unreadable: [],
 * //      hits: [{ file: '.claude/settings.local.json', pattern: 'Bash(infra-kit:*)', commands: ['dev', …] }] }
 */
export const inspectAgentAllowlist = (root: string): AllowlistInspection => {
  const inspection: AllowlistInspection = { present: [], unreadable: [], hits: [] }

  for (const file of SETTINGS_FILES) {
    const read = readAllowPatterns(root, file)

    if (read.kind === 'absent') continue

    inspection.present.push(file)

    if (read.kind === 'unreadable') {
      inspection.unreadable.push(file)
      continue
    }

    for (const pattern of read.patterns) {
      const commands = mutatingCommandsReachedBy(pattern)

      if (commands.length > 0) inspection.hits.push({ file, pattern, commands })
    }
  }

  return inspection
}
