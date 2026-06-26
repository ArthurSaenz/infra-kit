import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { logger } from 'src/lib/logger'
import { removeManagedBlock, upsertManagedBlock } from 'src/lib/managed-block'

import { writeAgentFiles } from './agent-files'
import {
  migrateFactoryConfigToJson,
  migrateLegacyConfig,
  migrateUserGlobalConfigFilename,
  normalizeLegacyIdeStructures,
} from './migrate-config'

export const MARKER_START = '# -- infra-kit:begin --'
export const MARKER_END = '# -- infra-kit:end --'

const LEGACY_PAIRED: [start: string, end: string][] = [['# region infra-kit', '# endregion infra-kit']]
const LEGACY_SINGLE = '# infra-kit shell functions'

// JSON can't carry comments, so the real config is an empty-but-valid object…
const USER_GLOBAL_CONFIG_STUB = '{}\n'

// …and the annotated guidance lives next to it in a non-loaded .example.jsonc
// (the loader only reads the three exact `infra-kit.json` files).
const USER_GLOBAL_CONFIG_EXAMPLE = `// infra-kit user-global config — ~/.infra-kit/infra-kit.json
//
// Merge chain (later layers override earlier ones at top-level keys):
//   1. <repo>/infra-kit.json                            — committed project config (required)
//   2. ~/.infra-kit/infra-kit.json                      — user-global (the sibling of this file)
//   3. ~/.infra-kit/projects/<repo-name>/infra-kit.json — user-scope per-project override
//
// Merge is shallow: setting a top-level key replaces that whole section from
// layer 1. Arrays do not concatenate. Top-level keys recognized:
// environments, envManagement, ide, taskManager, worktrees, envAutoLoad.
//
// This .example.jsonc is reference only — it is NOT loaded. Put real global
// overrides in the sibling infra-kit.json (strict JSON: no comments, double-quoted
// keys). Per-project tweaks belong in layer 3 — run \`infra-kit config edit\`.
//
// Every recognized key is documented below. NOTE: \`environments\` and
// \`envManagement\` are REQUIRED in the committed project infra-kit.json (layer 1)
// and are usually NOT set in this user-global layer — they are shown here only to
// document the full, valid config shape.
{
  // "environments": ["dev", "staging", "prod"],   // string[] (>=1) — required in layer 1
  //
  // "envManagement": {                            // required in layer 1; provider-tagged
  //   "provider": "doppler",
  //   "config": { "name": "my-doppler-project" }
  // },
  //
  // "ide": {
  //   "provider": "cursor",
  //   "config": { "workspaceConfigPath": "/path/to/your.code-workspace" }
  // },
  // // Or, for Zed (no workspace file — one window with all worktrees via "zed <root> <wt...>"):
  // "ide": { "provider": "zed", "config": {} },
  // // Or drive BOTH editors at once with an array (at most one entry per provider):
  // "ide": [
  //   { "provider": "cursor", "config": { "workspaceConfigPath": "/path/to/your.code-workspace" } },
  //   { "provider": "zed", "config": {} }
  // ],
  //
  // "taskManager": {
  //   "provider": "jira",
  //   "config": { "baseUrl": "https://acme.atlassian.net", "projectId": 123 }
  // },
  //
  // "worktrees": {
  //   "openInGithubDesktop": false,
  //   "openInCmux": true,
  //   // cmux pane layout for opened worktrees: "two-columns" (default, left | right)
  //   // or "three-pane" (left split top/bottom + full-height right).
  //   "cmux": { "layout": "two-columns" }
  // },
  //
  // // Auto-load Doppler env when working inside this project/worktree. Omit to
  // // disable. "trigger" (pick one): "shell-startup" (new shells) | "cli-invocation"
  // // (before each infra-kit command, primes subsequent commands). "config" is the
  // // environment to load (must be one of "environments"). Requires the committed
  // // infra-kit.json at the git repo root, and the zsh shell integration
  // // (infra-kit init + a new shell). zsh only.
  // "envAutoLoad": { "trigger": "shell-startup", "config": "dev" }
}
`

