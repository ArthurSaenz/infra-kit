#!/usr/bin/env node
// The fix pass's safety net: it resolves scope, snapshots it before any edit, and afterwards proves
// that every byte which changed is accounted for by a verdict entry.
//
// A verdict entry is matched by `textHash` rather than by line number: any edit shifts every line
// below it, and a line-keyed fix would edit the wrong comment while the diff still looked plausible.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const WRITE_ACTIONS = ['delete', 'shorten', 'rewrite-as-why']
const ACTIONS = [...WRITE_ACTIONS, 'rename-or-refactor-instead', 'keep']

const HERE = path.dirname(fileURLToPath(import.meta.url))

// The repo under review is the one the command runs IN, never the one this file lives in: as a
// plugin skill this script executes from the plugin root (a cache copy with no `.git`, or the
// infra-kit checkout when the marketplace is a local directory), so walking up from HERE finds
// either nothing or the wrong repository.
const findRepoRoot = () => {
  const start = process.cwd()
  let dir = start
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

const REPO_ROOT = findRepoRoot()

// ---------------------------------------------------------------------------
// textHash — the contract between the review pass and the fix pass
// ---------------------------------------------------------------------------

/**
 * Comment markers are stripped before hashing because `shorten` and `rewrite-as-why` routinely
 * convert a block comment to a line comment or the reverse. A hash that included the markers would
 * read identical prose in a different wrapper as a different comment, which is the one case the
 * verifier most needs to recognise.
 */
export const normalizeCommentText = (raw) => {
  const lines = String(raw)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => stripMarkers(line).replace(/\s+$/, ''))

  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

const stripMarkers = (line) => {
  const opened = line.replace(/^\s*(\/\*\*|\/\*|\/\/|\*)( |$)/, '')
  const body = opened === line ? line.replace(/^\s+/, '') : opened
  return body.replace(/ ?\*\/\s*$/, '')
}

/** Twelve hex is 48 bits: far beyond collision range for one scoped run, and skimmable in a verdict. */
export const textHash = (raw) => {
  return createHash('sha256').update(normalizeCommentText(raw), 'utf8').digest('hex').slice(0, 12)
}

// ---------------------------------------------------------------------------
// Comment scanning
// ---------------------------------------------------------------------------

/**
 * Offsets are only meaningful against one line ending, so every reader of them folds first. A lone
 * `\r` folds too: TypeScript counts it as a line terminator and the mask does not, and that
 * disagreement is what made CRLF files reject their own correct fix. Folding it is safe because a
 * raw line terminator is not legal inside a string literal.
 *
 * U+2028 and U+2029 are terminators to TypeScript as well, but they ARE legal inside a string
 * literal from ES2019 on, so folding them would corrupt one. A file using them as line separators
 * therefore still reports a false failure rather than a wrong pass.
 */
const foldNewlines = (text) => String(text).replace(/\r\n|\r/g, '\n')

const requireFromRepo = createRequire(path.join(REPO_ROOT, 'package.json'))
let cachedTypescript = null

/**
 * The repo's own TypeScript, loaded lazily so `--hash` still answers in a checkout with no
 * `node_modules`. Reading comments by hand — tracking quotes and escapes character by character —
 * is what an earlier version did, and it desynced on the first regex literal holding a quote:
 * `replace(/^["']|["']$/g, '')` swallowed every comment after it, and `/^https?:\/\//` invented one
 * that was never there. A phantom comment is the dangerous half, because `verifyFix` masks resolved
 * regions out of its comparison, so an unsanctioned code change inside one goes unseen.
 */
const typescript = () => {
  if (cachedTypescript !== null) return cachedTypescript
  try {
    cachedTypescript = requireFromRepo('typescript')
  } catch (cause) {
    throw new Error(
      `comment-verifier reads comments with the repo's typescript, which failed to load: ${cause.message}`,
    )
  }
  return cachedTypescript
}

/**
 * Every comment in a file, in source order, with the markers still attached.
 *
 * Consecutive `//` lines that stand alone are one comment, since that is how a human reads them and
 * how a verdict names them. A `//` trailing real code stays its own comment.
 */
export const extractComments = (source, fileName = 'source.ts') => {
  const ts = typescript()
  const text = foldNewlines(source)
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const parsed = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind)

  return joinLineRuns(text, commentRanges(ts, parsed, text), parsed)
}

