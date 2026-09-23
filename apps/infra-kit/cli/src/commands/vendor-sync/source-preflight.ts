import { $ } from 'zx'

import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import type { RunRow } from 'src/lib/render/run-report'

const MAX_LISTED_DIRTY = 20

const git = async (cwd: string, args: string[]): Promise<string> => {
  const result = await $({ cwd, quiet: true, nothrow: true })`git ${args}`

  return result.exitCode === 0 ? result.stdout.trim() : ''
}

const dirtySourcePaths = async (sourceRoot: string): Promise<string[]> => {
  const result = await $({ cwd: sourceRoot, quiet: true })`git status --porcelain --untracked-files=normal`

  return result.stdout
    .split('\n')
    .filter((line) => {
      return line.trim().length > 0
    })
    .map((line) => {
      return line.slice(3)
    })
}

const reachabilityRow = async (sourceRoot: string): Promise<RunRow | null> => {
  const containing = await git(sourceRoot, [
    'for-each-ref',
    '--contains',
    'HEAD',
    '--format=%(refname)',
    'refs/remotes/origin/',
  ])

  if (containing.length > 0) return null

  return {
    name: 'HEAD pushed',
    status: 'warn',
    message: 'HEAD is on no origin/* ref, so every target will record a commit nobody else can resolve',
    notes: ['git push'],
  }
}

const defaultBranchRow = async (sourceRoot: string): Promise<RunRow | null> => {
  const [originHead, branch] = await Promise.all([
    git(sourceRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
    git(sourceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ])

  if (originHead.length === 0) {
    return { name: 'default branch', status: 'warn', message: 'origin has no default branch recorded (origin/HEAD)' }
  }

  const defaultBranch = originHead.replace(/^origin\//u, '')

  if (branch === defaultBranch) return null

  return {
    name: 'default branch',
    status: 'warn',
    message: `syncing from ${branch || 'a detached HEAD'}, not the origin default branch ${defaultBranch}`,
  }
}

/**
 * Gate the source repo before any config is read: a dirty tree refuses, because the targets would record a
 * HEAD sha whose files they never received. An unpushed or off-default HEAD only warns.
 *
 * @example
 * const rows = await preflightSource('/Users/me/projects/starter-workspace')
 * // => [{ name: 'working tree', status: 'ok', message: 'clean' }]
 */
export const preflightSource = async (sourceRoot: string): Promise<RunRow[]> => {
  const dirty = await dirtySourcePaths(sourceRoot)

  if (dirty.length > 0) {
    const listed = dirty.slice(0, MAX_LISTED_DIRTY)
    const more = dirty.length > listed.length ? `, and ${dirty.length - listed.length} more` : ''

    throw new StructuredRefusalError({ status: 'refused', reason: 'source-dirty', paths: dirty }, 1, {
      operation: `sync vendored files from ${sourceRoot}`,
      stderrExcerpt: `the source has ${dirty.length} uncommitted path(s)`,
      remediation: `commit or stash them first, so every target records a commit holding exactly the files it got: ${listed.join(', ')}${more}`,
    })
  }

  const warnings = await Promise.all([reachabilityRow(sourceRoot), defaultBranchRow(sourceRoot)])

  return [
    { name: 'working tree', status: 'ok', message: 'clean' },
    ...warnings.filter((row): row is RunRow => {
      return row !== null
    }),
  ]
}
