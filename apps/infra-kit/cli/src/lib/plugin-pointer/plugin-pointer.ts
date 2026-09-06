import fs from 'node:fs'
import path from 'node:path'

import { logger } from 'src/lib/logger'

/**
 * @fileoverview
 *
 * The two-key POINTER `infra-kit init` writes into a consumer repo's `.claude/settings.json`
 * so Claude Code knows where the `infra-kit` plugin marketplace lives and that the plugin is
 * enabled for that project.
 *
 * Why a pointer and not a copy: the keys name a marketplace and a repo — nothing that can go
 * stale — whereas a copied skill body rots the moment the CLI surface moves.
 *
 * MERGE SAFETY IS THE WHOLE POINT. Every consumer's `.claude/settings.json` already carries
 * `permissions.deny`, several `hooks` events, nine `enabledPlugins` and three
 * `extraKnownMarketplaces` entries — all hand-maintained. So this module ADDS each key only when
 * it is absent, never overwrites an existing value (a `false` there is a deliberate per-machine
 * opt-out), touches no other key, preserves key order and the file's own indentation, and writes
 * nothing at all when both keys are already present. A file it cannot parse is reported and left
 * byte-for-byte alone: rewriting what we could not read would destroy hand-written config.
 */

/** The marketplace name, as it appears in `extraKnownMarketplaces` and in `<plugin>@<marketplace>`. */
export const MARKETPLACE_NAME = 'infra-kit'

/** The `enabledPlugins` key: `<plugin>@<marketplace>`, both `infra-kit`. */
export const PLUGIN_KEY = 'infra-kit@infra-kit'

/** The GitHub repo the marketplace is served from. */
export const MARKETPLACE_REPO = 'ArthurSaenz/infra-kit'

/**
 * The one command a teammate runs by hand. `--scope project` is not decoration: it bounds where the
 * plugin's skills are active and writes `enabledPlugins` into the same `.claude/settings.json` this
 * module writes, so the two agree by construction.
 */
export const PLUGIN_INSTALL_COMMAND = `claude plugin install ${PLUGIN_KEY} --scope project`

/**
 * The command that makes the marketplace known to this machine, and the prerequisite of the one
 * above. Rendered from the same constants the automated install passes as argv, so the line a user
 * copies and the command `init` runs can never drift apart.
 */
export const MARKETPLACE_ADD_COMMAND = `claude plugin marketplace add ${MARKETPLACE_REPO}`

/** Indentation used for a file we create ourselves, and the fallback when detection finds none. */
const DEFAULT_INDENT = '  '

/** What `ensurePluginPointer` did. `unparseable` is the only outcome that wrote nothing on purpose. */
export type PluginPointerStatus = 'added' | 'created' | 'unchanged' | 'unparseable'

export interface PluginPointerResult {
  status: PluginPointerStatus
  /** The settings file that was inspected (written only for `added` / `created`). */
  path: string
  /** Dotted paths of the keys this run added, in insertion order. Empty for every other status. */
  added: readonly string[]
}

type JsonObject = Record<string, unknown>

/** The `extraKnownMarketplaces` value, minted fresh per call so no caller can alias our constant. */
const buildMarketplaceEntry = (): JsonObject => {
  return { source: { source: 'github', repo: MARKETPLACE_REPO } }
}

/** The whole file, for the absent-file path: exactly the two keys and nothing else. */
const buildInitialSettings = (): JsonObject => {
  return {
    extraKnownMarketplaces: { [MARKETPLACE_NAME]: buildMarketplaceEntry() },
    enabledPlugins: { [PLUGIN_KEY]: true },
  }
}

const isPlainObject = (value: unknown): value is JsonObject => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The file's own indent unit, taken from the first indented member line.
 *
 * Read rather than assumed so a re-serialized file differs from the original in the two added keys
 * and nothing else — a tab-indented settings file must not come back reindented to spaces, which
 * would land as a whole-file diff in the consumer's migration commit.
 */
const detectIndent = (raw: string): string => {
  const match = /\n([ \t]+)"/.exec(raw)

  return match?.[1] ?? DEFAULT_INDENT
}

/**
 * Add `key` under `container`, creating the container when missing.
 *
 * Returns the dotted path when it added something and `null` when it did not — which covers both
 * "already there" (the value stays whatever the user set, `false` included) and "the container
 * exists but is not an object", where the only safe move is to leave the file alone.
 */
const addMissingKey = (settings: JsonObject, container: string, key: string, value: unknown): string | null => {
  const existing = settings[container]

  if (existing === undefined) {
    settings[container] = { [key]: value }

    return `${container}.${key}`
  }

  if (!isPlainObject(existing) || key in existing) return null

  existing[key] = value

  return `${container}.${key}`
}

/** Both pointer keys, added in place. Returns the dotted paths actually added. */
const addPointerKeys = (settings: JsonObject): string[] => {
  const added = [
    addMissingKey(settings, 'extraKnownMarketplaces', MARKETPLACE_NAME, buildMarketplaceEntry()),
    addMissingKey(settings, 'enabledPlugins', PLUGIN_KEY, true),
  ]

  return added.filter((entry): entry is string => {
    return entry !== null
  })
}

const readSettingsFile = (settingsPath: string): string | null => {
  try {
    return fs.readFileSync(settingsPath, 'utf-8')
  } catch {
    return null
  }
}

/** Create the file (and its `.claude/` directory) with only the two keys. */
const createSettingsFile = (settingsPath: string): PluginPointerResult => {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, `${JSON.stringify(buildInitialSettings(), null, DEFAULT_INDENT)}\n`, 'utf-8')

  return {
    status: 'created',
    path: settingsPath,
    added: [`extraKnownMarketplaces.${MARKETPLACE_NAME}`, `enabledPlugins.${PLUGIN_KEY}`],
  }
}

/**
 * Ensure the two plugin-pointer keys exist in `.claude/settings.json`. Additive, idempotent, and
 * order-preserving; never overwrites an existing value and never touches another key.
 *
 * @example
 * ensurePluginPointer('/repo/.claude/settings.json')
 * // first run:  { status: 'added', added: ['extraKnownMarketplaces.infra-kit', 'enabledPlugins.infra-kit@infra-kit'] }
 * // second run: { status: 'unchanged', added: [] }  — no write, mtime untouched
 */
export const ensurePluginPointer = (settingsPath: string): PluginPointerResult => {
  const raw = readSettingsFile(settingsPath)

  if (raw === null) return createSettingsFile(settingsPath)

  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }

  if (!isPlainObject(parsed)) {
    logger.warn(
      `Could not parse ${settingsPath} — left it untouched. Add "${PLUGIN_KEY}" to enabledPlugins by hand, or fix the JSON and re-run: infra-kit init`,
    )

    return { status: 'unparseable', path: settingsPath, added: [] }
  }

  const added = addPointerKeys(parsed)

  if (added.length === 0) return { status: 'unchanged', path: settingsPath, added: [] }

  const indent = detectIndent(raw)
  const trailingNewline = raw.endsWith('\n') ? '\n' : ''

  fs.writeFileSync(settingsPath, `${JSON.stringify(parsed, null, indent)}${trailingNewline}`, 'utf-8')

  return { status: 'added', path: settingsPath, added }
}
