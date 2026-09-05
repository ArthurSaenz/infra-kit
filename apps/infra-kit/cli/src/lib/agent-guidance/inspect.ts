import { extractVersion, hasManagedBlock } from 'src/lib/managed-block'

import {
  PACKAGE_MARKER_END,
  PACKAGE_MARKER_START,
  PACKAGE_VERSION_PREFIX,
  ROOT_MARKER_END,
  ROOT_MARKER_START,
} from './markers'
import { PACKAGE_TYPES } from './package-type'
import type { PackageType } from './package-type'

/**
 * What a package's `CLAUDE.md` currently holds.
 *
 * - `ok` — a well-formed package block with a non-empty body.
 * - `missing` — the file itself does not exist.
 * - `no-block` — the file exists but carries no infra-kit markers at all.
 * - `malformed` — package markers are present but unusable: reversed, half a
 *   pair, or an empty body.
 * - `foreign-block` — no package block, but the repo-root block is there, i.e.
 *   the root `CLAUDE.md` was pasted into a package directory.
 */
export type GuidanceState = 'ok' | 'missing' | 'no-block' | 'malformed' | 'foreign-block'

export interface PackageGuidanceInspection {
  state: GuidanceState
  /** CLI version recorded in the block's version line. Only set when the state is `ok`. */
  version?: string
  /**
   * Package type recorded in the block's version line, validated against `PACKAGE_TYPES`.
   *
   * Absent when the line carries no type token, and equally when it names a type this CLI
   * does not know — the version line is read out of a file on disk, so an unvalidated token
   * is not necessarily a type at all. Callers render the absence as `unknown` rather than
   * repeating it as fact.
   */
  type?: PackageType
}

/** The text between the package markers, markers excluded. Assumes a well-formed pair. */
const readBlockBody = (content: string): string => {
  const start = content.indexOf(PACKAGE_MARKER_START) + PACKAGE_MARKER_START.length

  return content.slice(start, content.indexOf(PACKAGE_MARKER_END))
}

/**
 * The package type that follows the version on the version line, or `null`.
 *
 * The captured token is checked against `PACKAGE_TYPES` rather than trusted as written. The
 * version line ends in `-->`, so a block carrying no type token at all
 * (`<!-- infra-kit:package:version 0.4.0 -->`) otherwise captures `--` and reports the marker
 * terminator as the package's type.
 */
const readType = (body: string): PackageType | null => {
  const idx = body.indexOf(PACKAGE_VERSION_PREFIX)

  if (idx === -1) return null

  const token = body.slice(idx + PACKAGE_VERSION_PREFIX.length).match(/^\S+\s+([^\s>]+)/)?.[1]

  return (
    PACKAGE_TYPES.find((candidate) => {
      return candidate === token
    }) ?? null
  )
}

/**
 * Classify a package `CLAUDE.md`. Pure — the caller reads the file (passing
 * `null` when it does not exist) so the audit check, the `--fix` writer and
 * `doctor` all share one state machine.
 *
 * @example
 * inspectPackageGuidance(null)
 * // => { state: 'missing' }
 * @example
 * inspectPackageGuidance(
 *   '<!-- infra-kit:package:begin -->\n<!-- infra-kit:package:version 0.4.0 lib -->\nx\n<!-- infra-kit:package:end -->',
 * )
 * // => { state: 'ok', version: '0.4.0', type: 'lib' }
 */
export const inspectPackageGuidance = (content: string | null): PackageGuidanceInspection => {
  if (content === null) return { state: 'missing' }

  if (!hasManagedBlock(content, PACKAGE_MARKER_START, PACKAGE_MARKER_END)) {
    const halfPair = content.includes(PACKAGE_MARKER_START) || content.includes(PACKAGE_MARKER_END)

    if (halfPair) return { state: 'malformed' }

    return hasManagedBlock(content, ROOT_MARKER_START, ROOT_MARKER_END)
      ? { state: 'foreign-block' }
      : { state: 'no-block' }
  }

  const body = readBlockBody(content)

  if (body.trim() === '') return { state: 'malformed' }

  const inspection: PackageGuidanceInspection = { state: 'ok' }
  const version = extractVersion(body, PACKAGE_VERSION_PREFIX)
  const type = readType(body)

  if (version !== null) inspection.version = version
  if (type !== null) inspection.type = type

  return inspection
}
