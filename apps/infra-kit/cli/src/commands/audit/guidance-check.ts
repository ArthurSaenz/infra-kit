import path from 'node:path'

import {
  PACKAGE_MARKER_END,
  PACKAGE_MARKER_START,
  PACKAGE_VERSION_PREFIX,
  ROOT_MARKER_END,
  ROOT_MARKER_START,
  ROOT_VERSION_PREFIX,
  buildPackageGuidance,
  buildRootBody,
  inspectPackageGuidance,
  readGuidanceFile,
} from 'src/lib/agent-guidance'
import { buildManagedBlock, extractVersion, hasManagedBlock } from 'src/lib/managed-block'
import type { PackageCheck } from 'src/lib/package-validator'
import { readDeclaredPackageType } from 'src/lib/package-validator/loader'
import { isNewerVersion } from 'src/lib/update-check/semver'

import packageJson from '../../../package.json' with { type: 'json' }

const GUIDANCE_DRIFT_CHECK = 'agent-guidance:drift'

/** The `--fix` invocation that regenerates the audited scope, so the remediation is copy-pasteable. */
export type GuidanceFixScope = 'root' | 'all' | 'package'

const FIX_COMMANDS: Record<GuidanceFixScope, string> = {
  root: 'ik audit --fix --root',
  all: 'ik audit --fix --all',
  package: 'ik audit --fix',
}

interface CompareGuidanceArgs {
  /** The whole `CLAUDE.md`, which must already carry the block. */
  content: string
  /** The body this CLI would write between the markers. */
  expectedBody: string
  startMarker: string
  endMarker: string
  versionPrefix: string
  /** Version of the running CLI. */
  current: string
  scope: GuidanceFixScope
}

/**
 * The block's version line is dropped before comparing: a release that changes no guidance text
 * still bumps it, and reporting that would warn the whole fleet on every release.
 */
const withoutVersionLine = (block: string, versionPrefix: string): string => {
  return block
    .split('\n')
    .filter((line) => {
      return !line.startsWith(versionPrefix)
    })
    .join('\n')
}

/**
 * Version-directional verdict on one guidance block. Equal content passes whatever the version
 * line says. Different content is always a `warn`, never a `fail`: a guidance-text change in a CLI
 * release must not redden every consumer's qa until each one re-runs `--fix`. The direction only
 * picks the remediation — an older block needs a re-fix, a newer block means this CLI is the stale
 * side, and `--fix` would downgrade the block.
 *
 * @example
 * compareGuidance({ content, expectedBody, startMarker, endMarker, versionPrefix, current: '0.35.0', scope: 'all' })
 * // => { name: 'agent-guidance:drift', status: 'warn', message: 'block from infra-kit 0.34.0 differs … run `ik audit --fix --all`' }
 */
export const compareGuidance = ({
  content,
  expectedBody,
  startMarker,
  endMarker,
  versionPrefix,
  current,
  scope,
}: CompareGuidanceArgs): PackageCheck => {
  const actual = content.slice(content.indexOf(startMarker), content.indexOf(endMarker) + endMarker.length)
  const expected = buildManagedBlock(startMarker, expectedBody, endMarker)

  if (withoutVersionLine(actual, versionPrefix) === withoutVersionLine(expected, versionPrefix)) {
    return { name: GUIDANCE_DRIFT_CHECK, status: 'pass', message: `matches infra-kit ${current}` }
  }

  const blockVersion = extractVersion(actual, versionPrefix)
  const fixCommand = FIX_COMMANDS[scope]

  if (blockVersion !== null && isNewerVersion(blockVersion, current)) {
    return {
      name: GUIDANCE_DRIFT_CHECK,
      status: 'warn',
      message: `block from infra-kit ${blockVersion} is newer than this CLI (${current}) — CLI behind the block, run \`pnpm add -g infra-kit@${blockVersion}\``,
    }
  }

  if (blockVersion !== null && isNewerVersion(current, blockVersion)) {
    return {
      name: GUIDANCE_DRIFT_CHECK,
      status: 'warn',
      message: `block from infra-kit ${blockVersion} differs from what infra-kit ${current} generates — run \`${fixCommand}\``,
    }
  }

  return {
    name: GUIDANCE_DRIFT_CHECK,
    status: 'warn',
    message: `block differs from what infra-kit ${current} generates (edited inside the markers?) — run \`${fixCommand}\``,
  }
}

/** Root `CLAUDE.md` drift, or `null` when there is no root block — its absence is `doctor`'s row. */
export const checkRootGuidanceDrift = (root: string, current: string = packageJson.version): PackageCheck | null => {
  const content = readGuidanceFile(path.join(root, 'CLAUDE.md'))

  if (content === null || !hasManagedBlock(content, ROOT_MARKER_START, ROOT_MARKER_END)) return null

  return compareGuidance({
    content,
    expectedBody: buildRootBody(current),
    startMarker: ROOT_MARKER_START,
    endMarker: ROOT_MARKER_END,
    versionPrefix: ROOT_VERSION_PREFIX,
    current,
    scope: 'root',
  })
}

/**
 * One package's block drift, or `null` unless the block is well-formed: every other state is
 * already the `agent-guidance` presence check's verdict, and a second row would repeat it.
 */
export const checkPackageGuidanceDrift = async (
  packageDir: string,
  repoRoot: string,
  scope: GuidanceFixScope,
  current: string = packageJson.version,
): Promise<PackageCheck | null> => {
  const content = readGuidanceFile(path.join(packageDir, 'CLAUDE.md'))

  if (content === null || inspectPackageGuidance(content).state !== 'ok') return null

  let body: string

  // This runs on every audit, not only `--fix`: a package the builder cannot read (a malformed
  // package.json, say) is the other checks' finding, so it must not abort the whole audit here.
  try {
    ;({ body } = await buildPackageGuidance(packageDir, {
      repoRoot,
      version: current,
      declaredType: await readDeclaredPackageType(packageDir),
    }))
  } catch {
    return null
  }

  return compareGuidance({
    content,
    expectedBody: body,
    startMarker: PACKAGE_MARKER_START,
    endMarker: PACKAGE_MARKER_END,
    versionPrefix: PACKAGE_VERSION_PREFIX,
    current,
    scope,
  })
}