// The machine-local factory registry lives at ~/.infra-kit/vendor.json (strict
// JSON). This annotated sibling documents every property; the real file is
// scaffolded by \`infra-kit vendor config --init\`, NOT by init.
const VENDOR_CONFIG_EXAMPLE = `// infra-kit factory registry — ~/.infra-kit/vendor.json
//
// Machine-local registry the vendor commands (sync/manifest/diff) read to know
// where your project repos live and which ones to stamp. This .example.jsonc is
// reference only — it is NOT loaded. The real file is the strict-JSON sibling
// vendor.json (no comments, double-quoted keys); run \`infra-kit vendor config --init\`
// to scaffold it.
{
  // "workspaceDir": "~/projects",   // string (absolute or ~-prefixed) — where target repos are cloned
  // "targets": ["my-repo-a", "my-repo-b"]   // string[] (>=1) — repo dir names resolved under workspaceDir
}
`

/**
 * Append infra-kit shell functions to .zshrc, migrate any legacy `infra-kit.yml`
 * config layers to JSON, normalize existing JSON configs from the old IDE structure
 * (strip the removed `ide.config.mode`), convert a legacy factory `vendor.config.ts`
 * to `vendor.json`, and seed the user-global config at ~/.infra-kit/infra-kit.json on
 * first run. Idempotent: a subsequent run replaces the existing zshrc block in place,
 * has nothing left to migrate or normalize, and leaves the REAL config files
 * (infra-kit.json / vendor.json) untouched — but the annotated `.example.jsonc`
 * reference files are refreshed on every run so they always reflect the current schema.
 *
 * @example
 * // CLI: `infra-kit init`  (or via the `pnpm dx-init` alias)
 * // INFO: Added infra-kit shell functions to /Users/me/.zshrc
 * // INFO: Wrote user-global config to /Users/me/.infra-kit/infra-kit.json (see …/infra-kit.example.jsonc …)
 * // INFO: Run `source ~/.zshrc` or open a new terminal to activate.
 */
export const init = async (): Promise<void> => {
  const zshrcPath = path.join(os.homedir(), '.zshrc')

  // Strip any prior block (current or legacy markers) anywhere in the file, then
  // append a fresh block at end-of-file via the shared managed-block utility —
  // the historical `removeExistingBlock` + append behavior, now centralized.
  const existing = fs.existsSync(zshrcPath) ? removeExistingBlock(fs.readFileSync(zshrcPath, 'utf-8')) : ''

  const updated = upsertManagedBlock({
    content: existing,
    body: buildShellBody(),
    startMarker: MARKER_START,
    endMarker: MARKER_END,
    placement: 'append-end',
  })

  fs.writeFileSync(zshrcPath, updated)

  logger.info(`Added infra-kit shell functions to ${zshrcPath}`)

  // Convert any legacy infra-kit.yml config layers to JSON before seeding, so a
  // migrated infra-kit.json is not re-seeded as an empty stub.
  await migrateLegacyConfig()

  // Migrate existing JSON configs from the old IDE structure to the new one
  // (strip the removed `ide.config.mode` field). No-op for already-clean configs.
  await normalizeLegacyIdeStructures()

  // Rename a legacy user-global config.json → infra-kit.json (single canonical
  // filename). MUST run before seeding: otherwise the seeder checks the new name,
  // doesn't find it, and writes an empty stub that shadows the user's real config.
  await migrateUserGlobalConfigFilename()

  // Convert a legacy machine-local factory config from executable TS
  // (~/.infra-kit/vendor.config.ts) to static JSON (~/.infra-kit/vendor.json).
  // Independent of the infra-kit.json layers; grouped with the other migrations.
  await migrateFactoryConfigToJson()

  seedUserGlobalConfig()

  // Best-effort, non-fatal, repo-gated: keep the agent-instruction files in sync
  // with the CLI surface. A no-op outside an infra-kit repo.
  await writeAgentFiles()

  // The shell integration is zsh-only (zmodload zsh/stat, add-zsh-hook, ${dir:h}).
  // Warn non-fatally if the user's login shell isn't zsh so the block isn't a
  // silent no-op for them.
  const shell = process.env.SHELL ?? ''

  if (!shell.includes('zsh')) {
    logger.warn(
      `Your login shell ($SHELL=${shell || 'unset'}) is not zsh. The infra-kit shell integration (env-load/env-clear/auto-load) is zsh-only and won't activate in bash/fish.`,
    )
  }

  logger.info('Run `source ~/.zshrc` or open a new terminal to activate.')
}