/**
 * Every comment is trivia of some token, so walking the token tree reaches all of them. Both sides
 * are asked because TypeScript calls a comment sharing a line with the code before it *trailing*
 * and returns it from neither `getLeadingCommentRanges` nor a parent's leading trivia. The same
 * range is reported once per node that borders it, hence the dedupe.
 *
 * Ranges inside JSX text are then dropped. TypeScript scans a JSX element's children as trivia, so
 * a rendered line reading `// Terms: you agree to nothing` comes back as a comment — and a verdict
 * that deletes it, or rewrites `/* Price: $10 *` + `/`, would be excised from the comparison and
 * pass. That is user-visible content, not a comment.
 */
const commentRanges = (ts, parsed, text) => {
  const seen = new Set()
  const ranges = []
  const rendered = []

  const collect = (found) => {
    for (const range of found ?? []) {
      const key = `${range.pos}:${range.end}`
      if (seen.has(key)) continue
      seen.add(key)
      ranges.push(range)
    }
  }

  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) {
      rendered.push({ pos: node.getFullStart(), end: node.getEnd() })
      return
    }
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()))
    collect(ts.getTrailingCommentRanges(text, node.getEnd()))
    for (const child of node.getChildren(parsed)) visit(child)
  }

  visit(parsed)

  const isRendered = (range) => rendered.some((span) => span.pos <= range.pos && range.end <= span.end)
  return ranges.filter((range) => !isRendered(range)).sort((a, b) => a.pos - b.pos)
}

const joinLineRuns = (text, ranges, parsed) => {
  const at = (offset) => parsed.getLineAndCharacterOfPosition(offset)
  const comments = []

  for (const range of ranges) {
    const { line, character } = at(range.pos)
    const startLine = line + 1
    const raw = text.slice(range.pos, range.end)
    const standalone = /^[ \t]*$/.test(text.slice(range.pos - character, range.pos))
    const previous = comments.at(-1)
    const isLineComment = raw.startsWith('//')

    if (isLineComment && standalone && previous?.joinable && previous.endLine === startLine - 1) {
      previous.raw += `\n${raw}`
      previous.endLine = startLine
      previous.end = range.end
      continue
    }

    comments.push({
      startLine,
      endLine: at(range.end).line + 1,
      pos: range.pos,
      end: range.end,
      raw,
      joinable: isLineComment && standalone,
    })
  }

  // `joinable` is bookkeeping for joining runs; a caller sees only the joined comment. `pos`/`end`
  // are character offsets, because the verifier excises a comment from its line rather than
  // dropping the line: `const x = 1 // sets x` has code on it that still has to be compared.
  return comments.map(({ startLine, endLine, pos, end, raw }) => ({
    startLine,
    endLine,
    pos,
    end,
    raw,
    hash: textHash(raw),
  }))
}

// ---------------------------------------------------------------------------
// Verdict handling
// ---------------------------------------------------------------------------

/** `keep` and `rename-or-refactor-instead` are never applied: one decides to do nothing, the other is a code change a human owns. */
export const filterVerdict = (entries) => {
  return (Array.isArray(entries) ? entries : []).filter((entry) => WRITE_ACTIONS.includes(entry?.action))
}

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

/** Only these two actions put new bytes in a file, so only these two owe a replacement to verify against. */
const addsBytes = (action) => action === 'shorten' || action === 'rewrite-as-why'

