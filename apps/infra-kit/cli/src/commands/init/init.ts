import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { seedCreatedMessage, seedUserProjectConfig } from 'src/lib/config-bootstrap'
import { CONFIG_STUB, buildUserGlobalExample, buildVendorExample } from 'src/lib/config-templates'
import { getInfraKitConfigPaths } from 'src/lib/infra-kit-config'
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

  // Close the legacy-yml migration gap so a single `dx-init` leaves EVERY example current.
  await reseedUserProjectConfig()

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
  fs.writeFileSync(path.join(userConfigDir, 'infra-kit.example.jsonc'), buildUserGlobalExample(), 'utf-8')
  fs.writeFileSync(path.join(userConfigDir, 'vendor.example.jsonc'), buildVendorExample(), 'utf-8')

  if (fs.existsSync(userConfigPath)) {
    logger.info(`User-global config already present at ${userConfigPath} (refreshed reference examples)`)

    return
  }

  fs.writeFileSync(userConfigPath, CONFIG_STUB, 'utf-8')

  logger.info(`Wrote user-global config to ${userConfigPath} (see the sibling .example.jsonc files for reference)`)
}

/**
 * Re-run the layer-3 seed at the END of `init()`, closing the legacy-yml migration gap.
 *
 * The per-command seed lives in the program's preAction hook, which evaluates its "is this an
 * infra-kit repo?" gate (does `<repo-root>/infra-kit.json` exist?) BEFORE the action body runs. On
 * the legacy-yml migration path `init()` itself CREATES that file (`migrateLegacyConfig`), so the
 * gate had already declined and this very run would otherwise leave the layer-3 example unwritten —
 * self-healing only on the user's next command. Re-running the gate here makes one `dx-init` enough.
 *
 * The UNGATED primitive, deliberately: `ensureUserProjectConfig()` is an ENTRY-BOUNDARY primitive
 * whose once-per-process guard has ALREADY fired in preAction, so calling it here would be a silent
 * no-op. It is unusable as a re-seed hook. Anything else (no git repo, no project config, an
 * unwritable `$HOME`) degrades to a debug line — seeding a reference file must never fail `init`.
 *
 * Separate from {@link seedUserGlobalConfig}, which keeps its layer-2-only duty and stays sync.
 *
 * Honours `INFRA_KIT_NO_SEED` itself: the primitive is ungated by design, so without this check the
 * kill switch would be airtight on every path EXCEPT `init`.
 *
 * @example
 * await reseedUserProjectConfig()
 * // after a legacy infra-kit.yml migration:
 * // INFO: Created ~/.infra-kit/projects/api/infra-kit.json — see …/infra-kit.example.jsonc …
 */
