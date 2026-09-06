// Every path this suite touches is resolved here, once, from the skill directory.
//
// The two suites that write to the working tree used to recompute the repo root as
// `join(SKILL_DIR, '..', '..', '..')`. Depth arithmetic is only ever right for one location: three
// levels up from the pre-move location under `.claude` is the repo root, but three levels up from
// `plugins/infra-kit/skills/<skill>` is `<repo>/plugins`. Nothing fails at that point — the writes,
// the four recursive deletes and the `git status` pathspec all silently retarget, and an unmatched
// pathspec makes git exit 0 with empty output, so the guard degrades to comparing empty with empty.
// Asking git for the toplevel cannot drift with the directory's depth.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { join, relative } from 'node:path'

export const SKILL_DIR = realpathSync(join(import.meta.dirname, '..'))
export const FIXTURES_DIR = join(SKILL_DIR, '__fixtures__')
export const SCRIPT = join(SKILL_DIR, 'scripts', 'lint-comments.mjs')

export const REPO_ROOT = realpathSync(
  execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: SKILL_DIR, encoding: 'utf8' }).trim(),
)

/**
 * Repo-relative, because the script under test runs with `cwd: REPO_ROOT` and echoes its arguments
 * back verbatim as `report.scope` — an absolute path would be honoured but would not match.
 */
export const repoPath = (...segments) => {
  const rel = relative(REPO_ROOT, join(...segments))
  if (rel.startsWith('..')) throw new Error(`${join(...segments)} is outside ${REPO_ROOT}`)
  return rel
}

export const fixture = (...segments) => repoPath(FIXTURES_DIR, ...segments)

/** The region a review-mode run could dirty; narrower than the skill directory, which other tools edit. */
export const FIXTURES_PATHSPEC = fixture()

/**
 * `-uall` because the fixtures are untracked until this directory is committed, and a collapsed
 * `?? <dir>/` line is identical before and after a stray file appears inside it.
 */
export const fixturesPorcelain = () =>
  execFileSync('git', ['status', '--porcelain', '-uall', '--', FIXTURES_PATHSPEC], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