const faultsIn = (entry) => {
  const faults = []
  if (!isNonEmptyString(entry.file)) faults.push('file must be a non-empty string')
  if (!Number.isInteger(entry.line) || entry.line < 1) faults.push('line must be a positive integer')
  if (!/^[0-9a-f]{12}$/.test(entry.textHash ?? '')) faults.push('textHash must be 12 lowercase hex characters')
  if (!ACTIONS.includes(entry.action)) faults.push(`unknown action ${JSON.stringify(entry.action)}`)
  if (!isNonEmptyString(entry.reason)) faults.push('reason must be non-empty')
  if (addsBytes(entry.action) && !isNonEmptyString(entry.replacement))
    faults.push(`${entry.action} requires a non-empty replacement`)
  if (!addsBytes(entry.action) && entry.replacement !== undefined)
    faults.push(`${entry.action} must not carry a replacement`)
  return faults
}

/** A verdict that cannot be verified must not be executed, so the schema is checked before anything is applied. */
export const validateVerdict = (value) => {
  if (!Array.isArray(value)) return { ok: false, errors: ['verdict must be a JSON array of entries'] }

  const errors = value.flatMap((entry, index) => {
    const at = `entry ${index}`
    if (!entry || typeof entry !== 'object') return [`${at}: not an object`]

    return faultsIn(entry).map((fault) => `${at}: ${fault}`)
  })

  return { ok: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// verifyFix — the mechanical guard on the apply phase
// ---------------------------------------------------------------------------

/** A run-level failure has no path to name, so it carries this in `file` instead. */
const BASELINE_LABEL = '<verification baseline>'

/**
 * `resolveRegions` already refuses an entry whose comment is absent from the baseline. This is that
 * same refusal at file granularity, for the case where the baseline never held the file at all —
 * without it a verdict may name a file the snapshot missed, and every byte that entry changed goes
 * uncompared while the run still reports a pass.
 */
const unbackedEntryFailures = (baseline, entries) => {
  const reason = (file) =>
    `${file} is named by the verdict but absent from the verification baseline, so nothing this entry changed was compared`

  return entries
    .filter((entry) => !baseline.has(entry.file))
    .map((entry) => failureFor(entry.file, entry, reason(entry.file)))
}

/**
 * `ok` asserts two things: bytes were compared, and every difference among them was sanctioned. An
 * empty baseline fails the first, so it must not pass on the strength of the second being vacuously
 * true — that is the shape every fail-open here has taken.
 */
const emptyBaselineFailures = (baseline) => {
  if (baseline.size > 0) return []

  const reason = 'the verification baseline is empty, so this run compared nothing'
  return [{ file: BASELINE_LABEL, line: 1, reason }]
}

/**
 * Compares regions rather than diff hunks, because two ordinary correct fixes break a hunk-by-hunk
 * reading. A `shorten` whose replacement is a subset of the original lines produces a removal-only
 * diff with no matching addition, and a `delete` usually takes one adjacent blank line with it.
 *
 * Both trees are masked by their resolved regions and then compared line for line: anything left
 * over is a change nobody sanctioned.
 *
 * @param baselineFiles Map or object of repo-relative path to pre-fix content.
 * @param currentFiles  The same paths as they stand in the working tree.
 */
export const verifyFix = (baselineFiles, currentFiles, verdict) => {
  const baseline = toMap(baselineFiles)
  const current = toMap(currentFiles)
  const entries = filterVerdict(verdict)

  // Seeded rather than short-circuited: an entry reaching outside the baseline must not suppress the
  // report of a real unsanctioned change in a file that is inside it.
  const failures = [...emptyBaselineFailures(baseline), ...unbackedEntryFailures(baseline, entries)]
  const byFile = new Map()
  for (const entry of entries) pushInto(byFile, entry.file, entry)

  for (const file of baseline.keys()) {
    const before = baseline.get(file)
    const after = current.get(file)
    if (after === undefined || after === null) {
      failures.push({ file, line: 1, reason: 'file is missing from the working tree' })
      continue
    }
    failures.push(...verifyFile(file, before, after, byFile.get(file) ?? []))
  }

  return { ok: failures.length === 0, checked: baseline.size, failures }
}

/**
 * Both texts are folded to LF first. `extractComments` parses folded text, so the offsets it hands
 * back index that; slicing raw CRLF content with them shifts the window left by one character per
 * preceding line, and the mask then eats a newline and part of the code above.
 */
const verifyFile = (file, rawBefore, rawAfter, entries) => {
  const before = foldNewlines(rawBefore)
  const after = foldNewlines(rawAfter)
  const resolved = resolveRegions({ file, entries, before, after })
  if (resolved.failures.length > 0) return resolved.failures

  const beforeView = maskedView(before, resolved.beforeSpans)
  const afterView = maskedView(after, resolved.afterSpans)

  const relocated = misplaced({ file, moved: resolved.moved, beforeView, afterView })
  if (relocated.length > 0) return relocated

  const outside = compareViews(beforeView, afterView)
  if (outside.ok) return []

  return [
    { file, line: outside.line, reason: `unsanctioned change at ${file}:${outside.line} — ${describeHunk(outside)}` },
  ]
}

const failureFor = (file, entry, reason) => ({ file, line: entry.line, reason, entry })

/**
 * Locates every verdict entry in both trees: the comment it names in the baseline, and the
 * replacement it should have left in the working tree. What it resolves becomes a character span
 * the comparison may ignore. What it cannot resolve is a failure, because a verdict that no longer
 * matches the file can neither be executed nor verified.
 *
 * A region is claimed by at most one entry. Identical comments in one file — three `// Ask for
 * confirmation` above three calls — are the ordinary case this skill exists for, and matching them
 * all to the first occurrence would leave the other removals looking unsanctioned.
 */
const resolveRegions = ({ file, entries, before, after }) => {
  const beforeComments = extractComments(before, file)
  const afterComments = extractComments(after, file)

  const failures = []
  const beforeSpans = []
  const afterSpans = []
  const claimed = new Set()
  const claim = (comments, hash) => {
    const found = comments.find((comment) => comment.hash === hash && !claimed.has(comment))
    if (found) claimed.add(found)
    return found
  }

  const moved = []

  for (const [id, entry] of entries.entries()) {
    const region = claim(beforeComments, entry.textHash)
    if (!region) {
      const reason = `textHash ${entry.textHash} matches no comment in the baseline — the verdict is stale for this file`
      failures.push(failureFor(file, entry, reason))
      continue
    }

    beforeSpans.push({ id, pos: region.pos, end: region.end, offersBlank: entry.action === 'delete' })
    if (entry.action === 'delete') continue

    const wanted = textHash(entry.replacement)
    const landed = claim(afterComments, wanted)
    if (!landed) {
      const reason = `no comment in the working tree matches this entry's replacement (expected textHash ${wanted})`
      failures.push(failureFor(file, entry, reason))
      continue
    }

    afterSpans.push({ id, pos: landed.pos, end: landed.end })
    moved.push({ id, entry })
  }

  return { failures, beforeSpans, afterSpans, moved }
}

/**
 * The code a comment is attached to: the masked line it sits on if that line still holds something —
 * a trailing comment leaves its statement behind — and otherwise the next line that does.
 */
const anchorAt = (view, line) => {
  const found = lineSpan(line, view.lines.length).find((at) => !isBlank(view.lines[at - 1]))
  return found === undefined ? '<end of file>' : view.lines[found - 1]
}

/**
 * A `shorten` or `rewrite-as-why` must land where its comment was. Position is not otherwise checked
 * — regions are matched by hash and `line` is documented as a hint for humans — so without this a
 * replacement could be written anywhere in the file and verify clean. No code would change, but
 * `// why: guards reentry` parked above the wrong function is exactly the misinformation a
 * why-not-what policy exists to prevent.
 */
const misplaced = ({ file, moved, beforeView, afterView }) => {
  return moved.flatMap(({ id, entry }) => {
    const was = anchorAt(beforeView, beforeView.siteOf.get(id))
    const now = anchorAt(afterView, afterView.siteOf.get(id))
    if (was === now) return []

    const reason = `the replacement landed against ${JSON.stringify(now)} but the comment it replaces sat against ${JSON.stringify(was)}`
    return [failureFor(file, entry, reason)]
  })
}

/**
 * The file with every resolved region excised character by character, then each line right-trimmed.
 *
 * Excising characters rather than whole lines is what keeps the guarantee honest for a comment that
 * shares its line with code. `const x = 1 // sets x to one` masked by line would drop `const x = 1`
 * from the comparison too, so rewriting that statement under cover of a sanctioned comment edit
 * would pass — and deleting only the comment, which is the correct fix, would fail.
 *
 * A line the excision emptied is reported in `emptied`: that is a standalone comment, whose line is
 * genuinely gone from the other tree. `spendable` holds the one blank line each deletion may take
 * with it, offered only where the region actually emptied its line.
 */
/**
 * Widens a span over the whitespace the excision would orphan, so the mask produces exactly what an
 * applier writes. `const x = 1 // c` becomes `const x = 1`, and an inline comment opening a line
 * gives its trailing separator back: `/* a *` + `/ foo()` becomes `foo()`.
 *
 * Absorbing at excision time rather than allowing whitespace latitude at comparison time is what
 * keeps the check exact. Freeing both ends of a cut line looks harmless until the line is inside a
 * template literal — a comment can sit in a `${...}` there — and that whitespace is rendered output.
 */
const absorbResidue = (text, span) => {
  const ahead = text.slice(text.lastIndexOf('\n', span.pos - 1) + 1, span.pos)
  const [before] = ahead.match(/[ \t]*$/)

  // Code then a gap then the comment: that gap is the separator, and it goes with the comment.
  if (/\S/.test(ahead) && before.length > 0) return { ...span, pos: span.pos - before.length }

  // Otherwise the comment opens its line, or abuts the code in front of it, and the gap behind it is
  // what the excision would orphan. `${/* c */ x}` has to reduce to `${x}`, not `${ x}`.
  const [after] = text.slice(span.end).match(/^[ \t]*/)
  return { ...span, end: span.end + after.length }
}

const maskedView = (text, rawSpans) => {
  const spans = rawSpans.map((span) => absorbResidue(text, span))
  const rows = [{ text: '', origin: 1 }]
  const sites = []
  let cursor = 0
  let origin = 1

  const appendKept = (chunk) => {
    const parts = chunk.split('\n')
    rows[rows.length - 1].text += parts[0]
    for (const part of parts.slice(1)) {
      origin += 1
      rows.push({ text: part, origin })
    }
  }

  for (const span of [...spans].sort((a, b) => a.pos - b.pos)) {
    const from = Math.max(cursor, span.pos)
    const to = Math.max(from, span.end)
    appendKept(text.slice(cursor, from))
    sites.push({ id: span.id, line: rows.length, offersBlank: span.offersBlank === true })
    origin += countNewlines(text.slice(from, to))
    cursor = to
  }
  appendKept(text.slice(cursor))

  const lines = rows.map((row) => row.text)
  const emptied = new Set(sites.filter((site) => isBlank(lines[site.line - 1])).map((site) => site.line))
  const offering = sites.filter((site) => site.offersBlank && emptied.has(site.line))

  // Which blanks, and how many, are two different limits and both are needed. A deletion may take
  // one blank line, so the count caps it; but it may only take one from the run abutting the comment
  // it removed, or the allowance pays for an unrelated blank elsewhere in the file — or the file's
  // final newline. Blanks within one run are interchangeable, which is why the run is the unit.
  const spendable = new Set(offering.flatMap((site) => blankRunAround(lines, site.line, emptied)))
  const budget = offering.filter((site) => adjacentBlank(lines, site.line, emptied) !== null).length

  return {
    lines,
    emptied,
    spendable,
    budget,
    endsEmptied: emptied.has(lines.length),
    siteOf: new Map(sites.map((site) => [site.id, site.line])),
    originOf: (line) => rows[line - 1]?.origin ?? line,
  }
}

const isBlank = (line) => line !== undefined && line.trim() === ''

/** The contiguous blank lines reachable from an emptied site, in both directions. */
const blankRunAround = (lines, line, emptied) => {
  const reach = (step) => {
    const run = []
    let at = line + step
    while (at >= 1 && at <= lines.length && !emptied.has(at) && isBlank(lines[at - 1])) {
      run.push(at)
      at += step
    }
    return run
  }

  return [...reach(1), ...reach(-1)]
}

/**
 * The one blank line a deletion is allowed to take with it, or null. The line below wins over the
 * line above, because removing a comment normally closes the gap under it.
 */
const adjacentBlank = (lines, line, emptied) => {
  const candidate = [line + 1, line - 1].find((at) => {
    return at >= 1 && at <= lines.length && !emptied.has(at) && isBlank(lines[at - 1])
  })
  return candidate ?? null
}

/**
 * Everything outside the resolved regions must be identical. A deleted comment may or may not take
 * its adjacent blank line with it and both are correct, so the walk may skip a candidate blank when
 * the two sides disagree — each candidate once, since a deletion sanctions exactly one. Two blanks
 * gone at one deletion still fails: the second has no candidate left to spend.
 */
const compareViews = (before, after) => {
  const kept = lineSpan(1, before.lines.length).filter((line) => !before.emptied.has(line))
  const expected = after.lines.filter((_, index) => !after.emptied.has(index + 1))

  let budget = before.budget
  let source = 0
  let target = 0
  while (source < kept.length) {
    if (target < expected.length && before.lines[kept[source] - 1] === expected[target]) {
      source += 1
      target += 1
      continue
    }
    if (budget === 0 || !before.spendable.has(kept[source])) break
    budget -= 1
    source += 1
  }

  if (source === kept.length && trailingSlackSpent(before, expected, target)) return { ok: true }
  return {
    ok: false,
    line: before.originOf(kept[source] ?? kept.at(-1) ?? 1),
    removed: source < kept.length ? before.lines[kept[source] - 1] : undefined,
    added: expected[target],
  }
}

/**
 * A comment ending a file with no newline after it takes the file's last line with it, so removing
 * it legitimately restores the trailing newline the rest of the file already has. That is the only
 * length difference tolerated at the end; a trailing newline removed anywhere else still fails.
 */
const trailingSlackSpent = (before, expected, target) => {
  if (target === expected.length) return true
  return before.endsEmptied && expected.length - target === 1 && expected[target] === ''
}

const countNewlines = (text) => (text.match(/\n/g) ?? []).length

const describeHunk = ({ removed, added }) => {
  const from = removed === undefined ? '<end of file>' : JSON.stringify(removed)
  const to = added === undefined ? '<end of file>' : JSON.stringify(added)
  return `baseline had ${from}, working tree has ${to}`
}

/** Appends into a keyed bucket, creating the bucket on first use. */
const pushInto = (map, key, value) => {
  if (!map.has(key)) map.set(key, [])
  map.get(key).push(value)
}

/** Line numbers from `from` to `to`, both ends included, so a span can be iterated as a span. */
const lineSpan = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, offset) => from + offset)