const reseedUserProjectConfig = async (): Promise<void> => {
  if (process.env.INFRA_KIT_NO_SEED) return

  try {
    const paths = await getInfraKitConfigPaths()

    // The same D2 gate the preAction seed applies — re-evaluated now that the migrations have run.
    if (!fs.existsSync(paths.main)) return

    const result = await seedUserProjectConfig(paths)

    if (result.createdConfig) {
      logger.info(seedCreatedMessage(result))
    }
  } catch (err) {
    logger.debug({ err, msg: 'Skipped seeding the user-project config (init).' })
  }
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

export const removeExistingBlock = (content: string): string => {
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
    'zmodload zsh/sched 2>/dev/null',
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
    // Warm-cache source TTL (seconds); MUST equal DEFAULT_WARM_TTL_SECONDS (node
    // eviction) — both 2h. A warm file older than this is not sourced at startup.
    // eslint-disable-next-line no-template-curly-in-string
    ': ${_INFRA_KIT_WARM_TTL:=7200}',
    'export _INFRA_KIT_LAST_LOAD_MTIME _INFRA_KIT_LAST_CLEAR_MTIME _INFRA_KIT_SHELL_STARTED _INFRA_KIT_WARM_TTL',
    `env-load() { local f m; f=$(${runCmd} env-load "$@") || return; m=$(zstat +mtime -- "$f" 2>/dev/null || echo 0); _INFRA_KIT_LAST_LOAD_MTIME=$m; source "$f"; ${runCmd} env-status; }`,
    `env-clear() { local f m; f=$(${runCmd} env-clear "$@") || return; m=$(zstat +mtime -- "$f" 2>/dev/null || echo 0); _INFRA_KIT_LAST_CLEAR_MTIME=$m; source "$f"; ${runCmd} env-status; }`,
    `env-status() { ${runCmd} env-status; }`,
    // No `alias ik=…` here: a global install provides real `infra-kit` and `ik` bins, and an alias
    // would SHADOW the global `ik`, forcing the project-local `pnpm exec` even when a global CLI exists.
    // (`isBlockLine` still lists `alias ` so re-running `init` strips the stale alias from old configs.)
    // Print an async notice without corrupting an already-drawn prompt. The
    // startup poll fires via `sched` at an IDLE prompt (ZLE active) which does
    // NOT redraw the prompt, so a bare `print` lands appended to the visible
    // prompt line and looks like un-removable typed input. When ZLE is active we
    // erase the current line (CR + clear-to-EOL), print the message on its own
    // line, then `zle reset-prompt` to redraw the prompt below it. In precmd /
    // shell-startup (ZLE inactive) `zle` is false and this is a plain stderr
    // print above the about-to-be-drawn prompt — unchanged behavior.
    '_infra_kit_notify() {',
    // When ZLE is active, erase the current prompt line first and redraw after;
    // both are no-ops when ZLE is inactive so this stays a plain stderr print.
    "  zle && print -u2 -n $'\\r\\e[K'",
    '  print -u2 -- "$1"',
    '  zle && zle reset-prompt',
    '}',
    '_infra_kit_autoload() {',
    '  [[ -z "$INFRA_KIT_SESSION" ]] && return',
    // eslint-disable-next-line no-template-curly-in-string
    '  local cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/infra-kit"',
    '  local dir="$cache_root/$INFRA_KIT_SESSION"',
    '  local load_file="$dir/env-load.sh"',
    '  local clear_file="$dir/env-clear.sh"',
    '  local load_mtime=0 clear_mtime=0',
    '  [[ -f "$load_file" ]] && load_mtime=$(zstat +mtime -- "$load_file" 2>/dev/null || echo 0)',
    '  [[ -f "$clear_file" ]] && clear_mtime=$(zstat +mtime -- "$clear_file" 2>/dev/null || echo 0)',
    '  if (( load_mtime > _INFRA_KIT_LAST_LOAD_MTIME && load_mtime >= _INFRA_KIT_SHELL_STARTED && load_mtime >= clear_mtime )); then',
    '    source "$load_file"',
    '    _INFRA_KIT_LAST_LOAD_MTIME=$load_mtime',
    // eslint-disable-next-line no-template-curly-in-string
    '    _infra_kit_notify "infra-kit: auto-loaded vars for ${INFRA_KIT_ENV_CONFIG:-?}"',
    '  fi',
    '  if (( clear_mtime > _INFRA_KIT_LAST_CLEAR_MTIME && clear_mtime >= _INFRA_KIT_SHELL_STARTED && clear_mtime > load_mtime )); then',
    '    source "$clear_file"',
    '    _INFRA_KIT_LAST_CLEAR_MTIME=$clear_mtime',
    '    _infra_kit_notify "infra-kit: auto-cleared env"',
    '  fi',
    '}',
    'autoload -Uz add-zsh-hook',
    'if (( _INFRA_KIT_SHELL_STARTED > 0 )); then',
    '  add-zsh-hook precmd _infra_kit_autoload',
    'fi',
    // Non-blocking startup poll: the shell-startup spawn (below) writes env-load.sh
    // asynchronously (node + Doppler fetch, ~0.5-2s), so the FIRST precmd — which
    // fires before the first prompt — runs before the file lands and sources nothing;
    // without this the vars only appear after the user's first command. This one-shot
    // re-arming poll re-runs the precmd sourcer once per second, at the idle prompt
    // with NO user command, until it sources the freshly written file (its mtime is
    // >= _INFRA_KIT_SHELL_STARTED so the existing gate accepts it) OR the startup
    // window closes. _infra_kit_autoload sets _INFRA_KIT_LAST_LOAD_MTIME on a
    // successful source, which lifts it to >= _INFRA_KIT_SHELL_STARTED and stops the
    // re-arm. Bounded to WINDOW seconds so an unconfigured project / down Doppler
    // that never writes a file only costs a handful of no-op ticks, then falls back
    // to the precmd hook. Sources the same freshly written file as precmd, so there
    // is no stale/last-known-good secrets window.
    '_INFRA_KIT_AUTOLOAD_WINDOW=6',
    'export _INFRA_KIT_AUTOLOAD_WINDOW',
    '_infra_kit_poll_autoload() {',
    '  _infra_kit_autoload',
    // eslint-disable-next-line no-template-curly-in-string
    '  if (( _INFRA_KIT_LAST_LOAD_MTIME < _INFRA_KIT_SHELL_STARTED )) && (( ${EPOCHSECONDS:-0} - _INFRA_KIT_SHELL_STARTED < _INFRA_KIT_AUTOLOAD_WINDOW )); then',
    '    (( $+builtins[sched] )) && sched +1 _infra_kit_poll_autoload',
    '  fi',
    '}',
    // Warm cache: source the project-scoped last-known-good env-load.sh INSTANTLY at
    // startup (pure zsh, no node/Doppler) so vars are present at prompt-0, before the
    // backgrounded refresh lands. `key` is sha256 of the canonical project dir passed
    // in by the caller — byte-identical to node's warmCacheKey (printf %s | shasum,
    // full 64-hex). Skips when: no sha tool (degrade to poll), no warm file, a project
    // clear-marker is at least as new (clear wins ties), or the file is past TTL
    // (bounds a rotated secret served at prompt-0). Deliberately does NOT set
    // _INFRA_KIT_LAST_LOAD_MTIME (leaves it 0) so the poll/precmd still source the
    // fresh SESSION file (different path, newer mtime) and upgrade warm->fresh.
    '_infra_kit_warm_source() {',
    '  local canon="$1" key',
    '  if (( $+commands[shasum] )); then',
    '    key=$(printf %s "$canon" | shasum -a 256 | cut -c1-64)',
    '  elif (( $+commands[sha256sum] )); then',
    '    key=$(printf %s "$canon" | sha256sum | cut -c1-64)',
    '  else',
    '    return',
    '  fi',
    // eslint-disable-next-line no-template-curly-in-string
    '  local cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/infra-kit"',
    '  local warm="$cache_root/projects/$key/env-load.sh"',
    '  local wclear="$cache_root/projects/$key/env-clear.sh"',
    '  [[ -f "$warm" ]] || return',
    '  local wm=0 cm=0',
    '  wm=$(zstat +mtime -- "$warm" 2>/dev/null || echo 0)',
    '  [[ -f "$wclear" ]] && cm=$(zstat +mtime -- "$wclear" 2>/dev/null || echo 0)',
    '  (( cm >= wm )) && return',
    // eslint-disable-next-line no-template-curly-in-string
    '  (( ${EPOCHSECONDS:-0} - wm >= _INFRA_KIT_WARM_TTL )) && return',
    '  source "$warm"',
    // eslint-disable-next-line no-template-curly-in-string
    '  _infra_kit_notify "infra-kit: loaded cached vars for ${INFRA_KIT_ENV_CONFIG:-?} (refreshing…)"',
    '}',
    // One-shot env auto-load when a NEW shell opens inside an infra-kit project
    // or worktree (config: envAutoLoad.trigger "shell-startup"). Cheap pure-zsh
    // project gate (walk up for infra-kit.json) avoids spawning node in unrelated
    // shells; the spawn is skipped only when the already-loaded env belongs to THIS
    // project root (INFRA_KIT_ENV_PROJECT_ROOT), so cd'ing into a DIFFERENT project
    // re-loads instead of silently keeping the previous project's secrets. The spawn
    // is DETACHED+backgrounded ( ... & ) so it never blocks the prompt; it only
    // WRITES env-load.sh. The startup poll armed right after (and the precmd hook as
    // a later-prompt fallback) sources the file once it lands. Trade-off: the gate
    // can't read the merged JSON config, so a fresh shell in a project WITHOUT
    // envAutoLoad still spawns one background process that resolves config, finds
    // nothing, and exits.
    '_infra_kit_startup_autoload() {',
    '  [[ -z "$INFRA_KIT_SESSION" ]] && return',
    '  local dir="$PWD" prev=""',
    '  while [[ -n "$dir" && "$dir" != "$prev" ]]; do',
    '    if [[ -f "$dir/infra-kit.json" ]]; then',
    '      [[ -n "$INFRA_KIT_ENV_CONFIG" && "$dir" == "$INFRA_KIT_ENV_PROJECT_ROOT" ]] && return',
    // canon = realpath of the project dir; the SAME string node hashes for the warm
    // key (passed via --project-dir), so the two keys are byte-identical.
    // eslint-disable-next-line no-template-curly-in-string
    '      local canon="${dir:A}"',
    '      _infra_kit_warm_source "$canon"',
    `      ( ${runCmd} env-autoload --project-dir "$canon" & ) >/dev/null 2>&1`,
    '      (( $+builtins[sched] )) && sched +1 _infra_kit_poll_autoload',
    '      return',
    '    fi',
    '    prev="$dir"',
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
