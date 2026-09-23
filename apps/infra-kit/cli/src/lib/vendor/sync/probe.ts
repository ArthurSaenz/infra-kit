import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { getMainRepoRoot } from 'src/lib/git-utils'

import { readManifest } from '../manifest'
import { VENDOR_DIR } from '../skip-sets'
import { fingerprintOnDisk, fingerprintSourceFile } from './fingerprint'
import { runGit, splitNul } from './git'
import { hasExcludedSegment, rebasePath, resolveCopyEntries, withoutExcluded } from './paths'
import { guardedPaths } from './plan'
import { vendorReadme } from './readme'
import { listTrackedFiles } from './tracked-files'
import type { ChangelogFacts, SourceFacts, SyncSpec, TargetEntryFacts, TargetFacts, TargetRef } from './types'

const README_PATH = `${VENDOR_DIR}/README.md`
const MANIFEST_PATH = `${VENDOR_DIR}/.sync-manifest.json`

/**
 * Gather everything the plan needs from the source repo: HEAD, its repo name, and the fingerprinted tracked
 * set of every copy entry. Takes the root explicitly so nothing depends on `process.cwd()`.
 */
export const probeSource = async (sourceRoot: string, spec: SyncSpec): Promise<SourceFacts> => {
  const exclude = spec.exclude ?? []
  const headSha = (await runGit(sourceRoot, ['rev-parse', 'HEAD'])).trim()
  const mainRoot = await getMainRepoRoot(sourceRoot)

  const entries = await Promise.all(
    resolveCopyEntries(spec).map(async (entry) => {
      const tracked = await listTrackedFiles(sourceRoot, entry.path, exclude)

      return {
        entry,
        files: tracked.map((file) => {
          return fingerprintSourceFile(sourceRoot, file)
        }),
      }
    }),
  )

  return {
    root: sourceRoot,
    selfRoots: [...new Set([realpathSync(sourceRoot), realpathSync(mainRoot)])],
    name: path.basename(mainRoot),
    headSha,
    entries,
    exclude,
    legacyCleanup: spec.legacyCleanup ?? [],
  }
}

/**
 * Parse `git status --porcelain -z` into paths. A rename or copy record is followed by its origin path as a
 * separate record, which is skipped so it is not mistaken for a status line.
 *
 * @example
 * parsePorcelainZ(' M a.ts\0?? b.ts\0') // => ['a.ts', 'b.ts']
 */
export const parsePorcelainZ = (stdout: string): string[] => {
  const records = splitNul(stdout)[Symbol.iterator]()
  const paths: string[] = []

  for (const record of records) {
    paths.push(record.slice(3))

    if (/^[RC]|^.[RC]/u.test(record)) records.next()
  }

  return paths
}

const dirtyPaths = async (source: SourceFacts, root: string): Promise<string[]> => {
  const stdout = await runGit(root, [
    '--literal-pathspecs',
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=all',
    '--',
    ...guardedPaths(source),
  ])

  // An excluded path is never written or deleted, so its state cannot block the sync.
  return parsePorcelainZ(stdout).filter((dirtyPath) => {
    return !hasExcludedSegment(dirtyPath, source.exclude)
  })
}

const probeEntries = async (source: SourceFacts, root: string): Promise<TargetEntryFacts[]> => {
  return Promise.all(
    source.entries.map(async ({ entry, files }) => {
      const tracked = await listTrackedFiles(root, entry.target, source.exclude)
      const onDisk: TargetEntryFacts['onDisk'] = {}

      for (const file of withoutExcluded(files, source.exclude)) {
        const targetPath = rebasePath(file.path, entry)

        onDisk[targetPath] = fingerprintOnDisk(path.join(root, targetPath))
      }

      return {
        target: entry.target,
        tracked: tracked.map((file) => {
          return file.path
        }),
        onDisk,
      }
    }),
  )
}

const probeLegacy = async (source: SourceFacts, root: string): Promise<string[]> => {
  const perPath = await Promise.all(
    source.legacyCleanup.map((legacyPath) => {
      return listTrackedFiles(root, legacyPath, source.exclude)
    }),
  )

  return perPath.flat().map((file) => {
    return file.path
  })
}

const headVendorMeta = async (root: string): Promise<string[]> => {
  try {
    const args = ['--literal-pathspecs', 'ls-tree', '-z', '--name-only', 'HEAD', '--', README_PATH, MANIFEST_PATH]

    return splitNul(await runGit(root, args))
  } catch {
    // Unborn HEAD: nothing is committed, so nothing is recoverable by checkout.
    return []
  }
}

const readManifestSha = (root: string): string | null => {
  try {
    return readManifest(path.join(root, VENDOR_DIR)).commit
  } catch {
    return null
  }
}

const probeChangelog = async (source: SourceFacts, manifestSha: string | null): Promise<ChangelogFacts> => {
  if (manifestSha === null) return { kind: 'unknown-sha' }

  try {
    await runGit(source.root, ['rev-parse', '--verify', '--quiet', `${manifestSha}^{commit}`])
  } catch {
    return { kind: 'unresolvable', sha: manifestSha }
  }

  const copyPaths = source.entries.map(({ entry }) => {
    return entry.path
  })
  const stdout = await runGit(source.root, [
    '--literal-pathspecs',
    'log',
    '--oneline',
    `${manifestSha}..HEAD`,
    '--',
    ...copyPaths,
  ])
  const lines = stdout.split('\n').filter((line) => {
    return line.length > 0
  })

  return { kind: 'log', sha: manifestSha, lines }
}

const readmeIsCurrent = (root: string, sourceName: string): boolean => {
  try {
    return readFileSync(path.join(root, README_PATH), 'utf8') === vendorReadme(sourceName)
  } catch {
    return false
  }
}

const gitToplevel = async (root: string): Promise<{ toplevel: string } | { reason: string }> => {
  try {
    return { toplevel: (await runGit(root, ['rev-parse', '--show-toplevel'])).trim() }
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? error)

    return { reason: stderr.trim().split('\n')[0] ?? 'git rev-parse failed' }
  }
}

const currentBranch = async (root: string): Promise<string> => {
  try {
    return (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    return 'HEAD'
  }
}

/**
 * Gather one target's facts. Order matters only for the cheap exits: a missing checkout, the source itself
 * and a non-repo are decided before any status or diff probe runs.
 */
export const probeTarget = async (source: SourceFacts, ref: TargetRef): Promise<TargetFacts> => {
  if (!existsSync(ref.root)) return { ...ref, kind: 'missing' }

  const realRoot = realpathSync(ref.root)

  if (source.selfRoots.includes(realRoot)) return { ...ref, kind: 'source' }

  const top = await gitToplevel(ref.root)

  if ('reason' in top) return { ...ref, kind: 'not-git', reason: top.reason }
  if (realpathSync(top.toplevel) !== realRoot) {
    return { ...ref, kind: 'not-git', reason: `it sits inside the repo at ${top.toplevel}` }
  }

  const manifestSha = readManifestSha(ref.root)
  const [branch, dirty, entries, legacy, headMeta, changelog] = await Promise.all([
    currentBranch(ref.root),
    dirtyPaths(source, ref.root),
    probeEntries(source, ref.root),
    probeLegacy(source, ref.root),
    headVendorMeta(ref.root),
    probeChangelog(source, manifestSha),
  ])

  return {
    ...ref,
    kind: 'repo',
    branch,
    dirty,
    entries,
    legacy,
    headVendorMeta: headMeta,
    readmeCurrent: readmeIsCurrent(ref.root, source.name),
    manifestPresent: manifestSha !== null,
    changelog,
  }
}