const toMap = (files) => {
  if (files instanceof Map) return files
  return new Map(Object.entries(files ?? {}))
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

const toRepoRelative = (file) => path.relative(REPO_ROOT, path.resolve(file)).split(path.sep).join('/')

const isReviewable = (file) => /\.tsx?$/.test(file) && !file.includes('__tests__/')

const stillOnDisk = (file) => fs.existsSync(path.join(REPO_ROOT, file))

const gitLines = (args) => {
  const run = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  return run.status === 0 ? (run.stdout ?? '').split('\n').filter(Boolean) : []
}

/** Everything the branch changed since it forked from the trunk. */
const branchFiles = () => {
  const [base] = gitLines(['merge-base', 'HEAD', 'origin/HEAD'])
  return base ? gitLines(['diff', '--name-only', '--diff-filter=d', base]) : []
}

/**
 * A widening ladder, stopping at the first rung that yields anything: what you named, then what you
 * have not committed, then what the branch itself changed.
 *
 * That last rung is what keeps the skill useful after a commit. Stopping at `git diff` means a
 * branch whose work is already committed reviews nothing and reports a clean bill, which is the one
 * answer this skill must never give by accident. The rung that produced the scope is reported, so a
 * reader can tell which question was actually answered.
 */
/**
 * Why a named file cannot be judged. A file you named is never dropped from the scope — silently
 * discarding what a human asked for is its own fail-open, and `snapshot` resolves its list through
 * this same function, so a drop here would un-capture the file at the other end too. It is reported
 * instead, and `runSnapshot` refuses the one case it cannot copy.
 *
 * Probed in order: a typo'd path is more useful reported as absent than as the wrong extension.
 */
const UNREVIEWABLE = [
  { why: 'not on disk', hit: (file) => !stillOnDisk(file) },
  { why: 'not a .ts or .tsx file', hit: (file) => !/\.tsx?$/.test(file) },
  { why: 'inside __tests__', hit: (file) => file.includes('__tests__/') },
]

/** Answered on repo-relative paths: `stillOnDisk` joins against `REPO_ROOT` and misreads an absolute one. */
const unreviewableIn = (scope) => {
  return scope.flatMap((file) => {
    const probe = UNREVIEWABLE.find((candidate) => candidate.hit(file))
    return probe === undefined ? [] : [{ file, why: probe.why }]
  })
}

const resolveScope = (files) => {
  if (files.length > 0) {
    const scope = files.map(toRepoRelative)
    return { scope, source: 'arguments', unreviewable: unreviewableIn(scope) }
  }

  const rungs = [
    { source: 'working-tree', find: () => gitLines(['diff', '--name-only', '--diff-filter=d', 'HEAD']) },
    { source: 'branch', find: branchFiles },
  ]

  for (const rung of rungs) {
    const scope = rung.find().filter(isReviewable).filter(stillOnDisk)
    if (scope.length > 0) return { scope, source: rung.source, unreviewable: [] }
  }

  return { scope: [], source: 'empty', unreviewable: [] }
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

const MANIFEST = '.comment-verifier-snapshot.json'

/**
 * What a snapshot holds, repo-relative, read from the manifest it wrote.
 *
 * Inferring the list by walking the directory was a hole: `--snapshot` copies whatever you name,
 * while the walk filtered by the same `.ts`/`.tsx`-and-not-`__tests__` rule the scope uses, so a
 * file the snapshot captured but the filter rejected was never compared. The two halves have to
 * agree by construction, and only the half that did the copying knows the answer.
 *
 * The walk survives as a fallback for a baseline assembled by hand, where a verdict commonly sits
 * beside the snapshot and the filter is the best guess available. That path is best-effort.
 */
const snapshotFiles = (dir) => {
  const root = path.resolve(dir)
  if (!fs.existsSync(root)) return []

  const recorded = readFileOrNull(path.join(root, MANIFEST))
  if (recorded !== null) return JSON.parse(recorded).files ?? []

  const walk = (at) => {
    return fs.readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(at, entry.name)
      return entry.isDirectory() ? walk(full) : [path.relative(root, full).split(path.sep).join('/')]
    })
  }

  return walk(root).filter(isReviewable)
}