/**
 * Seed the user-global config on first run and (re)write the annotated reference
 * files. The real `~/.infra-kit/infra-kit.json` (empty `{}`) is written only when
 * absent so user edits are preserved. The non-loaded `.example.jsonc` reference
 * files (`infra-kit.example.jsonc` + `vendor.example.jsonc`) are rewritten on EVERY
 * run so existing users always get the current, complete schema documentation.
 *
 * Deliberately seeds NO real `vendor.json` — that is scaffolded by
 * `infra-kit vendor config --init` (a stub here would block `--init`, trip the
 * factory migration's no-overwrite guard, and fail the schema's `targets.min(1)`).
 *
 * @example
 * seedUserGlobalConfig()
 * // first call:  writes ~/.infra-kit/infra-kit.json ({}) + both .example.jsonc files
 * // later calls: leaves infra-kit.json alone, refreshes both .example.jsonc files
 */
export const seedUserGlobalConfig = (): void => {
  const userConfigDir = path.join(os.homedir(), '.infra-kit')
  const userConfigPath = path.join(userConfigDir, 'infra-kit.json')

  fs.mkdirSync(userConfigDir, { recursive: true })

  // Reference examples are non-loaded docs — always refresh them so re-running init
  // delivers the current schema (and the newly-added vendor example) to existing users.
  fs.writeFileSync(path.join(userConfigDir, 'infra-kit.example.jsonc'), USER_GLOBAL_CONFIG_EXAMPLE, 'utf-8')
  fs.writeFileSync(path.join(userConfigDir, 'vendor.example.jsonc'), VENDOR_CONFIG_EXAMPLE, 'utf-8')

  if (fs.existsSync(userConfigPath)) {
    logger.info(`User-global config already present at ${userConfigPath} (refreshed reference examples)`)

    return
  }

  fs.writeFileSync(userConfigPath, USER_GLOBAL_CONFIG_STUB, 'utf-8')

  logger.info(`Wrote user-global config to ${userConfigPath} (see the sibling .example.jsonc files for reference)`)
}

const isBlockLine = (line: string): boolean => {
  return (
    line.startsWith('#') ||
    line.startsWith('alias ') ||
    line.startsWith('env-load') ||
    line.startsWith('env-clear') ||
    line.startsWith('env-status') ||
    line.startsWith('if ') ||
    line.startsWith('  export INFRA_KIT_SESSION') ||
    line.startsWith('export _INFRA_KIT_') ||
    line.startsWith(': ${_INFRA_KIT_') ||
    line.startsWith('fi') ||
    line.startsWith('zmodload ') ||
    line.startsWith('autoload ') ||
    line.startsWith('add-zsh-hook ') ||
    line.startsWith('_infra_kit_autoload')
  )
}

const removeExistingBlock = (content: string): string => {
  // 1. Current markers
  const result = removeManagedBlock(content, MARKER_START, MARKER_END)

  if (result !== null) return result

  // 2. Legacy paired markers (# region / # endregion)
  for (const [start, end] of LEGACY_PAIRED) {
    const legacyResult = removeManagedBlock(content, start, end)

    if (legacyResult !== null) return legacyResult
  }

  // 3. Oldest format: single marker + heuristic scan
  const legacyIdx = content.indexOf(LEGACY_SINGLE)

  if (legacyIdx === -1) return content

  // eslint-disable-next-line sonarjs/super-linear-regex
  const before = content.slice(0, legacyIdx).replace(/\n+$/, '')
  const afterLines = content.slice(legacyIdx).split('\n')

  let i = 0

  while (i < afterLines.length && isBlockLine(afterLines[i]!)) {
    i++
  }

  const remaining = afterLines.slice(i).join('\n')

  return before + (remaining ? `\n${remaining}` : '')
}

/**
 * The inner shell-function lines (no markers). Composed into the full marked
 * block by {@link buildShellBlock} and fed to `upsertManagedBlock` by `init()`.
 */
