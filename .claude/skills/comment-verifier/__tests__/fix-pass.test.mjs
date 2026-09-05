// The fix pass's safety properties. Every one of these is the mechanical half of a pre-mortem
// scenario, so they are constructed directly here — no agent in the loop, because the point is that
// the guard holds whether or not the agent complied.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { filterVerdict, textHash, verifyFix } from '../scripts/lint-comments.mjs'

const SKILL_DIR = join(import.meta.dirname, '..')
const SCRIPT = join(SKILL_DIR, 'scripts', 'lint-comments.mjs')
const REPO_ROOT = join(SKILL_DIR, '..', '..', '..')
const FILE = 'demo.ts'

const lines = (...rows) => `${rows.join('\n')}\n`

const KEEP = '// A note worth keeping.'
const ASK = '// Ask for confirmation'

const deleteAsk = {
  file: FILE,
  line: 3,
  textHash: textHash(ASK),
  action: 'delete',
  reason: 'restates `await confirmOrExit()` on the next line',
}

// ---------------------------------------------------------------------------
// filterVerdict
// ---------------------------------------------------------------------------

const ALL_FIVE = [
  { file: FILE, line: 1, textHash: textHash('a'), action: 'delete', reason: 'r' },
  { file: FILE, line: 2, textHash: textHash('b'), action: 'shorten', reason: 'r', replacement: '// b' },
  { file: FILE, line: 3, textHash: textHash('c'), action: 'rewrite-as-why', reason: 'r', replacement: '// c' },
  { file: FILE, line: 4, textHash: textHash('d'), action: 'rename-or-refactor-instead', reason: 'r' },
  { file: FILE, line: 5, textHash: textHash('e'), action: 'keep', reason: 'external quirk' },
]

test('the filter keeps only the three actions that write bytes', () => {
  assert.deepEqual(
    filterVerdict(ALL_FIVE).map((entry) => entry.action),
    ['delete', 'shorten', 'rewrite-as-why'],
  )
})

test('a keep-only verdict filters to nothing, so the fix pass has no work', () => {
  assert.deepEqual(filterVerdict(ALL_FIVE.filter((entry) => entry.action === 'keep')), [])
})

test('rename-or-refactor-instead is excluded: it is a code change a human owns', () => {
  const filtered = filterVerdict(ALL_FIVE)
  assert.equal(filtered.some((entry) => entry.action === 'rename-or-refactor-instead'), false)
})

// ---------------------------------------------------------------------------
// verifyFix
// ---------------------------------------------------------------------------

const BASELINE = lines('export const a = 1', '', ASK, 'await confirmOrExit()', '', KEEP, 'export const b = 2')

test('only sanctioned changes pass', () => {
  const current = lines('export const a = 1', '', 'await confirmOrExit()', '', KEEP, 'export const b = 2')
  const report = verifyFix({ [FILE]: BASELINE }, { [FILE]: current }, [deleteAsk])
  assert.deepEqual(report.failures, [])
  assert.equal(report.ok, true)
  assert.equal(report.checked, 1)
})

test('a deletion may take exactly one adjacent blank line', () => {
  const current = lines('export const a = 1', 'await confirmOrExit()', '', KEEP, 'export const b = 2')
  assert.equal(verifyFix({ [FILE]: BASELINE }, { [FILE]: current }, [deleteAsk]).ok, true)
})

test('a deletion taking two blank lines fails', () => {
  const baseline = lines('export const a = 1', '', ASK, '', 'await confirmOrExit()')
  const current = lines('export const a = 1', 'await confirmOrExit()')
  const report = verifyFix({ [FILE]: baseline }, { [FILE]: current }, [deleteAsk])
  assert.equal(report.ok, false)
  assert.match(report.failures[0].reason, /unsanctioned change at demo\.ts:/)
})

test('removing a comment the verdict never listed fails, naming the hunk', () => {
  const current = lines('export const a = 1', '', 'await confirmOrExit()', '', 'export const b = 2')
  const report = verifyFix({ [FILE]: BASELINE }, { [FILE]: current }, [deleteAsk])
  assert.equal(report.ok, false)
  assert.match(report.failures[0].reason, /unsanctioned change at demo\.ts:/)
  assert.match(report.failures[0].reason, /A note worth keeping/)
})