/**
 * The manifest is written **before** the copies. A run that dies mid-copy would otherwise leave a
 * directory with no manifest, which `snapshotFiles` reads through its walk fallback as a complete
 * but smaller snapshot — and a truncated baseline verifies clean. Written first, the same accident
 * lands on `runVerifyFix`'s `no baseline snapshot for` guard instead.
 */
const snapshot = (dir, scope) => {
  const root = path.resolve(dir)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify({ files: scope }, null, 2))

  for (const file of scope) {
    const target = path.join(dir, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(REPO_ROOT, file), target)
  }

  return { snapshot: root, files: scope }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['--hash', '--snapshot', '--verify-fix', '--baseline'])

/** Splits argv once into flag values and positional files, so no later step has to guess what is left. */
const parseArgv = (argv) => {
  const flags = {}
  const files = []
  const rest = [...argv]

  while (rest.length > 0) {
    const arg = rest.shift()
    if (VALUE_FLAGS.has(arg)) flags[arg] = rest.shift() ?? null
    else files.push(arg)
  }

  return { flags, files }
}

const emitJson = (value) => console.log(JSON.stringify(value, null, 2))

const failedCheck = (failures) => ({ ok: false, checked: 0, failures })

const readFileOrNull = (absolute) => {
  try {
    return fs.readFileSync(absolute, 'utf8')
  } catch {
    return null
  }
}

