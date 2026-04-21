import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { logger } from 'src/lib/logger'

const MARKER_START = '# -- infra-kit:begin --'
const MARKER_END = '# -- infra-kit:end --'

const LEGACY_PAIRED: [start: string, end: string][] = [['# region infra-kit', '# endregion infra-kit']]
const LEGACY_SINGLE = '# infra-kit shell functions'

/**
 * Append infra-kit shell functions directly to .zshrc.
 */
export const init = async (): Promise<void> => {
  const zshrcPath = path.join(os.homedir(), '.zshrc')
  const shellBlock = buildShellBlock()

  if (fs.existsSync(zshrcPath)) {
    const content = fs.readFileSync(zshrcPath, 'utf-8')
    const cleaned = removeExistingBlock(content)

    fs.writeFileSync(zshrcPath, cleaned)
  }

  fs.appendFileSync(zshrcPath, `\n${shellBlock}\n`)
  logger.info(`Added infra-kit shell functions to ${zshrcPath}`)
  logger.info('Run `source ~/.zshrc` or open a new terminal to activate.')
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

const removeBetween = (content: string, start: string, end: string): string | null => {
  const startIdx = content.indexOf(start)
  const endIdx = content.indexOf(end)

  if (startIdx === -1 || endIdx === -1) return null

  // eslint-disable-next-line sonarjs/slow-regex
  const before = content.slice(0, startIdx).replace(/\n+$/, '')
  const after = content.slice(endIdx + end.length).replace(/^\n+/, '')

  return before + (after ? `\n${after}` : '')
}

const removeExistingBlock = (content: string): string => {
  // 1. Current markers
  const result = removeBetween(content, MARKER_START, MARKER_END)

  if (result !== null) return result

  // 2. Legacy paired markers (# region / # endregion)
  for (const [start, end] of LEGACY_PAIRED) {
    const legacyResult = removeBetween(content, start, end)

    if (legacyResult !== null) return legacyResult
  }

  // 3. Oldest format: single marker + heuristic scan
  const legacyIdx = content.indexOf(LEGACY_SINGLE)

  if (legacyIdx === -1) return content

  // eslint-disable-next-line sonarjs/slow-regex
  const before = content.slice(0, legacyIdx).replace(/\n+$/, '')
  const afterLines = content.slice(legacyIdx).split('\n')

  let i = 0

  while (i < afterLines.length && isBlockLine(afterLines[i]!)) {
    i++
  }

  const remaining = afterLines.slice(i).join('\n')

  return before + (remaining ? `\n${remaining}` : '')
}

const buildShellBlock = (): string => {
  const runCmd = 'pnpm exec infra-kit'

  return [
    MARKER_START,
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
    MARKER_END,
  ].join('\n')
}
