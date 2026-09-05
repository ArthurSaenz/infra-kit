// The hash the review pass publishes and the fix pass compares, and the comment reader underneath
// it. The hash vectors are pinned here rather than left to whichever side is coded first.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { extractComments, normalizeCommentText, textHash } from '../scripts/lint-comments.mjs'

const SKILL_DIR = join(import.meta.dirname, '..')
const SCRIPT = join(SKILL_DIR, 'scripts', 'lint-comments.mjs')
const REPO_ROOT = join(SKILL_DIR, '..', '..', '..')

test('textHash is 12 lowercase hex characters', () => {
  assert.match(textHash('// Ask for confirmation'), /^[0-9a-f]{12}$/)
})

test('CRLF and LF hash alike, so a checkout mode cannot invalidate a verdict', () => {
  assert.equal(textHash('/**\r\n * Foo\r\n * Bar\r\n */'), textHash('/**\n * Foo\n * Bar\n */'))
})

test('trailing whitespace does not change the hash', () => {
  assert.equal(textHash('// Foo   '), textHash('// Foo'))
})

test('a block and a line comment carrying the same prose hash alike', () => {
  // shorten and rewrite-as-why routinely swap one wrapper for the other, and the verifier has to
  // recognise the result as the same comment.
  assert.equal(textHash('/** Foo */'), textHash('// Foo'))
})

test('markers are excluded but prose is otherwise untouched', () => {
  assert.equal(normalizeCommentText('/**\n * Foo\n *\n * Bar\n */'), 'Foo\n\nBar')
  assert.equal(normalizeCommentText('// Foo\n// Bar'), 'Foo\nBar')
})

test('distinct prose gets distinct hashes', () => {
  assert.notEqual(textHash('// Ask for confirmation'), textHash('// Log formatted output'))
})

// ---------------------------------------------------------------------------
// The comment reader
// ---------------------------------------------------------------------------

test('consecutive standalone line comments join into one comment', () => {
  const comments = extractComments(['// one', '// two', 'const a = 1', '', '// three'].join('\n'))
  assert.deepEqual(
    comments.map((c) => [c.startLine, c.endLine, c.raw]),
    [
      [1, 2, '// one\n// two'],
      [5, 5, '// three'],
    ],
  )
})

test('a line comment trailing real code stays its own comment', () => {
  const comments = extractComments(['// leading', 'const a = 1 // trailing'].join('\n'))
  assert.deepEqual(comments.map((c) => c.raw), ['// leading', '// trailing'])
})

test('every comment carries a hash matching the one textHash computes for it', () => {
  const [comment] = extractComments('/** Foo */\nconst a = 1')
  assert.equal(comment.hash, textHash('/** Foo */'))
})

test('a regex literal holding `//` does not invent a comment', () => {
  // The hand-rolled reader this replaced returned a phantom `//` here. A phantom is the dangerous
  // half: verifyFix masks resolved regions out of its comparison, so an unsanctioned code change
  // inside one would go unseen.
  assert.deepEqual(extractComments('const url = /^https?:\\/\\//\n'), [])
})

test('a regex literal holding a quote does not swallow the comments after it', () => {
  // apps/infra-kit/cli/src/dev/ports.ts:35 is exactly this shape, and it hid the 14-line block
  // five lines below it from the previous reader.
  const source = ["const n = raw.replace(/^[\"']|[\"']$/g, '')", '// still visible'].join('\n')
  assert.deepEqual(extractComments(source).map((c) => c.raw), ['// still visible'])
})

test('the block hidden by that regex in real source is found', () => {
  const file = 'apps/infra-kit/cli/src/dev/ports.ts'
  const comments = extractComments(readFileSync(join(REPO_ROOT, file), 'utf8'), file)
  const block = comments.find((comment) => comment.startLine === 40)

  assert.ok(block, 'the JSDoc block at ports.ts:40 is invisible to the reader')
  assert.equal(block.endLine, 53)
})

test('rendered JSX text is not a comment', () => {
  // TypeScript scans a JSX element's children as trivia, so a rendered line reading like a comment
  // comes back as one. Excising it would put user-visible content outside the verifier's comparison.
  const source = ['const el = (', '  <div>', '    // Terms: you agree to nothing', '  </div>', ')'].join('\n')
  const fragment = ['const el = (<>', '  /* Price: $10 */', '</>)'].join('\n')

  assert.deepEqual(extractComments(source, 'a.tsx'), [])
  assert.deepEqual(extractComments(fragment, 'a.tsx'), [])
})

test('comments around and inside JSX are still comments', () => {
  const source = ['const el = (', '  <div /* attr */ className="a">', '    {/* expression */}', '    Rendered', '  </div>', ')'].join('\n')

  assert.deepEqual(extractComments(source, 'a.tsx').map((c) => c.raw), ['/* attr */', '/* expression */'])
})

test('an apostrophe inside a comment does not open a string', () => {
  const comments = extractComments(["// don't stop", 'const a = 1', '// second'].join('\n'))
  assert.deepEqual(comments.map((c) => c.raw), ["// don't stop", '// second'])
})

test('a file that does not parse still yields the comments it has', () => {
  // Source under review is routinely mid-edit; a parse error must not blind the reader.
  const comments = extractComments(['// kept', 'const a = (((', '// also kept'].join('\n'))
  assert.deepEqual(comments.map((c) => c.raw), ['// kept', '// also kept'])
})

test('--hash prints the same value the module computes', () => {
  const printed = execFileSync(process.execPath, [SCRIPT, '--hash', '// Ask for confirmation'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  assert.equal(printed, textHash('// Ask for confirmation'))
})

test('a run with no flags reports the scope and the rung that answered', () => {
  const stdout = execFileSync(
    process.execPath,
    [SCRIPT, '.claude/skills/comment-verifier/__fixtures__/clean.ts'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
  const report = JSON.parse(stdout)

  assert.deepEqual(report.scope, ['.claude/skills/comment-verifier/__fixtures__/clean.ts'])
  assert.equal(report.scopeSource, 'arguments')
  assert.equal(report.counts.files, 1)
  assert.deepEqual(report.unreviewable, [])
})

test('named arguments are honoured verbatim, and the unjudgeable ones are reported', () => {
  // Dropping a file a human named is its own fail-open — they believe it was reviewed. `snapshot`
  // resolves through this same function, so a drop here would un-capture the file at the other end.
  const named = [
    '.claude/skills/comment-verifier/SKILL.md',
    'apps/infra-kit/cli/src/dev/__tests__/fault-loop.test.ts',
    'does/not/exist.ts',
  ]
  const stdout = execFileSync(process.execPath, [SCRIPT, ...named], { cwd: REPO_ROOT, encoding: 'utf8' })
  const report = JSON.parse(stdout)

  assert.deepEqual(report.scope, named, 'a named file must never be silently dropped')
  assert.deepEqual(
    report.unreviewable,
    [
      { file: named[0], why: 'not a .ts or .tsx file' },
      { file: named[1], why: 'inside __tests__' },
      { file: named[2], why: 'not on disk' },
    ],
  )
})