const isReadableFile = (absolute) => {
  try {
    return fs.statSync(absolute).isFile()
  } catch {
    return false
  }
}

/**
 * Both refusals happen here rather than one phase later, while the operator can still act on them.
 * An empty scope would write an empty baseline, which verifies anything; an unreadable named path
 * would reach `copyFileSync` and exit through a stack trace. `runVerifyFix` is deliberately not
 * given the same treatment — it must keep comparing a file the snapshot holds and the tree has lost.
 */
const runSnapshot = (dir, files) => {
  const { scope, unreviewable } = resolveScope(files)
  if (scope.length === 0) {
    console.error('--snapshot resolved no files, so there would be no baseline to verify against')
    return 2
  }

  const unusable = scope.find((file) => !isReadableFile(path.join(REPO_ROOT, file)))
  if (unusable !== undefined) {
    console.error(`--snapshot cannot capture ${unusable}: it is not a readable file`)
    return 2
  }

  emitJson({ ...snapshot(dir, scope), unreviewable })
  return 0
}

const runVerifyFix = (flags, files) => {
  const verdictPath = flags['--verify-fix']
  const baselineDir = flags['--baseline']
  if (!verdictPath || !baselineDir) {
    console.error('--verify-fix <verdict.json> requires --baseline <snapshot dir>')
    return 2
  }

  const verdict = JSON.parse(fs.readFileSync(verdictPath, 'utf8'))
  const schema = validateVerdict(verdict)
  if (!schema.ok) {
    emitJson(failedCheck(schema.errors.map((reason) => ({ file: verdictPath, line: 1, reason }))))
    return 1
  }

  // With no files named, the SNAPSHOT names them, not the verdict. Scoping to the files a verdict
  // wants written would leave every other snapshotted file unread, and an edit to one of those is
  // exactly the unsanctioned change this check exists to catch.
  const scope = files.length > 0 ? resolveScope(files).scope : snapshotFiles(baselineDir)
  const missing = scope.find((file) => readFileOrNull(path.join(path.resolve(baselineDir), file)) === null)
  if (missing !== undefined) {
    emitJson(failedCheck([{ file: missing, line: 1, reason: `no baseline snapshot for ${missing}` }]))
    return 1
  }

  const baseline = new Map(scope.map((file) => [file, readFileOrNull(path.join(path.resolve(baselineDir), file))]))
  const current = new Map(scope.map((file) => [file, readFileOrNull(path.join(REPO_ROOT, file))]))

  const report = verifyFix(baseline, current, verdict)
  emitJson(report)
  return report.ok ? 0 : 1
}

const main = (argv) => {
  const { flags, files } = parseArgv(argv)

  if ('--hash' in flags) {
    console.log(textHash(flags['--hash'] ?? ''))
    return 0
  }

  if ('--snapshot' in flags) {
    if (!flags['--snapshot']) {
      console.error('--snapshot requires a directory')
      return 2
    }
    return runSnapshot(flags['--snapshot'], files)
  }

  if ('--verify-fix' in flags) return runVerifyFix(flags, files)

  const { scope, source, unreviewable } = resolveScope(files)
  emitJson({ scope, scopeSource: source, counts: { files: scope.length }, unreviewable })
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2))
}
