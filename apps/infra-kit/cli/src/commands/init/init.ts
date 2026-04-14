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
    line.startsWith('fi')
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
    // eslint-disable-next-line no-template-curly-in-string
    'if [[ -z "${INFRA_KIT_SESSION}" ]]; then',
    '  export INFRA_KIT_SESSION=$(head -c 4 /dev/urandom | xxd -p)',
    'fi',
    `env-load() { local f; f=$(${runCmd} env-load "$@") && source "$f" && ${runCmd} env-status; }`,
    `env-clear() { local f; f=$(${runCmd} env-clear) && source "$f" && ${runCmd} env-status; }`,
    `env-status() { ${runCmd} env-status; }`,
    `alias ik='${runCmd}'`,
    MARKER_END,
  ].join('\n')
}