test('a sanctioned removal with unexpected text written in its place fails', () => {
  // Checking only removals would let the pass delete a sanctioned comment and write anything at all.
  const current = lines('export const a = 1', '', '// something else entirely', 'await confirmOrExit()', '', KEEP, 'export const b = 2')
  const report = verifyFix({ [FILE]: BASELINE }, { [FILE]: current }, [deleteAsk])
  assert.equal(report.ok, false)
  assert.match(report.failures[0].reason, /something else entirely/)
})

test('a shorten whose replacement is a subset of the original lines passes', () => {
  // This is the case a hunk-by-hunk verifier gets wrong: the diff is removal-only, with no added
  // line to match against.
  const original = `${KEEP}\n// Extra line that adds nothing.`
  const baseline = lines('export const a = 1', KEEP, '// Extra line that adds nothing.', 'export const b = 2')
  const current = lines('export const a = 1', KEEP, 'export const b = 2')
  const entry = {
    file: FILE,
    line: 2,
    textHash: textHash(original),
    action: 'shorten',
    reason: 'the second line adds nothing',
    replacement: KEEP,
  }
  const report = verifyFix({ [FILE]: baseline }, { [FILE]: current }, [entry])
  assert.deepEqual(report.failures, [])
})

test('a replacement must land where the comment it replaces was', () => {
  // Regions are matched by hash and `line` is a hint, so nothing else checks position. A `// why`
  // parked above the wrong function is the misinformation the policy exists to prevent.
  const baseline = lines('// what it does', 'foo()', 'bar()')
  const entry = {
    file: FILE,
    line: 1,
    textHash: textHash('// what it does'),
    action: 'shorten',
    reason: 'the why is that foo is reentrant',
    replacement: '// why: foo is reentrant',
  }

  assert.equal(verifyFix({ [FILE]: baseline }, { [FILE]: lines('// why: foo is reentrant', 'foo()', 'bar()') }, [entry]).ok, true)

  for (const relocated of [
    lines('foo()', '// why: foo is reentrant', 'bar()'),
    lines('foo()', 'bar() // why: foo is reentrant'),
  ]) {
    const report = verifyFix({ [FILE]: baseline }, { [FILE]: relocated }, [entry])
    assert.equal(report.ok, false, `a relocated replacement passed: ${relocated}`)
    assert.match(report.failures[0].reason, /landed against/)
  }
})