export const buildShellBody = (): string => {
  const runCmd = 'pnpm exec infra-kit'

  return [
    'zmodload zsh/stat 2>/dev/null',
    'zmodload zsh/datetime 2>/dev/null',
    // eslint-disable-next-line no-template-curly-in-string
    'if [[ -z "${INFRA_KIT_SESSION}" ]]; then',
    '  export INFRA_KIT_SESSION=$(head -c 4 /dev/urandom | xxd -p)',
    'fi',
    // eslint-disable-next-line no-template-curly-in-string
    ': ${_INFRA_KIT_LAST_LOAD_MTIME:=0}',
    // eslint-disable-next-line no-template-curly-in-string
    ': ${_INFRA_KIT_LAST_CLEAR_MTIME:=0}',
    // eslint-disable-next-line no-template-curly-in-string
    ': ${_INFRA_KIT_SHELL_STARTED:=${EPOCHSECONDS:-0}}',
    'export _INFRA_KIT_LAST_LOAD_MTIME _INFRA_KIT_LAST_CLEAR_MTIME _INFRA_KIT_SHELL_STARTED',
    `env-load() { local f m; f=$(${runCmd} env-load "$@") || return; m=$(zstat +mtime -- "$f" 2>/dev/null || echo 0); _INFRA_KIT_LAST_LOAD_MTIME=$m; source "$f"; ${runCmd} env-status; }`,
    `env-clear() { local f m; f=$(${runCmd} env-clear) || return; m=$(zstat +mtime -- "$f" 2>/dev/null || echo 0); _INFRA_KIT_LAST_CLEAR_MTIME=$m; source "$f"; ${runCmd} env-status; }`,
    `env-status() { ${runCmd} env-status; }`,
    `alias ik='${runCmd}'`,
    '_infra_kit_autoload() {',
    '  [[ -z "$INFRA_KIT_SESSION" ]] && return',
    // eslint-disable-next-line no-template-curly-in-string
    '  local cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/infra-kit"',
    '  local dir="$cache_root/$INFRA_KIT_SESSION"',
    '  local load_file="$dir/env-load.sh"',
    '  local clear_file="$dir/env-clear.sh"',
    '  local mtime',
    '  if [[ -f "$load_file" ]]; then',
    '    mtime=$(zstat +mtime -- "$load_file" 2>/dev/null || echo 0)',
    '    if (( mtime > _INFRA_KIT_LAST_LOAD_MTIME && mtime >= _INFRA_KIT_SHELL_STARTED )); then',
    '      source "$load_file"',
    '      _INFRA_KIT_LAST_LOAD_MTIME=$mtime',
    // eslint-disable-next-line no-template-curly-in-string
    '      print -u2 "infra-kit: auto-loaded vars for ${INFRA_KIT_ENV_CONFIG:-?}"',
    '    fi',
    '  fi',
    '  if [[ -f "$clear_file" ]]; then',
    '    mtime=$(zstat +mtime -- "$clear_file" 2>/dev/null || echo 0)',
    '    if (( mtime > _INFRA_KIT_LAST_CLEAR_MTIME && mtime >= _INFRA_KIT_SHELL_STARTED )); then',
    '      source "$clear_file"',
    '      _INFRA_KIT_LAST_CLEAR_MTIME=$mtime',
    '      print -u2 "infra-kit: auto-cleared env"',
    '    fi',
    '  fi',
    '}',
    'autoload -Uz add-zsh-hook',
    'if (( _INFRA_KIT_SHELL_STARTED > 0 )); then',
    '  add-zsh-hook precmd _infra_kit_autoload',
    'fi',
    // One-shot env auto-load when a NEW shell opens inside an infra-kit project
    // or worktree (config: envAutoLoad.trigger "shell-startup"). Cheap pure-zsh
    // project gate (walk up for infra-kit.json) avoids spawning node in unrelated
    // shells; the INFRA_KIT_ENV_CONFIG guard skips subshells that already inherited
    // a loaded env. The spawn is DETACHED+backgrounded ( ... & ) so it never blocks
    // the prompt; it only WRITES env-load.sh and the precmd hook above is the sole
    // sourcer (picked up on a subsequent prompt). Trade-off: the gate can't read the
    // merged JSON config, so a fresh shell in a project WITHOUT envAutoLoad still
    // spawns one background process that resolves config, finds nothing, and exits.
    '_infra_kit_startup_autoload() {',
    '  [[ -z "$INFRA_KIT_SESSION" ]] && return',
    '  [[ -n "$INFRA_KIT_ENV_CONFIG" ]] && return',
    '  local dir="$PWD"',
    '  while [[ "$dir" != / ]]; do',
    '    if [[ -f "$dir/infra-kit.json" ]]; then',
    `      ( ${runCmd} env-autoload & ) >/dev/null 2>&1`,
    '      return',
    '    fi',
    // eslint-disable-next-line no-template-curly-in-string
    '    dir="${dir:h}"',
    '  done',
    '}',
    'if (( _INFRA_KIT_SHELL_STARTED > 0 )); then',
    '  _infra_kit_startup_autoload',
    'fi',
  ].join('\n')
}

/**
 * The full marker-delimited shell block (`MARKER_START … MARKER_END`). Kept as
 * a single composed string so `doctor`'s exact-match freshness check stays valid.
 */
export const buildShellBlock = (): string => {
  return `${MARKER_START}\n${buildShellBody()}\n${MARKER_END}`
}
