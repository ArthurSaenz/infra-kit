# Verdict contract

The verdict phase produces this array; the apply phase consumes it. Both run in the same invocation,
so the interface is not a handoff between two commands — it is the record that makes the run
auditable. This file pins the shape and the hash; the phases that write and check it are in
`SKILL.md`.

## Shape

A JSON array. One entry per reviewed comment.

```json
[
  {
    "file": "apps/infra-kit/cli/src/commands/worktrees-add/worktrees-add.ts",
    "line": 126,
    "textHash": "4d530b7772c6",
    "action": "delete",
    "reason": "restates `await confirmOrExit(...)` on the next line"
  }
]
```

| Field | Rule |
|---|---|
| `file` | Repo-relative path. Non-empty. |
| `line` | Positive integer. **A hint for humans only** — the apply phase matches on `textHash`. |
| `textHash` | Exactly 12 lowercase hex characters. See below. |
| `action` | One of `delete`, `shorten`, `rewrite-as-why`, `rename-or-refactor-instead`, `keep`. |
| `reason` | Non-empty prose. |
| `replacement` | **Required, non-empty, and the exact replacement text** for `shorten` and `rewrite-as-why`. **Must be absent** for `delete`, `keep` and `rename-or-refactor-instead`. |

Only `delete`, `shorten` and `rewrite-as-why` are ever executed. `keep` and
`rename-or-refactor-instead` are decisions to leave the file alone, as is any comment the verdict
never listed.

### Why `replacement` is mandatory on exactly two actions

`shorten` and `rewrite-as-why` are the only actions that put new bytes in the file, and
`--verify-fix` can only check bytes it was told to expect. A `shorten` that says "cut this to four
lines" instead of supplying the four lines is unverifiable, so the contract does not permit it. The
other three add nothing, so a `replacement` on them is a contradiction and is rejected.

### Reason quality

- A `delete` **quotes the code line that already carries the information.** Without that quote the
  entry is an assertion, not an argument, and deleting a comment destroys information.
- A `keep` **names which reserved category applies**: external quirk, ordering constraint, fail-safe
  branch, or workaround.

## `textHash`, pinned

`textHash` is computed in one pass and compared in another, so its definition is part of the
contract rather than an implementation detail.

**It is the sha256 of the normalized comment text, first 12 hex characters.** Twelve hex is 48 bits:
far beyond collision range for the few hundred comments one scoped run ever holds, and still
skimmable in a verdict a human reads.

Normalization, applied identically by the script and by whoever produces a verdict by hand:

1. CRLF folded to LF.
2. Trailing whitespace stripped per line.
3. **Comment markers excluded** — `//`, `/**`, `/*`, the leading `*` of a continuation line and the
   closing `*/` — together with the single conventional space that follows an opening marker or
   precedes the closing one. Leading indentation is removed as part of reaching the marker.
   An opening marker is recognised only when that space (or a line end) follows it, so `//Foo` keeps
   its `//` in the normalized text. Both sides of every comparison normalize identically, so this
   changes no outcome — the sentence exists so the next reader does not "fix" a hash that is not
   broken and invalidate every pinned vector below.
4. Leading and trailing blank lines dropped, so a block and a line comment carrying the same prose
   normalize alike.
5. No other change.

Markers are excluded because `shorten` and `rewrite-as-why` routinely convert a block comment to a
line comment or the reverse. A hash including the markers would read identical prose in a different
wrapper as a different comment, which is exactly the case the verifier most needs to recognise.

The reference implementation is `normalizeCommentText` / `textHash` in
`scripts/lint-comments.mjs`. Print one with:

```
node .claude/skills/comment-verifier/scripts/lint-comments.mjs --hash '// Ask for confirmation'
```

Pinned vectors, all three of which hash alike:

| Input | Reason |
|---|---|
| `// Foo` | baseline |
| `/** Foo */` | markers excluded, so the wrapper does not matter |
| `// Foo   ` | trailing whitespace stripped |

Identical prose repeated in one file therefore hashes identically, which is ordinary rather than a
collision — three `// Ask for confirmation` above three calls is the case this skill exists for.
Each verdict entry claims one occurrence, in the order the entries appear.

## What `--verify-fix` actually checks

```
node .claude/skills/comment-verifier/scripts/lint-comments.mjs --verify-fix <verdict.json> --baseline <dir>
```

Exit 0 on pass, 1 on fail. It prints `{ ok, checked, failures: [{ file, line, reason, entry? }] }`.

`ok` asserts **two** things: bytes were compared, and every difference among them was sanctioned.
Both new failures below fall out of the first conjunct rather than being guards bolted onto the
second, which is why `checked` is load-bearing rather than informational:

- **An empty baseline never verifies anything**, so `checked: 0` is always a failure. There is no
  legitimate caller — phase 3 stops before phase 4 when the filtered verdict is empty — and a
  `--baseline` naming a nonexistent or empty directory used to pass on the strength of comparing
  nothing.
- **Every write-action entry must name a file present in the baseline.** A file the baseline never
  held has no "before" to compare against, so nothing that entry changed was examined. This is the
  same refusal `resolveRegions` already makes for an entry whose comment is missing, applied one
  level up: there, the file is present and the comment is stale; here, the file is absent entirely.
  `keep` and `rename-or-refactor-instead` write nothing and so are exempt.

`file` on a verdict entry must be **byte-identical** to the scope string the script printed — the
baseline is keyed on that string, so `./a.ts` or an absolute path names nothing.

A **run-level** failure has no path to name and carries a label in `file` instead: `<verification
baseline>` for the empty-baseline refusal. This corrects the table above, which is already too
narrow today — `runVerifyFix` puts the verdict's own path in `file` for schema failures.

It compares **regions, not raw diff hunks**, because two ordinary correct fixes break a
hunk-by-hunk reading:

- A `shorten` whose replacement is a **subset of the original lines** produces a removal-only diff
  with no added lines at all. A verifier looking for a matching addition would fail a correct fix.
- A `delete` commonly takes **exactly one adjacent blank line** with it, since leaving the blank
  behind is what makes a deletion look sloppy.

So each verdict entry is resolved to a before-region in the snapshot (the comment whose normalized
text hashes to `textHash`) and an after-region in the working tree:

| Action | After-region |
|---|---|
| `delete` | nothing, plus at most **one** blank line per deletion may disappear |
| `shorten`, `rewrite-as-why` | the comment now at that position, whose normalized text must hash equal to `hash(replacement)` |

**A region is a character span, not a line span.** That distinction is the whole guarantee for a
comment sharing its line with code. Masking `const x = 1 // sets x to one` by line would take
`const x = 1` out of the comparison as well, so rewriting that statement under cover of a sanctioned
comment edit would pass — and deleting only the comment, which is the correct fix, would fail for
want of a matching line. The span is excised in place, the line is right-trimmed, and only a line
the excision actually emptied is dropped.

Both trees are then masked and compared line for line. **Anything left over is a change nobody
sanctioned**, and it fails, naming the file, the line and the hunk. Two blank lines removed at one
deletion fails. A non-verdict comment removed fails. A sanctioned deletion with arbitrary text
written in its place fails, because that text is in no after-region. Code on the same line as an
edited comment is compared like any other code.

The excision also **absorbs the whitespace it would orphan**, so the mask produces exactly what an
applier writes: `const x = 1 // c` reduces to `const x = 1`, an inline comment opening a line gives
its trailing separator back, and `${/* c */ x}` reduces to `${x}`. Every line is then compared byte
for byte. The alternative — allowing a cut line's whitespace to differ — looks harmless until the
line is inside a template literal, where a comment can sit in a `${...}` and the surrounding
whitespace is rendered output; absorbing at excision time keeps the check exact instead.

One length difference is tolerated at the end of a file: a comment ending a file with **no newline
after it** takes the file's last line with it, so removing it may restore the trailing newline the
rest of the file already has.

The blank-line allowance has **two limits, and both are needed**. How many: one per deletion that
had a blank to take. Which: only blanks in the contiguous run abutting the comment that was removed.
The count alone would pay for an unrelated blank elsewhere in the file, or for the file's final
newline. Pinning a single line number instead would reject the correct fix whenever a comment sits
above two blanks, since blanks within a run are interchangeable — the run is the unit. Blank lines are interchangeable, so which one a deletion took is unanswerable; pinning
the allowance to a particular line number rejects the correct fix whenever a comment sits above two
blanks. The count still caps it.

A `shorten` or `rewrite-as-why` must also land **where its comment was**, checked by the code the
comment is attached to: the line it sits on if that line still holds something, and otherwise the
next line that does. Nothing else checks position — regions are matched by hash, and `line` is a
hint for humans — so without it a replacement could be written anywhere in the file and verify
clean. No code would change, but `// why: guards reentry` parked above the wrong function is exactly
the misinformation a why-not-what policy exists to prevent.

An entry whose `textHash` matches nothing left unclaimed in the baseline fails as a stale verdict,
naming the entry — never a silent skip, never a nearest match. An unrelated dirty file that is not
in scope is never read, so it cannot fail the check.