test('a rewrite-as-why whose replacement does not land byte for byte fails', () => {
  const baseline = lines('export const a = 1', ASK, 'await confirmOrExit()')
  const current = lines('export const a = 1', '// Roughly what was asked for.', 'await confirmOrExit()')
  const entry = {
    file: FILE,
    line: 2,
    textHash: textHash(ASK),
    action: 'rewrite-as-why',
    reason: 'the why is that the caller may be non-interactive',
    replacement: '// Non-interactive callers must not block here.',
  }
  const report = verifyFix({ [FILE]: baseline }, { [FILE]: current }, [entry])
  assert.equal(report.ok, false)
  assert.match(report.failures[0].reason, /replacement \(expected textHash/)
})

test('a textHash miss is a named failure, never a silent skip', () => {
  const stale = { ...deleteAsk, textHash: textHash('// A comment that is not in this file') }
  const report = verifyFix({ [FILE]: BASELINE }, { [FILE]: BASELINE }, [stale])
  assert.equal(report.ok, false)
  assert.match(report.failures[0].reason, /matches no comment in the baseline/)
  assert.equal(report.failures[0].entry.textHash, stale.textHash)
})

test('two identical comments in one file resolve to two different regions', () => {
  // The policy corpus names three `// Ask for confirmation` sites; two of them landing in one file
  // is the ordinary case. Matching both entries to the first occurrence made the second removal
  // look unsanctioned.
  const before = lines(ASK, 'await confirmOrExit(a)', '', ASK, 'await confirmOrExit(b)')
  const after = lines('await confirmOrExit(a)', '', 'await confirmOrExit(b)')
  const entries = [
    { ...deleteAsk, line: 1 },
    { ...deleteAsk, line: 4 },
  ]

  assert.deepEqual(verifyFix({ [FILE]: before }, { [FILE]: after }, entries), { ok: true, checked: 1, failures: [] })
})

// ---------------------------------------------------------------------------
// Comments that share a line with code
// ---------------------------------------------------------------------------

const TRAILING = 'const x = 1 // sets x to one'

test('a shorten on a trailing comment still guards the code on that line', () => {
  // Regions are character spans, not line spans. Masking by line would drop `const x = 1` from the
  // comparison too, and rewriting a statement under cover of a sanctioned comment edit would pass.
  const entry = {
    file: FILE,
    line: 1,
    textHash: textHash('// sets x to one'),
    action: 'shorten',
    reason: 'buried why',
    replacement: '// why: sentinel',
  }
  const report = verifyFix({ [FILE]: lines(TRAILING) }, { [FILE]: lines('const x = 999 // why: sentinel') }, [entry])

  assert.equal(report.ok, false)
  assert.match(report.failures[0].reason, /const x = 999/)
})

test('deleting a trailing comment leaves the code, and that is the passing answer', () => {
  const entry = { file: FILE, line: 1, textHash: textHash('// sets x to one'), action: 'delete', reason: 'restates the assignment' }

  assert.equal(verifyFix({ [FILE]: lines(TRAILING) }, { [FILE]: lines('const x = 1') }, [entry]).ok, true)
  // Taking the statement with it is the destructive reading and must not pass.
  assert.equal(verifyFix({ [FILE]: lines(TRAILING) }, { [FILE]: lines('') }, [entry]).ok, false)
})

test('excising an inline comment absorbs the separator it leaves behind', () => {
  // Cutting `/* a */` out of the head of a line leaves a leading space no applier writes back. The
  // latitude is scoped to lines an excision cut into, which the next test pins.
  const entry = { file: FILE, line: 1, textHash: textHash('/* a */'), action: 'delete', reason: 'restates foo' }

  assert.equal(verifyFix({ [FILE]: lines('/* a */ foo() /* b */') }, { [FILE]: lines('foo() /* b */') }, [entry]).ok, true)
  // The unsanctioned second comment going too is still a failure.
  assert.equal(verifyFix({ [FILE]: lines('/* a */ foo() /* b */') }, { [FILE]: lines('foo()') }, [entry]).ok, false)
})

test('whitespace on a cut line inside a template literal is rendered content', () => {
  // A comment can sit in a template's `${...}`, which makes that line one an excision cut into.
  // Freeing both ends of such a line would put rendered indentation and trailing spaces outside the
  // comparison, so the residue is absorbed at excision time instead and the line stays exact.
  const before = 'const s = `\n  keep   ${/* c */ x}   \n`\n'
  const after = 'const s = `\n      keep   ${ x}\n`\n'
  const entry = { file: FILE, line: 2, textHash: textHash('/* c */'), action: 'delete', reason: 'restates x' }

  assert.equal(verifyFix({ [FILE]: before }, { [FILE]: after }, [entry]).ok, false)
  assert.equal(verifyFix({ [FILE]: before }, { [FILE]: 'const s = `\n  keep   ${x}   \n`\n' }, [entry]).ok, true)
})

test('the blank allowance is spendable only beside the comment it removed', () => {
  // A budget alone is not enough: it would pay for an unrelated blank elsewhere in the file, or for
  // the file's final newline. The run abutting the emptied comment is the unit.
  const entry = { ...deleteAsk, line: 1, textHash: textHash('// c') }
  const distant = lines('// c', '', 'foo()', 'bar()', '', 'baz()')

  assert.equal(verifyFix({ [FILE]: distant }, { [FILE]: lines('', 'foo()', 'bar()', 'baz()') }, [entry]).ok, false)
  assert.equal(verifyFix({ [FILE]: lines('// c', '', 'foo()') }, { [FILE]: '\nfoo()' }, [entry]).ok, false)
  // The blank beside it is still spendable, and so is either of two abutting blanks.
  assert.equal(verifyFix({ [FILE]: distant }, { [FILE]: lines('foo()', 'bar()', '', 'baz()') }, [entry]).ok, true)
})

test('whitespace away from any excision is compared exactly', () => {
  // Trailing spaces inside a template literal are program state, so a blanket right-trim would let
  // an unsanctioned edit through.
  const padded = lines('// c', 'const s = `padded   ', 'more`')
  const trimmed = lines('const s = `padded', 'more`')

  assert.equal(verifyFix({ [FILE]: padded }, { [FILE]: trimmed }, [{ ...deleteAsk, textHash: textHash('// c') }]).ok, false)
})

test('a comment ending a file without a newline may restore one', () => {
  const entry = { file: FILE, line: 2, textHash: textHash('// last'), action: 'delete', reason: 'restates foo' }

  assert.equal(verifyFix({ [FILE]: 'foo()\n// last' }, { [FILE]: 'foo()\n' }, [entry]).ok, true)
  // Taking the code with it is still the destructive reading.
  assert.equal(verifyFix({ [FILE]: 'foo()\n// last' }, { [FILE]: '' }, [entry]).ok, false)
})

test('a CRLF file with lines above the comment verifies correctly', () => {
  // The comment must NOT be on line 1: offsets index folded text, so a raw slice drifts left by one
  // character per preceding line. A single-line fixture has zero drift and proves nothing.
  const head = ['line0', 'line1', 'line2', 'line3'].join('\r\n')
  const before = `${head}\r\n// c\r\nfoo()\r\n`
  const entry = { file: FILE, line: 5, textHash: textHash('// c'), action: 'delete', reason: 'restates foo' }

  assert.equal(verifyFix({ [FILE]: before }, { [FILE]: `${head}\r\nfoo()\r\n` }, [entry]).ok, true)
  assert.equal(verifyFix({ [FILE]: before }, { [FILE]: `${head}\r\nbar()\r\n` }, [entry]).ok, false)

  // A lone \r is a line terminator to TypeScript and was not one to the mask, the same disagreement.
  const legacy = `${head.replaceAll('\r\n', '\r')}\r// c\rfoo()\r`
  assert.equal(verifyFix({ [FILE]: legacy }, { [FILE]: `${head.replaceAll('\r\n', '\r')}\rfoo()\r` }, [entry]).ok, true)
})

test('a comment above two blank lines may still take one of them', () => {
  // The blank allowance is a budget, not a named line: pinning it to one line number fails this
  // correct fix, because the walk matches the first blank and then has nothing left to spend.
  const before = lines(ASK, '', '', 'await confirmOrExit()')
  const after = lines('', 'await confirmOrExit()')

  assert.equal(verifyFix({ [FILE]: before }, { [FILE]: after }, [{ ...deleteAsk, line: 1 }]).ok, true)
})

test('sanctioning one copy does not sanction the other', () => {
  // The complement of the test above: claiming regions one at a time must not become a licence to
  // remove every comment that happens to read alike.
  const before = lines(ASK, 'await confirmOrExit(a)', '', ASK, 'await confirmOrExit(b)')
  const after = lines('await confirmOrExit(a)', '', 'await confirmOrExit(b)')

  const report = verifyFix({ [FILE]: before }, { [FILE]: after }, [deleteAsk])
  assert.equal(report.ok, false)
  assert.match(report.failures[0].reason, /unsanctioned change/)
})

test('a verdict naming more copies than the file holds is still stale', () => {
  const before = lines(ASK, 'await confirmOrExit(a)')
  const after = lines('await confirmOrExit(a)')
  const entries = [deleteAsk, { ...deleteAsk, line: 9 }]

  const report = verifyFix({ [FILE]: before }, { [FILE]: after }, entries)
  assert.equal(report.ok, false)
  assert.match(report.failures[0].reason, /matches no comment in the baseline/)
  assert.equal(report.failures[0].entry.line, 9)
})

test('an unrelated dirty file outside the scope cannot fail the check', () => {
  // The baseline is the snapshot of the scoped files, not HEAD, so nothing else is ever read.
  const current = lines('export const a = 1', '', 'await confirmOrExit()', '', KEEP, 'export const b = 2')
  const report = verifyFix(
    { [FILE]: BASELINE },
    { [FILE]: current, 'unrelated.ts': 'export const wildly = "different"\n' },
    [deleteAsk],
  )
  assert.equal(report.ok, true)
  assert.equal(report.checked, 1)
})

// ---------------------------------------------------------------------------
// Coverage: the verdict may not reach outside the baseline, and an empty
// baseline proves nothing. `ok` claims bytes were compared AND every difference
// among them was sanctioned; these pin the first conjunct.
// ---------------------------------------------------------------------------

const OTHER = 'other.ts'
const deleteElsewhere = { ...deleteAsk, file: OTHER, line: 1 }
const SANCTIONED = lines('export const a = 1', '', 'await confirmOrExit()', '', KEEP, 'export const b = 2')

test('a verdict entry naming a file outside the baseline fails', () => {
  const report = verifyFix(
    { [FILE]: BASELINE },
    { [FILE]: SANCTIONED, [OTHER]: 'export const smuggled = true\n' },
    [deleteAsk, deleteElsewhere],
  )
  assert.equal(report.ok, false)
  const failure = report.failures.find((entry) => entry.file === OTHER)
  assert.match(failure.reason, /absent from the verification baseline/)
  assert.equal(failure.entry.file, OTHER, 'the failure must name the offending verdict row')
})

test('an empty baseline verifies nothing, however clean the verdict looks', () => {
  const report = verifyFix({}, { [FILE]: SANCTIONED }, [deleteAsk])
  assert.equal(report.ok, false)
  assert.equal(report.checked, 0)
})

test('checked: 0 is never ok: true, even with an empty verdict', () => {
  const report = verifyFix({}, {}, [])
  assert.equal(report.ok, false, 'a run that compared nothing must not report success')
  assert.equal(report.checked, 0)
})

test('an out-of-baseline entry does not suppress the in-baseline comparison', () => {
  // Seeded, not short-circuited: the unbacked entry must not hide a real unsanctioned change.
  const smuggled = lines('export const a = 999', '', 'await confirmOrExit()', '', KEEP, 'export const b = 2')
  const report = verifyFix({ [FILE]: BASELINE }, { [FILE]: smuggled }, [deleteAsk, deleteElsewhere])
  assert.equal(report.ok, false)
  assert.equal(report.failures.some((entry) => /absent from the verification baseline/.test(entry.reason)), true)
  assert.equal(report.failures.some((entry) => /unsanctioned change/.test(entry.reason)), true)
})

test('a baseline file the verdict never names is still compared', () => {
  // The mirror-image wrong repair: re-keying the loop on the verdict would leave this file unread,
  // which is the hole `runVerifyFix` already warns about.
  const report = verifyFix(
    { [FILE]: BASELINE, [OTHER]: 'export const untouched = 1\n' },
    { [FILE]: SANCTIONED, [OTHER]: 'export const untouched = 999\n' },
    [deleteAsk],
  )
  assert.equal(report.ok, false)
  assert.equal(report.failures.some((entry) => entry.file === OTHER), true)
})

test('a keep entry never requires a baseline, since it writes nothing', () => {
  const keepElsewhere = { file: OTHER, line: 1, textHash: textHash(KEEP), action: 'keep', reason: 'external quirk' }
  const report = verifyFix({ [FILE]: BASELINE }, { [FILE]: SANCTIONED }, [deleteAsk, keepElsewhere])
  assert.equal(report.ok, true)
})

// ---------------------------------------------------------------------------
// The CLI, end to end
// ---------------------------------------------------------------------------

// `stderr` is returned as well as `stdout`: the difference between a refusal and a crash is only
// legible there, and two tests below assert the script exits through a message rather than a stack.
const runScript = (args, expectFailure = false) => {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
    assert.equal(expectFailure, false, 'expected a non-zero exit')
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    assert.equal(expectFailure, true, `unexpected non-zero exit: ${error.stdout ?? ''}${error.stderr ?? ''}`)
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** A stack trace names a source position; a refusal names the thing it refused. */
const STACK_MARKER = /\bat .*\.mjs:\d|code: 'E[A-Z]+'/

const manifestIn = (dir) => join(dir, '.comment-verifier-snapshot.json')

test('--snapshot and --verify-fix agree on a real edit, and exit non-zero on a bad one', () => {
  const target = '.claude/skills/comment-verifier/__fixtures__/restating-fix.ts'
  const absolute = join(REPO_ROOT, target)
  const original = readFileSync(absolute, 'utf8')
  const scratch = mkdtempSync(join(tmpdir(), 'comment-verifier-'))

  try {
    runScript(['--snapshot', scratch, target])
    assert.equal(readFileSync(join(scratch, target), 'utf8'), original)

    const verdict = [{ file: target, line: 21, textHash: textHash(ASK), action: 'delete', reason: 'restates `confirmOrExit`' }]
    const verdictPath = join(scratch, 'verdict.json')
    writeFileSync(verdictPath, JSON.stringify(verdict))

    writeFileSync(absolute, original.replace(`  ${ASK}\n`, ''))
    const pass = runScript(['--verify-fix', verdictPath, '--baseline', scratch])
    assert.equal(JSON.parse(pass.stdout).ok, true)

    writeFileSync(absolute, original.replace(`  ${ASK}\n`, '').replace('  // Log formatted output\n', ''))
    const fail = runScript(['--verify-fix', verdictPath, '--baseline', scratch], true)
    assert.equal(fail.status, 1)
    assert.match(JSON.parse(fail.stdout).failures[0].reason, /Log formatted output/)
  } finally {
    writeFileSync(absolute, original)
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('verification covers everything the snapshot captured, not a re-guessed subset', () => {
  // `--snapshot` copies whatever it is given; inferring the list back by walking the directory
  // filtered some of it out again, so a captured file could be edited and never compared.
  const dir = '.claude/skills/comment-verifier/__fixtures__/manifest-probe'
  const named = `${dir}/named.ts`
  const filtered = `${dir}/__tests__/filtered.ts`
  const scratch = mkdtempSync(join(tmpdir(), 'comment-verifier-'))

  try {
    mkdirSync(join(REPO_ROOT, dir, '__tests__'), { recursive: true })
    writeFileSync(join(REPO_ROOT, named), lines(ASK, 'await confirmOrExit()'))
    writeFileSync(join(REPO_ROOT, filtered), lines('export const captured = 1'))

    const captured = JSON.parse(runScript(['--snapshot', join(scratch, 'snap'), named, filtered]).stdout)
    assert.deepEqual(captured.files, [named, filtered])

    const verdictPath = join(scratch, 'verdict.json')
    writeFileSync(verdictPath, JSON.stringify([{ ...deleteAsk, file: named, line: 1 }]))
    writeFileSync(join(REPO_ROOT, named), lines('await confirmOrExit()'))
    writeFileSync(join(REPO_ROOT, filtered), lines('export const captured = 999'))

    const failed = runScript(['--verify-fix', verdictPath, '--baseline', join(scratch, 'snap')], true)
    const report = JSON.parse(failed.stdout)
    assert.equal(report.checked, 2, 'a captured file was dropped before comparison')
    assert.match(report.failures[0].reason, /captured = 999/)
  } finally {
    rmSync(join(REPO_ROOT, dir), { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('an empty snapshot manifest exits non-zero instead of verifying anything', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'comment-verifier-'))

  try {
    writeFileSync(join(scratch, '.comment-verifier-snapshot.json'), JSON.stringify({ files: [] }))
    const verdictPath = join(scratch, 'verdict.json')
    writeFileSync(verdictPath, JSON.stringify([deleteAsk]))

    const failed = runScript(['--verify-fix', verdictPath, '--baseline', scratch], true)
    assert.equal(failed.status, 1)
    const report = JSON.parse(failed.stdout)
    assert.equal(report.ok, false)
    assert.equal(report.checked, 0)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('the CLI refuses a verdict naming a file the snapshot never captured', () => {
  const dir = '.claude/skills/comment-verifier/__fixtures__/coverage-probe'
  const captured = `${dir}/captured.ts`
  const uncaptured = `${dir}/uncaptured.ts`
  const scratch = mkdtempSync(join(tmpdir(), 'comment-verifier-'))

  try {
    mkdirSync(join(REPO_ROOT, dir), { recursive: true })
    writeFileSync(join(REPO_ROOT, captured), lines(ASK, 'await confirmOrExit()'))
    writeFileSync(join(REPO_ROOT, uncaptured), lines(ASK, 'export const b = 1'))

    runScript(['--snapshot', join(scratch, 'snap'), captured])

    const verdictPath = join(scratch, 'verdict.json')
    writeFileSync(
      verdictPath,
      JSON.stringify([
        { ...deleteAsk, file: captured, line: 1 },
        { ...deleteAsk, file: uncaptured, line: 1 },
      ]),
    )

    writeFileSync(join(REPO_ROOT, captured), lines('await confirmOrExit()'))
    writeFileSync(join(REPO_ROOT, uncaptured), lines('export const b = 999', 'export const smuggled = true'))

    const failed = runScript(['--verify-fix', verdictPath, '--baseline', join(scratch, 'snap')], true)
    assert.equal(failed.status, 1)
    const report = JSON.parse(failed.stdout)
    const failure = report.failures.find((entry) => entry.file === uncaptured)
    assert.match(failure.reason, /absent from the verification baseline/)
  } finally {
    rmSync(join(REPO_ROOT, dir), { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('--snapshot on a path that is not a readable file refuses with a message, not a stack', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'comment-verifier-'))

  try {
    for (const target of ['does/not/exist.ts', '.claude/skills/comment-verifier/__fixtures__']) {
      const refused = runScript(['--snapshot', join(scratch, 'snap'), target], true)
      assert.equal(refused.status, 2, `${target} must be refused, not crashed through`)
      assert.equal(refused.stdout, '')
      assert.match(refused.stderr, /is not a readable file/)
      assert.doesNotMatch(refused.stderr, STACK_MARKER)
    }

    assert.equal(existsSync(manifestIn(join(scratch, 'snap'))), false)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('--snapshot resolving to nothing refuses rather than writing an empty baseline', () => {
  // An empty baseline used to verify anything; refusing here is one phase earlier than the guard
  // in verifyFix, while the operator can still fix the scope.
  const scratch = mkdtempSync(join(tmpdir(), 'comment-verifier-'))
  const dir = '.claude/skills/comment-verifier/__fixtures__/empty-scope-probe'

  try {
    mkdirSync(join(REPO_ROOT, dir), { recursive: true })
    const refused = runScript(['--snapshot', join(scratch, 'snap'), `${dir}/absent.ts`], true)
    assert.equal(refused.status, 2)
    assert.equal(refused.stdout, '')
    assert.doesNotMatch(refused.stderr, STACK_MARKER)
    assert.equal(existsSync(manifestIn(join(scratch, 'snap'))), false)
  } finally {
    rmSync(join(REPO_ROOT, dir), { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a snapshot whose copy fails still fails closed, because the manifest is written first', () => {
  const dir = '.claude/skills/comment-verifier/__fixtures__/manifest-order-probe'
  const target = `${dir}/target.ts`
  const scratch = mkdtempSync(join(tmpdir(), 'comment-verifier-'))
  const snap = join(scratch, 'snap')

  try {
    mkdirSync(join(REPO_ROOT, dir), { recursive: true })
    writeFileSync(join(REPO_ROOT, target), lines(ASK, 'await confirmOrExit()'))

    // The destination is a directory, so `copyFileSync` cannot write it and the run dies mid-copy.
    mkdirSync(join(snap, target), { recursive: true })
    runScript(['--snapshot', snap, target], true)

    assert.equal(existsSync(manifestIn(snap)), true, 'the manifest must survive a failed copy, or the walk fallback truncates the baseline')
    assert.deepEqual(JSON.parse(readFileSync(manifestIn(snap), 'utf8')).files, [target])

    const verdictPath = join(scratch, 'verdict.json')
    writeFileSync(verdictPath, JSON.stringify([{ ...deleteAsk, file: target, line: 1 }]))
    const failed = runScript(['--verify-fix', verdictPath, '--baseline', snap], true)
    assert.equal(failed.status, 1)
    assert.match(JSON.parse(failed.stdout).failures[0].reason, /no baseline snapshot for/)
  } finally {
    rmSync(join(REPO_ROOT, dir), { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a review-mode run leaves the scoped files byte-identical', () => {
  // Deliberately not a whole-repo `git status --porcelain` comparison: this repo's working tree is
  // edited by other processes while the suite runs, so that assertion measures the neighbours
  // rather than this script. The property under test is that a review-mode run writes nothing,
  // and the bytes of the scoped files say so directly.
  const scope = [
    '.claude/skills/comment-verifier/__fixtures__/restating.ts',
    '.claude/skills/comment-verifier/__fixtures__/clean.ts',
    '.claude/skills/comment-verifier/__fixtures__/restating-fix.ts',
  ]
  const bytes = () => scope.map((file) => readFileSync(join(REPO_ROOT, file), 'utf8'))
  const porcelain = () =>
    execFileSync('git', ['status', '--porcelain', '--', '.claude/skills/comment-verifier'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })

  const beforeBytes = bytes()
  const beforeStatus = porcelain()
  runScript(scope)
  assert.deepEqual(bytes(), beforeBytes)
  assert.equal(porcelain(), beforeStatus)
})
