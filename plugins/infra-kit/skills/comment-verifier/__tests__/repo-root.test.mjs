// The script under review resolves the repository from the directory it is RUN in, not from where
// it is installed. As a plugin skill it lives outside every consumer repo (a cache copy, or the
// infra-kit checkout for a directory-source marketplace), so a self-location walk reports the wrong
// repository's scope — measured live in a consumer session before this test existed.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SKILL_DIR } from './paths.mjs'

const SCRIPT = join(SKILL_DIR, 'scripts', 'lint-comments.mjs')

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })

const makeForeignRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'comment-verifier-foreign-'))
  git(root, 'init', '-q')
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'only-here.ts'), '// why: fixture\nexport const x = 1\n')
  // Staged, so the working-tree rung (`git diff HEAD`) sees it; an untracked file is invisible there.
  git(root, 'add', 'src/only-here.ts')
  return root
}

test('scope comes from the working directory, not from where the script is installed', () => {
  const foreign = makeForeignRepo()
  const report = JSON.parse(execFileSync(process.execPath, [SCRIPT], { cwd: foreign, encoding: 'utf8' }))
  assert.deepEqual(report.scope, ['src/only-here.ts'])
  assert.equal(report.scopeSource, 'working-tree')
  // The red case: a self-location walk resolves the infra-kit checkout and reports its files.
  assert.ok(
    report.scope.every((file) => !file.startsWith('plugins/') && !file.startsWith('apps/')),
    'scope leaked files from the repository the script is installed in',
  )
})

test('outside any repository the root is the working directory itself, not the install location', () => {
  const bare = mkdtempSync(join(tmpdir(), 'comment-verifier-norepo-'))
  writeFileSync(join(bare, 'loose.ts'), 'export const y = 2\n')
  const report = JSON.parse(execFileSync(process.execPath, [SCRIPT, 'loose.ts'], { cwd: bare, encoding: 'utf8' }))
  assert.deepEqual(report.scope, ['loose.ts'])
  assert.equal(report.scopeSource, 'arguments')
})
