# Session shell: pause after a command instead of redrawing the palette

Status: APPROVED for execution (user, 2026-09-05). Q1 answered: any key returns to the palette. Q2 answered: Ctrl-Z suspends.

Revision: 3 (adds the Architect's re-review N1-N5 and O1-O4, and the Critic's pass-2 riders R1 and R2
plus its four non-blocking items. Revision 2 addressed the Architect's original 11 required changes and
the Critic's B1-B7; both reviewers report those closed, and the design — Option A, the three-phase
signal owner, the single arm sequence, the `afterRun(ctx)` seam, the drain, the hint balance invariant,
and the relay divergence — is settled and not re-opened here.)

Owner: planner (RALPLAN-DR, deliberate mode) · Package: `apps/infra-kit/cli` · Date: 2026-09-05

---

## 1. Summary

> User request: "at the end of a command do not redraw the command list immediately — offer press any key to reopen the list and run again, or Esc / Ctrl-C / Ctrl-Z to leave the session shell entirely."

Today `runSession` writes the status footer and immediately awaits `renderPalette`, so an Ink frame
nearly as tall as the viewport lands on top of the output the user was about to read. This change
inserts one blocking keypress between the footer and the next palette draw: a single dim hint line is
written under the footer, one raw key is read, and only then does the palette redraw. Esc, Ctrl-C and
Ctrl-D end the session; Ctrl-Z suspends the job; every other key returns to the palette. The hint is
erased before anything else draws, so the scrollback keeps exactly the shape it has today.

**What changed in revision 2.** Two defects that would have shipped: the arm sequence never called
`acquireStdin`, so node would have exited (status 0, indistinguishable from a deliberate quit) about
150 ms after every command; and the single `childOwnsSigint` boolean cannot express the pause's signal
needs, so an external `kill -TSTP` would have handed the user's shell a raw tty. Both are fixed by
reusing what the repo already has — the stdin refcount, and a phase concept the boolean under-models.

---

## 2. Principles

1. **The transcript is the product.** Header, child output, footer — nothing this change adds may
   survive in the scrollback, and nothing it draws may scroll the block out of view.
2. **The session layer stays React-free, but not primitive-free.** `src/lib/session/**` is the eager
   chunk and is unit-tested with plain vitest. Every terminal primitive the pause needs already exists
   in this repo — `acquireStdin`/`releaseStdin`, the escape vocabulary in `reset-terminal.ts`,
   `suspendForeground` — and must be reused rather than re-derived. "React-free" is not a licence to
   hand-roll stdin ownership.
3. **Signal ownership follows stdin ownership.** The signal owner must model three phases, not two: a
   child holds a cooked tty, the palette holds a raw one, and the pause holds a raw one too. Which
   signals are swallowed and which are honoured differs between all three.
4. **Trailing input is hostile.** A user stopping `dev` mashes Ctrl-C. Bytes *and* signal handler
   callbacks aimed at a process that is already dead can arrive after the pause begins.
5. **Prove terminal claims on a terminal — and only what the harness can actually see.** A `script`
   byte capture can prove ordering and absence-after-a-mark. It cannot prove that an escape erased a
   row. Claims about the rendered screen need `tmux capture-pane` and therefore a manual gate.

---

## 3. Decision drivers

1. **Scrollback fidelity.** The whole point is that the command's output stays readable. A pause that
   commits a frame, wraps a hint, or leaves a corpse defeats the feature it implements.
2. **Signal safety around `dev`.** `dev` is the longest-running command and the one users kill with a
   burst of Ctrl-C. Getting the handoff wrong turns "return to the menu" into "the session quit" or,
   worse, "the session cannot be killed".
3. **Change size and complexity budget.** The palette component is at the sonarjs ceiling (15) and
   cannot absorb a new branch. Whatever we build must sit somewhere with headroom and must not force
   edits into `CommandPalette`.

---

## 4. Viable options

### Option A — React-free raw-stdin pause in `src/lib/session/`, behind a `RunSessionDeps` seam (CHOSEN)

A new `src/lib/session/post-run-pause.ts` exports `awaitPostRunKey(deps): Promise<'palette' | 'quit'>`.
`runSession` calls it through a new optional dep, `afterRun`, at the end of each loop iteration.

Pros:
- **No per-command mount.** Option B mounts and unmounts an Ink app, and runs Ink's own
  ref/unref/pause cycle, after every single command — on the hottest path in the shell. Option A
  attaches one listener and a timer.
- **State locality.** The loop, the transcript writes and the signal phase already live in
  `run-session.ts`. Keeping the pause beside them means the whole feature — including the one subtle
  part, when the signal phase flips — is reviewable in one file rather than across a dynamic import.
- **Testability.** The classifier is a pure function and the reader takes an injectable stdin, so both
  are plain-vitest testable. Option B can only be tested through an Ink harness, in which raw mode,
  the cursor and erasure are all fiction.
- Nothing added to `CommandPalette`, whose complexity budget is exhausted.

Cons:
- The pause must own raw mode, the stdin refcount, cursor position and suspend/resume sequencing
  itself. Ink gets all of those right today, and this repo has already paid twice for getting them
  wrong by hand (`src/tui/boot.tsx:28-107` is a hundred lines of comment about exactly that). This is
  mitigated only by discipline: reuse the existing primitives (principle 2), and specify one ordered
  sequence (§5.5) rather than three prose descriptions.
- **Hint-copy drift.** The palette's `HINTS` live in `src/tui/screens/command-palette.tsx:311-314` and
  the pause's copy will live in `src/lib/session/format-entry.ts`. Two files, one visual language, one
  row apart in the same transcript. Option B would have kept them together. Accepted; the width guard
  test covers both, and §5.3 pins the shared separator vocabulary.
- Ctrl-Z needs `suspendForeground`, which currently sits under `src/tui/`. Requires a module move
  (see §8 step 1), contingent on Q2.

### Option B — a tiny Ink screen in `src/tui/`, exposed as `runPostRunPause()` from `boot.tsx`

Pros:
- `useInput` gives parsed keys for free, and `useApp().suspendTerminal` gives a correct Ctrl-Z with
  frame erase, cursor restore and raw-mode drop already sequenced — the three primitives revision 1 of
  this plan got wrong by hand.
- Ink owns the stdin ref, so the exit-0 defect fixed in this revision could not have existed.
- Key handling is the same code path as the palette, so the hint copy and the key map cannot drift.

Rejected, on these grounds only:
- A mount and unmount per command, plus Ink's ref/unref/pause cycle, on the shell's hottest path.
- It splits the feature across two chunks: the loop and the signal phase stay in `run-session.ts`
  while the reader lives in the lazy Ink chunk, so no single file describes the behaviour.
- The classifier stops being a pure function and the whole pause becomes testable only through
  `ink-testing-library`, where the properties that matter are not observable.

Revision 1 rejected Option B on two further grounds that do not survive review and are withdrawn: that
the frame-erase dance is "the one mechanism known to corrupt the scrollback" (the palette already
carries it and it is tested), and that it would split the signal window across an async contract (an
`onArmed` prop is a plain function argument, exactly as `onSuspend` already is at
`src/tui/boot.tsx:133-139`).

### Option C — no pause; make the palette compact so it stops covering the output

Invalidated: it does not answer the request, and `listLayout` already compacts on short terminals. On a
tall terminal a long command list legitimately fills the viewport, so this only narrows the symptom.

### Option D — cooked-mode "press Enter to continue"

Pros: no raw mode, therefore no trailing-byte hazard, no stdin refcount, no phase enum, and Ctrl-C
stays a real SIGINT the existing handlers already answer correctly. Roughly ten lines.

Invalidated: the user asked for any key, and Enter-only is a worse interaction than the redraw it
replaces. **Recorded as the named rollback** if raw-mode handling proves unstable in the field — it
removes every hazard in §6 at once.

---

## 5. Design

### 5.1 Where the pause sits in the loop

`runSession`'s body gains exactly one step, at the very end, after the footer write:

```
[quitRequested?] -> phase='palette' -> renderPalette -> resolve -> header -> phase='child' (in runOne)
                 -> runOne -> footer -> afterRun(ctx)   // ctx.armed() sets phase='pause'
```

`afterRun(ctx)` resolving to `'quit'` returns from the loop. Resolving to `'palette'` continues to the
next iteration, whose existing top-of-loop assignment sets the phase back to `'palette'`.

The `!command` path (`continue` before the header) skips `afterRun` entirely, which is correct: no
command ran, so there is no output to protect.

### 5.2 Key map

The classifier is a pure function over the raw chunk, using the same chunk-length rule as `withEscape`
(`src/lib/prompts/escapable-context.ts:64-65`): a lone `0x1b` is Esc, while `\x1b[A` (3 bytes) is an
arrow key and therefore just "a key".

| Input chunk | Result |
| --- | --- |
| single byte `0x1b` (Esc) | quit |
| single byte `0x03` (Ctrl-C) | quit |
| single byte `0x04` (Ctrl-D) | quit |
| single byte `0x1a` (Ctrl-Z) | suspend (stays in the pause) |
| anything else — space, `\r`, `\x1b[A`, `\x1bx` coalesced, multi-byte UTF-8, a paste | continue to palette |

```ts
export type PauseKey = 'quit' | 'suspend' | 'continue'

const SINGLE_BYTE: Record<number, PauseKey> = { 0x03: 'quit', 0x04: 'quit', 0x1a: 'suspend', 0x1b: 'quit' }

export const classifyPauseKey = (chunk: Uint8Array): PauseKey =>
  chunk.length === 1 ? (SINGLE_BYTE[chunk[0]!] ?? 'continue') : 'continue'
```

Where suspending is impossible (win32), the caller maps `'suspend'` to `'continue'`; the classifier
itself stays total and platform-free, mirroring how `CommandPalette` takes `onSuspend` as the platform
authority's verdict rather than inspecting `process`.

**The Esc asymmetry, stated rather than passed over.** One row up, in the palette, Esc clears the
filter and explicitly never quits — `command-palette.tsx:179-183` calls an Esc that quit "a quit
wearing a back-out's clothes", because popping the root would leave nowhere to land. One row down, at
the pause, Esc quits. The asymmetry is defensible and deliberate: at the pause there is no filter to
pop and no screen behind it, so Esc has exactly one level to pop and popping it *is* leaving. The
user's own request also named Esc first among the exit keys. The footer copy will therefore read
`Esc clear` in the palette and `Esc quit` in the pause, one row apart in the same transcript; that is
accepted, and it is the same argument Q2 rejects for Ctrl-Z, where a filterless second meaning does not
exist.

Deliberate non-goals, to be stated in the module doc: a coalesced `Esc`+key chunk reads as "continue",
and a bracketed paste reads as one continue. Both fail toward the palette, never toward quitting.

### 5.3 The hint line

Copy lives in a dedicated module-scope const in `src/lib/session/format-entry.ts`, **not** in that
file's existing `T`, whose doc (`format-entry.ts:30`) scopes it to "the transcript entry" — a pause
hint is not one. The file's header doc widens from "one committed transcript block" to "the lines the
session shell itself owns".

- suspend variant: `any key commands · Esc / Ctrl-C quit · Ctrl-Z suspend` (48 columns)
- plain variant: `any key commands · Esc / Ctrl-C quit` (32 columns)
- ascii variants: `·` becomes `-`, same words.

Rendering rules, via a new pure `formatPauseHint({ canSuspend, ascii, color, width })`:
- dim, via the same `chromeStyler` the footer already uses, so `color: false` yields a clean string.
- truncated to `width - 1` cells (measured with the existing `cellWidth`, not `String.length`).
- **`width: undefined` writes the hint untruncated.** `columns()` is `() => number | undefined` and
  `stderrColumns` (`run-session.ts:100-104`) deliberately normalises both a missing property and a
  zero to `undefined`. `undefined - 1` is `NaN` and every comparison against `NaN` is false, so a
  naive truncation would silently no-op. This is not hypothetical on our own harness: measured,
  `script -q /dev/null env COLUMNS=40 node -e 'console.error(process.stderr.columns)'` reports `0`,
  which `stderrColumns` maps to `undefined`. The explicit branch matches the precedent in `ruleSuffix`
  (`format-entry.ts:189-203`), whose `width == null` guard at `:195` returns `''` — "draw no rule".
- written to the same `write` seam as the transcript (stderr), with **no trailing newline**, so it
  occupies the blank row the footer's trailing `\n` just opened.
- erased with `\r` followed by `\x1b[2K` before anything else draws. The cursor ends at column 0 of
  that same blank row, which is precisely where today's palette (or the user's shell prompt) starts
  drawing. Scrollback is byte-identical to today's.

**The hint is written after the drain, in one write, and this is deliberate.** Writing a provisional
hint before the drain and swapping it afterwards would remove 150 ms of blank terminal on a fast
command such as `version`, where 150 ms is a large fraction of the perceived interaction. It is
rejected anyway: it costs an extra write and an extra erase on the hottest path, and every extra
erase is another chance to leave a corpse — the failure this feature exists to prevent. 150 ms sits
below the threshold at which a delay reads as unresponsive, and "hint on screen means keys are live"
is worth more than the margin. Revisit only on field feedback.

**A resize while the pause is open is a documented non-goal** (Critic R2). Narrow the terminal while
the hint is on screen and the emulator reflows that row into two; the erase clears one and the other
survives as a dim corpse, once per resize. The three ways out are to shrink the hint to a conservative
width, to redraw it on `SIGWINCH`, or to accept it. **Accepted**, for two reasons. No fixed width is
safe against an arbitrary narrowing, so the first is not a fix. And the second is the move this repo
has already tried and rejected one layer down: `src/tui/safe-stderr.ts:14-17` records that bounding
Ink's frame height is *not* a sufficient guard precisely because a `SIGWINCH` redraw reasons about the
new viewport with the previous frame's geometry, so the repo moved that guard to the bytes instead. An
erase-on-resize here has the same defect in miniature — by the time `SIGWINCH` is delivered the hint
may already occupy two rows, so a single-row erase leaves one behind and the redraw adds a third, and
erasing correctly would mean tracking the pre-resize width. That is real machinery, plus a fifth
process-level signal listener living outside the phase-aware owner this plan just spent two rounds
consolidating, for a dim row the user's own resize produced. §9's criterion 3 is narrowed to say so
rather than asserting a property the design does not deliver. The `fg` case is different and *is*
fixed: there the pause is about to write a hint anyway, so re-reading the width costs nothing (§5.7
step 5).

### 5.4 Signal phases

`installSessionSignals` takes a phase getter instead of the `isChildRunning` predicate:

```ts
export type SessionPhase = 'palette' | 'child' | 'pause'
installSessionSignals(getPhase: () => SessionPhase, deps: SessionSignalDeps): SessionSignals
```

`childOwnsSigint` is deleted. It carried two meanings at once — "swallow a stray SIGINT" and "the tty
has already TSTP'd the group, so follow it down" — and those come apart for the first time inside the
pause. `command-palette.tsx:127-136` ends its account of the same distinction with "DO NOT UNIFY THE
TWO"; revision 1 unified them for 150 ms.

| Signal | `'child'` | `'pause'` | `'palette'` |
| --- | --- | --- | --- |
| SIGINT | record `lastSigintAt`, swallow | **swallow, record nothing** | `resetTerminal(); exit(0)` |
| SIGTERM | relay test → swallow, else `quitRequested = true` (deferred) | relay test → swallow, else `resetTerminal(); exit(0)` **immediately** | `resetTerminal(); exit(0)` |
| SIGHUP | `exit(129)` | `exit(129)` | `exit(129)` |
| SIGTSTP | `raise('SIGSTOP')` | **delivered and ignored** | delivered and ignored |

Three rows need their reasoning on the record.

**SIGINT in `'pause'` is swallowed, not honoured.** The tty cannot generate one there — raw mode
clears ISIG — so the only two sources are an external `kill -INT` and, more importantly, a *tty* SIGINT
generated microseconds earlier while the child still held a cooked terminal, whose node handler runs at
the next event-loop boundary and therefore after the phase has already flipped. That second case is the
mashed-Ctrl-C-at-`dev` scenario expressed in signals rather than bytes, and it must be swallowed for
the same reason the drain discards bytes. The cost is that a deliberate `kill -INT` at the pause does
nothing; `kill -TERM` still works, and this is the mild direction of the error.

**Nothing is recorded in `lastSigintAt` here, and this row is what bounds the whole divergence below.**
Revision 2 justified it by claiming the SIGTERM row never consults `lastSigintAt` in a way this could
help; that is false, and the table three rows up refutes it — the relay test
(`run-session.ts:316-319`) *is* the `lastSigintAt` consultation. The real reason is the opposite one.
The pause blocks indefinitely by design, so if a SIGINT arriving there refreshed `lastSigintAt`, a
repeated `kill -INT` would extend the relay-swallow window without bound and hold the session immune to
SIGTERM for as long as someone kept sending them. Not recording pins the window to the last SIGINT
delivered while the phase was `'child'` — `lastSigintAt` is otherwise cleared only by `childStarted()`
(`run-session.ts:350-352`, called at `:512`) — which bounds the exposure at one
`PNPM_RELAY_WINDOW_MS` (1000 ms, `run-session.ts:251`) measured from the child's last Ctrl-C, after
which the very next SIGTERM is honoured. That bound is the reason the row cannot be simplified, and it
is stated once more in criterion 9.

**SIGTERM in `'pause'` keeps the relay test, and this is a deliberate divergence from the Critic's
B1.** B1 is right that acceptance criterion 8 as written was unachievable, and right about the cause:
`lastSigintAt` is cleared only by `childStarted()` (`run-session.ts:350-352`), never on child exit, so
the pause runs inside the 1000 ms relay window by construction whenever the user Ctrl-C'd the child.
But B1's prescribed fix — route SIGTERM in `'pause'` straight to exit, bypassing the relay test —
reintroduces the bug the window exists to prevent. The relay was measured at **6 ms and 16 ms** after
the SIGINT (`run-session.ts:232-250`), and the phase flips to `'pause'` within a millisecond of the
child's exit: between the child's `exit` event and `ctx.armed()` there is no event-loop turn — the
terminal reset, `readAndUnlinkReport` (`report.ts:159`, `:164`, both synchronous `fs` calls),
`classifyOutcome`, the formatter and the footer write are all synchronous, and the one `await` in the
chain resolves as a microtask, which cannot interleave with a signal dispatched from libuv's poll
phase. A fast child killed with Ctrl-C would therefore have its pnpm relay land in `'pause'`, and the
session would die on an ordinary Ctrl-C. So: keep the causality test, and fix the half B1 actually
exposed — a SIGTERM that *fails* the relay test in `'pause'` exits immediately rather than setting
`quitRequested`, because there is no child left whose transcript needs committing, and nothing would
read the flag until after a keypress that a `kill` cannot supply. Both reviewers verified this premise
against the code and accept the divergence; the Critic withdrew its prescription. Criterion 9 states
the resulting exception and its bound.

**What the divergence reveals about today's code, recorded so it is not re-derived.** The same
no-`await` analysis says the exposure already exists on `main`: because nothing suspends between the
footer write and the top-of-loop `childOwnsSigint = false`, a fast child stopped with Ctrl-C under
`pnpm exec infra-kit` can have its relay land after the flag clears, where `onSigterm` takes the
`!isChildRunning()` branch and calls `resetTerminal(); exit(0)`. The session dies on an ordinary
Ctrl-C. Two consequences follow, neither of which needs fixing here. The pause **incidentally shields
the common case**, because it now occupies the window the relay lands in and answers it with the relay
test. And the `'palette'` row still carries the exposure, now behind a keypress rather than immediately
— a narrowing, not a fix, and out of scope for the user's ask.

**SIGTSTP in `'pause'` is delivered and ignored, not "never delivered".** Raw mode stops the tty from
generating one; an external `kill -TSTP` still arrives. Revision 1's claim that it could not be
delivered was wrong. Ignoring is the same choice the palette makes and for the same reason: the pause
holds raw mode and a hint row, and self-stopping with `raise('SIGSTOP')` would hand the user's shell a
raw tty with a stranded row. Ctrl-Z from the keyboard is the `0x1a` byte and is handled by §5.6, which
drops raw mode first.

**`quitRequested` is now read once, as the first statement of the pause** (step 1 of §5.5), before
anything is armed or written. With the table above, nothing sets `quitRequested` during `'pause'` — a
SIGTERM there either exits or is swallowed as a relay — so no second check is needed and the ordering
question the Critic raises in B2 dissolves rather than being answered: there is no window in which the
flag can be set after it has been read. The flag's remaining job is what it was written for: a SIGTERM
that landed during a *child*, including during the terminal reset, the report read and the footer,
which are all still `'child'`.

**The pre-palette gap is unchanged.** Revision 1 claimed this placement was "strictly better than
today's cooked-tty gap". It is not: §5.7 drops raw mode before resolving `'palette'`, and the
top-of-loop assignment stays, so the sequence into the palette is exactly today's — cooked tty, phase
`'palette'`, Ink mounts some milliseconds later. What the drain narrows is the *mashed-Ctrl-C byte*
exposure, from "until Ink mounts" to "until the drain ends". That is the whole of the improvement.

**One microtask of overlap on the way out, stated so it is not rediscovered.** Between the settle
dropping raw mode and the top-of-loop assignment back to `'palette'` there is a microtask in which the
tty is cooked while the phase still reads `'pause'`, so a Ctrl-C landing there is swallowed rather than
quitting. One microtask wide, and the mild direction of the error. No fix.

**Hint on a signal exit.** The signal seam's reset — the `resetTerminal` member of the `signals`
object literal, whose closure runs `run-session.ts:444-448` and delegates to
`reset-terminal.ts:73-81` — emits DECSC, DECSTBM reset, DECRC, `\r`, SGR, cursor show and autowrap,
and no line erase; SIGHUP exits 129 with no reset at all. So without a change the hint row survives a
signal exit and the shell prompt draws at column 0 with the hint's tail still to its right — a
principle 1 violation introduced by this change.

**Decision: emit `\r\x1b[2K` from that closure, and only when `getPhase() === 'pause'`.** `write` is in
scope there (declared at `run-session.ts:417`, the seam at `:423`), so this is one conditional in a
closure that already holds `getPhase`; the erase runs before `resolved.resetTerminal({ entersAltScreen:
false })`. It is never added to the post-child reset (the default at `run-session.ts:411-415`), which
must not erase the child's last output line.

Revision 2 made this erase unconditional and overrode the Critic's scope objection with the claim that
the mid-palette side effect — erasing a stranded Ink frame — was "an improvement in the same
direction". That claim is false and is withdrawn. `\x1b[2K` is erase-in-line: it clears one row, and a
palette frame is multi-row by construction (`palette-window.ts:63` budgets `CHROME_ROWS = 6`, and the
module exists to hold the frame under the terminal's row count, `:13-15`). An unconditional erase would
blank one row of a stranded six-plus-row frame and leave the rest, which is worse than the clean
stranded frame that path tolerates today. Phase-scoping satisfies the Critic's objection instead of
overriding it: the corpse this change creates is removed, and the pre-existing mid-palette path is
untouched. Both reviewers converged on this form over either of their original positions.

SIGHUP still exits 129 with no reset and no erase; the terminal is gone, so there is nothing to clean.
Note that it therefore also leaves raw mode armed — identical to today's exposure at the palette, where
Ink's raw mode is likewise never dropped on that path. Pre-existing, not introduced here, and criterion
11 is a claim about the exit code only, not about terminal state.

### 5.5 The one arm sequence

Revision 1 gave three mutually exclusive answers for when raw mode is armed. There is one, and every
other section cites it rather than re-describing it:

1. `quitRequested()` → if true, return `'quit'`. Nothing armed, nothing written.
2. `acquireStdin()`
3. `setRawMode(true)`
4. `resume()` if paused
5. attach the **discard** listener
6. `ctx.armed()` → phase becomes `'pause'`
7. wait `PAUSE_DRAIN_MS`, discarding every chunk
8. swap the discard listener for the classifying one; write the hint
9. await a classified key

**Steps 1-6 are one synchronous statement sequence. No `await` is permitted inside them.** Node
dispatches signal handlers and data events between event-loop turns, so a synchronous block has no
window at all: there is no instant at which the phase is `'pause'` while the tty is still cooked, and
none at which stdin is armed but unref'd. Two statements separated by an `await` would have both.

Step 2 is not optional and is the defect revision 1 shipped. `resume()` does not re-ref a handle that
was explicitly unref'd, and `boot.tsx:108` leaves stdin unref'd and paused after every Ink teardown.
Measured on a pty by both reviewers: arming exactly as revision 1 described, with a pending promise,
drains the loop and **exits with status 0 after ~55 ms** — the Architect's probe reported 13, the
Critic's re-measurement reported 0, and 0 is worse, because a shell vanishing with status 0 is
indistinguishable from a deliberate quit. The same probe with the ref added survives. `acquireStdin`
(`src/lib/prompts/stdin-ref.ts:51-55`) is the only sanctioned way to take it; the pause never touches
`process.stdin.ref` directly.

Flipping the phase at step 6 rather than after the drain (which is what the Critic's recommended
ordering does) is deliberate: it is what makes the drain window signal-correct. Inside the drain we
want SIGINT swallowed, SIGTSTP ignored rather than self-stopping, and SIGTERM answered — and all three
are properties of `'pause'`, not of `'child'`.

### 5.6 The Ctrl-C-mash hazard

After `dev` exits, the kernel tty buffer can still hold `0x03` bytes the user aimed at the child. Armed
naively, the pause would read the first one as "quit" and end the session — a regression on the most
common flow in the shell.

Mitigation: the drain window at step 7. Every byte received for `PAUSE_DRAIN_MS` (150 ms) is discarded.
The signal half of the same hazard is handled by the `'pause'` SIGINT row in §5.4.

**The palette has the same byte exposure today** — Ink arms raw mode and `0x03` quits — so this is a
pre-existing hazard the pause inherits and narrows. It does not claim to make the shell immune to a
Ctrl-C pressed 200 ms after the child died.

`PAUSE_DRAIN_MS` must carry a comment stating what it costs when wrong, in the style of
`PNPM_RELAY_WINDOW_MS`: too short and a stale Ctrl-C quits the session; too long and a deliberate
keypress is swallowed. The mild direction is longer. (Revision 1 stated that direction while the drain
still self-stopped on SIGTSTP, which made lengthening it actively harmful; with §5.4's phase table the
stated direction is sound again.)

Rejected alternative: a quit-key ignore list for the first N ms. It drops a deliberate fast Esc, which
is worse than dropping a stale one.

### 5.7 Suspend at the pause (Ctrl-Z)

On `0x1a`, in this order:

1. `disarmPause()` — erase the hint (`\r` + `\x1b[2K`), detach the listener, `setRawMode(false)`,
   `stdin.pause()`, `releaseStdin()`
2. `suspendForeground()` → `kill(0, 'SIGSTOP')`; JS halts here and resumes on `fg`
3. `armPause()` — `acquireStdin()`, `resume()`, `setRawMode(true)`, re-attach the classifying listener
4. re-format the hint from a **fresh `columns()` read** and write `\r\n` followed by it

**`disarmPause` is NOT the once-only settle helper of §5.8** (Critic R1). The two are the same five
operations in nearly the same order, so an implementer will be tempted to share one function — and if
they share the settle's once-only guard, the guard is spent at the first suspend and every later exit
becomes a no-op: raw mode stays armed, the listener stays attached, stdin stays ref'd. On `'quit'` that
is exactly the hang §5.8 step 5 exists to prevent; on `'palette'` the Ink palette would boot on top of
a raw, ref'd, flowing stdin. So there are two named helpers: `disarmPause` is **repeatable** and paired
with `armPause`, and `settle` is **once-only** and calls `disarmPause` (§5.8). §7 pins the distinction
with a suspend-then-resume-then-quit test, which is the sequence a shared helper silently breaks.

**Steps 1-3 are one synchronous statement sequence; no `await` is permitted between them.** Step 1
releases the last stdin reader and therefore unrefs the handle; step 3 re-acquires it. This is safe
only because `process.kill` is synchronous and no event-loop turn occurs while the process is stopped.
Insert an `await` anywhere in that window — a logging seam, a "flush before suspend" write that returns
a promise — and the loop drains with nothing ref'd and node exits, which is the exit-0 defect of §5.5
in a second location. Stated in the module doc and pinned by a unit test.

**Step 4 re-formats the hint; it never reuses the string built at §5.5 step 8.** The user may have
resized while the job was stopped, and `columns` is a function on `RunSessionDeps` for exactly this
reason — its doc (`run-session.ts:73-82`) transfers verbatim: a width "snapshotted at boot goes stale
the moment they resize the window ... it would overrun the new margin and wrap across rows — the exact
wall-of-text this framing exists to prevent". A stale string on a narrowed terminal wraps to two rows
and the next erase clears one of them, which is the corpse failure arriving through the door §6
scenario 3 was watching. (A resize while the pause is *open*, rather than while it is stopped, is the
accepted non-goal in §5.3 — here the hint is being rewritten anyway, so the fresh read is free.)

**Step 4's leading `\r\n` is load-bearing.** Every other hint write lands on a row the pause itself
opened — the blank row the footer's `\n` created. The post-resume write does not: between the
`SIGSTOP` and the `fg` the user was in their own shell, got a prompt, possibly ran commands and
possibly resized, so the cursor is at an unknown column on a row the *shell* owns. Writing a bare hint
there overwrites the shell's output, and the next `\r\x1b[2K` would then erase a row the pause never
created. A leading `\r\n` restores the invariant: the hint always occupies a fresh row the pause
opened, so the erase only ever wipes its own. The `\r` is explicit because raw mode clears ONLCR, so a
bare `\n` moves down while keeping the column. The cost is one row break after `fg`, which the shell's
own output has already made unavoidable.

Rejected: not rewriting the hint at all (the user returns to a terminal with no indication a keypress
is expected, breaking the arming-indicator property), and re-emitting the footer plus hint as a fresh
block (it duplicates a committed transcript line, which principle 1 forbids).

The pause does **not** resolve on Ctrl-Z — the same pause is still there on return, exactly as the
palette redraws itself with its filter intact.

**`suspendForeground` moves to the session layer, and its contract moves with it.** Three of its
doc paragraphs describe properties Ink used to guarantee and the pause must now guarantee itself. They
are rewritten as explicit preconditions on the caller:

- *raw mode is dropped before the stop* — satisfied by `disarmPause` at step 1.
- *the cursor is visible* — satisfied, but by construction rather than by anything the pause does:
  nothing here hides it, and `resetTerminal` showed it in `runOne`'s `finally` before the footer was
  ever written. The doc must say the caller owes this, not that Ink provides it. (Same for criterion 5,
  which is true for the same reason.)
- *the cursor is at column 0* — satisfied by step 1's erase. This is why `suspend.ts:59-61` does no
  newline work of its own, and the reason must be re-attributed to the new caller.
- *`fg` only* — inherited verbatim and now owned by the pause. Resumed with `bg` or a bare
  `kill -CONT`, step 3's `setRawMode(true)` is a `tcsetattr` from a background process group, which
  raises SIGTTOU and stops the job again, silently. Same as vim, same as Ink today.

Both reviewers confirm there is no new SIGCONT ordering concern for `fg`: bash and zsh `tcsetpgrp` the
job's pgid before sending SIGCONT, so the group is already in the foreground when execution resumes,
and the termios zsh snapshotted at stop time is the cooked one step 1 left behind.

### 5.8 The clean-exit path

`settle` is the once-only helper, and its whole body is a call to `disarmPause`:

1. erase the hint (`\r` + `\x1b[2K`)
2. detach the listener
3. `setRawMode(false)`, guarded on `isTTY && isRaw` like `reset-terminal.ts:90`
4. `stdin.pause()` — stop reading, so a `stdio: 'inherit'` child can never contend, leaving stdin in
   exactly the state `boot.tsx:108` leaves it in after an Ink teardown, which the palette already
   boots from successfully every iteration
5. `releaseStdin()` — **last**, symmetric with `acquireStdin()` being first in §5.5. The ref must go,
   or node holds the event loop open with nothing listening and the session "quits" into a hang

**`settle` runs in a `finally` wrapped around everything from §5.5 step 2 onward, not only on the two
normal returns.** Revision 2 named `'quit'` and `'palette'` and left a throw unhandled. If anything
between the acquire and the resolved key throws — `setRawMode` on a stream that lost its tty, the
`write` seam, a formatter bug, an injected seam in a test — the pause would exit with raw mode armed,
the listener attached, stdin ref'd and the hint on screen: a terminal that eats the user's keystrokes
and a process that never exits, which is §6 scenario 1's failure in a second location. `runSession`'s
own `finally` only disposes signal handlers, and `runOne`'s `try/catch` covers the spawn, not
`afterRun`. The repo already treats this as non-negotiable for the analogous reader:
`escapable-context.ts:97-104` puts both the listener detach and `releaseStdin()` in a `finally`, whose
comment reads "every exit path (answer, Esc abort, throw) must give the ref back, or node never exits".
§5.5 step 2 makes the pause the second holder of that ref, so it inherits the obligation without
qualification. The throw propagates after the terminal is restored.

This is what makes "at most once" load-bearing rather than incidental: the `'quit'` and `'palette'`
returns and the `finally` can all reach `settle`. It is also why the guard must not be shared with
`disarmPause`, which the suspend path calls once per Ctrl-Z (§5.7).

**Hint write/erase is a balance invariant, not a count.** The suspend path writes the hint twice and
erases it twice, so "written once" is not a specifiable property. The property that actually protects
the scrollback is: *at most one hint write per arming, and every write matched by exactly one erase
before control leaves the pause or the process stops.* That is what §7 asserts.

The one exception, stated rather than hidden: the three signal exits do not run this helper. §5.4
handles them with the phase-scoped `\r\x1b[2K` in the signal reset seam, except SIGHUP, where the
terminal is gone.

### 5.9 The `afterRun` seam

```ts
interface PauseContext {
  /** Flip the signal phase to 'pause'. Idempotent. An implementation that BLOCKS on input must call
   *  this; one that returns synchronously must not. */
  armed: () => void
  /** A SIGTERM that landed during the child, deferred. Read once, before arming. */
  quitRequested: () => boolean
}

afterRun?: (ctx: PauseContext) => Promise<'palette' | 'quit'>
```

The context is built by `runSession` and passed on **every** call, to the default implementation and to
any injected one alike. Closing the signal window is a loop invariant, not a property of one
implementation. Baking the callbacks privately into the default factory — revision 1's shape — would
make an injected implementation silently wrong, and would divorce every unit test from the behaviour it
is meant to pin.

**Name the failure, not just the rule.** An `afterRun` that blocks on input without calling `armed()`
runs the whole pause with the phase still `'child'`: every SIGINT swallowed, and every SIGTERM deferred
into a `quitRequested` flag nobody reads until after a keypress that a `kill` cannot supply — an
unkillable shell. The obligation binds only implementations that block: the non-TTY default (§5.10) and
the `baseDeps` stub (§7) both return synchronously and correctly never arm, which is why the rule is
stated as a conditional rather than as "always call it". `armed()` is idempotent, so a defensive second
call is harmless.

The default implementation also takes an injectable `stdin` seam (defaulting to `process.stdin`,
mirroring `ResetTerminalDeps.stdin` at `reset-terminal.ts:49-50`), so the TTY guard below is testable
without touching the real process.

### 5.10 No opt-out env

Recommend **no** `INFRA_KIT_SESSION_NO_PAUSE`. The pause is a single keypress, it degrades to a no-op
without a TTY, and an env flag would be a second code path nobody exercises.

The one behavioural guard that IS needed: when the injected stdin's `isTTY` is false, the pause
resolves `'palette'` immediately, writes nothing and arms nothing. That matches `sessionGateEnabled`,
which already refuses a non-TTY session. It is **not** the mechanism that keeps existing unit tests
valid — see §7 and Arch 10; those get an explicit `afterRun` instead, so their correctness never
depends on whatever stdin the vitest pool hands the worker.

---

## 6. Pre-mortem

Re-aimed at the design as revised: all three are failures this implementation could still ship.

**Scenario 1 — the shell vanishes with status 0 after every command.**
`acquireStdin()` is dropped from the arm sequence in review, or added after an `await`, or its
`releaseStdin()` partner runs before the `SIGSTOP` without the re-acquire. The event loop drains
~150 ms into the pause and node exits 0, which the user reads as "the shell quits by itself" and which
is indistinguishable from a deliberate quit.
*Detection:* the pty liveness assertion (§7 e2e item 4) is the only test that can see it — every unit
test uses a fake stdin and a fake `write`, and even "the palette did not redraw" passes when the
process is dead. *Mitigation:* §5.5 step 2 and §5.8 step 5 as a symmetric pair, plus the
no-`await` constraint pinned by a unit test on the suspend path.

**Scenario 2 — an external `kill -TSTP` hands the user's shell a raw tty.**
The phase enum is implemented but `'pause'` falls through to the `'child'` branch of `onSigtstp`, so
`raise('SIGSTOP')` stops the group with raw mode armed and a hint row on screen. The user's shell
returns with a terminal that eats their keystrokes.
*Detection:* a unit test on `installSessionSignals` asserting `raise` is not called for SIGTSTP in
`'pause'`; the tmux manual gate for the terminal-state half. *Mitigation:* §5.4's table, and deleting
`childOwnsSigint` outright rather than adding a second predicate beside it, so there is no boolean left
to fall through to.

**Scenario 3 — the post-`fg` hint overwrites and then erases rows the shell owns.**
Step 4 of §5.7 is implemented without the leading `\r\n`, or with a bare `\n`, or by reusing the hint
string built before the suspend. The hint lands mid-row on the user's shell output, or wraps because
the terminal was narrowed while the job was stopped, and the subsequent erase wipes a row the pause
never created — the corpse failure, inverted.
*Detection:* only `tmux capture-pane` can see this, which is why §7 promotes the manual script to a
required gate and runs it at 40 columns; a `script` byte capture shows the same bytes either way.
*Mitigation:* §5.7 step 4 — the leading `\r\n`, the fresh `columns()` read, and the stated invariant
that the hint only ever occupies a row the pause opened.

---

## 7. Test plan

### Unit — `src/lib/session/__tests__/post-run-pause.test.ts` (new)

- `classifyPauseKey` table: `0x03`/`0x04`/`0x1b` → quit; `0x1a` → suspend; `' '`, `'\r'`, `\x1b[A`,
  `\x1bx`, a 4-byte UTF-8 emoji, an empty chunk → continue.
- The arm sequence's order, asserted on a recording fake: acquire, `setRawMode(true)`, resume, listener
  attached, `armed()` — all before the drain timer starts, and with no interleaving await.
- Bytes delivered during the drain are discarded and the pause stays open.
- Hint balance: at most one write per arming, and writes and erases are equal at every exit — asserted
  on the quit path, the palette path, and the suspend-then-key path (which is two of each).
- `'quit'` settle order: erase, detach, `setRawMode(false)`, `pause()`, `releaseStdin()` last.
- **A throw restores the terminal** (Arch N2/O3): a fake `write` that throws on the hint write leaves
  raw mode off, the listener detached and the ref released, and the error propagates. Without this test
  the `finally` is a comment.
- **Suspend, resume, then quit** (Critic R1): raw mode ends off and the ref is released. This is the
  sequence that a `disarmPause`/`settle` sharing one once-only guard silently breaks, and no other test
  in the list would notice.
- Suspend path: calls the injected suspend seam, does not resolve, re-acquires stdin, and the
  post-resume hint write is preceded by `\r\n`.
- **Suspend across a resize** (Arch N3): a `columns` fake returning a smaller number after the suspend
  produces a shorter second hint, proving the string is re-formatted rather than reused.
- Suspend path is one synchronous block: assert the fake's release, stop and acquire are observed in
  the same tick (record a tick counter via `queueMicrotask` in the fake).
- Suspend seam absent (win32): `0x1a` resolves `'palette'` and never calls suspend.
- `quitRequested()` true at entry resolves `'quit'` with nothing armed and nothing written.
- Injected non-TTY stdin resolves `'palette'` synchronously, writes nothing, never arms raw mode.

### Unit — `src/lib/session/__tests__/format-entry.test.ts` (extend)

- Both hint variants, unicode and ascii, and the no-suspend variant.
- `< 80` columns for every variant (mirrors the palette's `HINTS` guard).
- Truncation at a given `width`, asserted in cells not UTF-16 units.
- **`width: undefined` returns the untruncated hint** (Arch 6).
- Dim SGR present under `color: true`, absent under `color: false`.

### Unit — `src/lib/session/__tests__/run-session.test.ts` (extend)

- `baseDeps` gains an explicit `afterRun: async (ctx) => { ctx.armed(); return 'palette' }`. Existing
  tests then never depend on ambient `process.stdin.isTTY`, and the `header()` / `footer()` index
  helpers stay valid because the injected implementation writes nothing.
- `afterRun` is called once per pick, after the footer write and before the next `renderPalette` —
  asserted on the existing `log` array as `render, spawn, afterRun, render`.
- `afterRun` receives a context whose `armed()` flips the phase and whose `quitRequested()` reflects the
  signal owner — asserted with `installSignals` on and a fake `signals`.
- `afterRun` returning `'quit'` ends the loop with no further palette render.
- The `!command` path skips `afterRun` entirely.
- **The signal seam's erase is phase-scoped** (Arch N1): with a fake `write` and a fake `signals`,
  `signals.resetTerminal()` emits `\r\x1b[2K` before the reset when the phase is `'pause'`, and emits
  no erase when it is `'palette'` or `'child'`. This is the test that stops the erase being widened
  back into the palette's SIGINT path.

### Unit — `src/lib/session/__tests__/session-signals.test.ts` (rewrite for the phase getter)

The whole file moves from `isChildRunning: boolean` to `getPhase()`. New matrix coverage, one test per
non-obvious cell of §5.4's table:
- SIGINT in `'pause'` is swallowed and records nothing.
- SIGTERM in `'pause'` inside the relay window is swallowed; outside it, resets and exits 0 immediately
  and does **not** set `quitRequested`.
- SIGTSTP in `'pause'` does not call `raise`.
- SIGTSTP in `'child'` still calls `raise('SIGSTOP')` (unchanged).
- SIGHUP exits 129 in all three phases.

### Unit — `src/lib/session/__tests__/suspend-foreground.test.ts` (moved)

The existing `src/tui/__tests__/suspend.test.ts`, moved with the module. No behaviour change.

### e2e (pty) — `src/entry/__tests__/post-run-pause-pty.test.ts` (new, darwin-only)

Built with the real `buildOptions` inside the package, driven through `cat | script -q /dev/null`, using
the harness shape of `quit-keys-pty.test.ts`. Only claims a byte stream can actually carry:

1. **The palette does not redraw** — as a *suffix* assertion, not an occurrence count. Record the
   capture length once the footer appears, then assert `Enter run` does not appear in anything captured
   after that mark for 1 s. Counting is unsound here twice over: `Enter run` is already in the capture
   because reaching the pause requires selecting from the palette (`quit-keys-pty.test.ts:135-138`
   gates on exactly that substring), and Ink repaints its frame on every keystroke and resize, so the
   count is not stable.
2. **A space redraws the palette** — `Enter run` appears after the mark once a `' '` is written.
3. **Esc at the pause exits 0** — the existing `SENTINEL` echo mechanism.
4. **Liveness: the process is paused, not dead** — assert `SENTINEL` does *not* appear while the pause
   is open. This is the only end-to-end check that distinguishes the two, and the only test in this
   plan that can catch scenario 1.
5. **Ordering invariant** — the erase sequence `\r\x1b[2K` follows the hint bytes with nothing between
   them. Provable on a byte stream, catches an ordering regression, and claims nothing about the screen.

Register the file in the `qa:pty` script (`package.json:33`, which names its suites explicitly, so this
is a one-string edit) with the same `INFRA_KIT_REQUIRE_PTY=1` gate.

### Observability — `scripts/qa/post-run-pause-pty.sh` (new, manual, **required gate**)

Modelled on `scripts/qa/suspend-pty.sh`, whose header (`:5-16`) already explains why a claim about the
rendered screen cannot live in a vitest file. Promoted from "nice to have" to a required gate, because
after the corrections above it is the **only** place two acceptance criteria can be proven at all:
that the hint is erased rather than merely followed by an erase sequence, and that it never wraps.

Runs the built bundle under `tmux new-session -x 40` (the narrow-terminal lever; `COLUMNS=40` is inert
because node reads the width from the pty winsize — measured, `script -q /dev/null env COLUMNS=40`
reports `cols=0`; `stty cols 40` inside the pty is the alternative). Sends Enter, then `0x1a`, then
`fg`, capturing the pane at each step to confirm: the hint occupies exactly one row at 40 columns; it
is gone from the pane after the palette draws; the shell reclaimed the tty and printed a prompt after
the stop; and after `fg` the hint is back on a fresh row with the transcript above it intact. One extra
step for N3: narrow the window with `tmux resize-window -x 30` **while the job is stopped**, then `fg`,
and confirm the redrawn hint is one row at the new width. That is what makes the `fg` step prove the
fresh `columns()` read rather than merely exercising it. Output pasted into the PR.

---

## 8. Implementation steps

1. **Move the suspend primitive.** `src/tui/suspend.ts` → `src/lib/session/suspend-foreground.ts`;
   move `src/tui/__tests__/suspend.test.ts` → `src/lib/session/__tests__/suspend-foreground.test.ts`;
   update the single import in `src/tui/boot.tsx`; export from `src/lib/session/index.ts`. Rewrite the
   three doc paragraphs listed in §5.7 as caller preconditions.
   **The justification is layering, not lint.** Revision 1 claimed the eslint `no-restricted-imports`
   rule and `no-react-boundary.test.ts` forbid `src/lib/session` importing `src/tui`. Neither does:
   `MACHINE_PATH_GLOBS` (`eslint.config.js:9-19`) is a five-glob allowlist and
   `MACHINE_PATH_FILES` (`no-react-boundary.test.ts:18-28`) a nine-file one, and no session file
   appears in either. A static import would lint clean today and would not even drag React in, since
   `suspend.ts` imports only `node:process`. The real reason to move it is that the eager chunk must
   not depend on the lazy one even where a particular leaf happens to be React-free.
2. **Make that boundary real** (Architect optional 1, adopted). Add `src/lib/session/**/*.ts` to
   `MACHINE_PATH_GLOBS`. Named out loud as a boundary fix carried along, not part of the user's ask:
   it is two lines, it makes step 1's invariant enforced instead of asserted, and `noRawStdinReaders`
   already `ignores: MACHINE_PATH_GLOBS` (`eslint.config.js:98`) so the two objects stay disjoint.
   Heed the config's own warning at `:52-56` that flat config replaces rule options when two objects
   match — the glob goes in the `noTuiOnMachinePaths` list. `config-boundaries.test.ts` pins the
   resolved config, so the change is verifiable.
3. **Add the hint formatter.** In `format-entry.ts`: a dedicated copy const (not `T`), the widened file
   doc, and `formatPauseHint({ canSuspend, ascii, color, width })` with the explicit `width == null`
   branch.
4. **Replace the boolean with the phase.** In `run-session.ts`: `SessionPhase`, `installSessionSignals`
   taking `getPhase`, the four handlers rewritten against §5.4's table, `childOwnsSigint` deleted, and
   `markChildOwnsSigint` renamed to reflect that it sets a phase. Add the phase-scoped `\r\x1b[2K` to
   **the `resetTerminal` member of the `signals` object literal — the closure at
   `run-session.ts:444-448`**, whose body is `resolved.resetTerminal({ entersAltScreen: false })` at
   `:447`. Do not confuse it with its nearest neighbour, the post-child `resetTerminal` default at
   `:411-415`; an erase there would wipe the child's last output line. Revision 2 cited `:434-441` for
   this seam, which lands on the `raise` and `now` members and contains no reset at all.
5. **Add the pause module.** New `src/lib/session/post-run-pause.ts` exporting `classifyPauseKey`,
   `PauseKey`, `PostRunPauseDeps` and `awaitPostRunKey`. Keep `awaitPostRunKey` under the complexity
   ceiling by hoisting `armPause`, `disarmPause` and `settle` to module scope — the technique
   `CommandPalette` uses for `handleCtrlKey` and `hintFor`, and for the same reason. `disarmPause` is
   repeatable and `settle` is once-only and calls it; they must not share the guard (§5.7). No
   counter-style loops; the drain is a `setTimeout`, not an iteration. `settle` is invoked from a
   `finally` around everything after the acquire. Module doc carries: the ref keeps node alive across
   the pause (citing `stdin-ref.ts:6-19`), the no-`await` constraint on §5.5 steps 1-6 and on the
   suspend block, the `fg`-only caveat, and the resize non-goal (§5.3).
6. **Wire the seam.** Add `afterRun?: (ctx: PauseContext) => Promise<'palette' | 'quit'>` to
   `RunSessionDeps`; build the context in `runSession` and pass it on every call; call `afterRun` at
   the end of the loop body and `return` on `'quit'`.
7. **Export** `awaitPostRunKey`, `classifyPauseKey`, `formatPauseHint`, `SessionPhase` and
   `suspendForeground` from `src/lib/session/index.ts`.
8. **Tests**, in §7's order: unit first, then the pty suite, then the manual script.
9. **Register** the new pty file in `qa:pty`.
10. **Gate**: full `pnpm run qa`, `pnpm run qa:pty` on darwin, and `scripts/qa/post-run-pause-pty.sh`
    output pasted into the PR.

Estimated diff: one moved file, five edited files, one new source module, one new pty test, one new
shell script, plus test extensions. Roughly 250 new source lines excluding tests and comments. The
`session-signals.test.ts` rewrite is mechanical but touches the whole file.

**MCP check, recorded so it is not re-derived:** `src/entry/mcp.ts` does not import
`src/lib/session/**` (only `entry/cli.ts` does, at `cli.ts:20-21`) and the new module has no
module-scope side effects, so the "same handlers must never run inside the long-lived MCP server"
house rule is satisfied without a guard.

---

## 9. Acceptance criteria

1. After a command finishes in the session shell, the palette does not redraw until the user presses a
   key.
2. A dim single-row hint appears under the status footer, never wider than the terminal, naming: any
   key for the command list, Esc / Ctrl-C to quit, and Ctrl-Z to suspend where suspending is possible.
3. Every hint write is matched by exactly one erase before control leaves the pause; the scrollback
   after a run contains the header, the child's output and the footer, and no hint text — **absent a
   terminal resize while the pause is open**, which is a documented non-goal (§5.3) and can strand one
   reflowed row.
4. Space, Enter, an arrow key, a pasted string and a multi-byte character all return to the palette.
5. Esc, Ctrl-C and Ctrl-D each end the session, restore a cooked tty, and cause node to actually exit
   with status 0 — proven on a pty, not in-process. The cursor is visible on exit, which holds by
   construction rather than by anything the settle does: nothing in the pause hides it and
   `resetTerminal` showed it in `runOne`'s `finally` before the footer.
6. The session shell stays alive for as long as the pause is open: the sentinel does not appear while
   the pause is waiting.
7. Ctrl-Z suspends the job so the user's shell reclaims the tty and prints a prompt; `fg` returns to the
   same pause with the hint redrawn on a fresh row, sized to the terminal's width **as it is on
   resume**, and the transcript above it intact.
8. Stopping `dev` with a burst of Ctrl-C lands at the pause, not at a quit and not at a redrawn palette.
9. An external `kill -TERM` during the pause ends the session promptly, **except** within the
   documented `PNPM_RELAY_WINDOW_MS` following a Ctrl-C, where it is swallowed as pnpm's relay exactly
   as it is during a child. That exception is **bounded**: the window is measured from the last SIGINT
   delivered while a child was running, nothing that happens at the pause can extend it, and the first
   SIGTERM after it is honoured. (Revision 1's unqualified version of this criterion was unachievable
   against the existing relay rule.)
10. An external `kill -TSTP` during the pause is ignored: the process keeps running and the terminal
    stays raw-mode-owned by the pause, never handed to the shell in raw mode.
11. `SIGHUP` during the pause still exits 129. This is a claim about the exit code only, not about
    terminal state: that path performs no reset and leaves raw mode armed, which is identical to
    today's exposure at the palette and is not introduced here.
12. On a non-TTY stdin the pause is a no-op that writes nothing and arms nothing.
13. Every existing `run-session` unit test passes with an explicitly injected `afterRun`, so no test's
    correctness depends on the ambient TTY of the vitest worker.
14. `pnpm run qa` is green, including sonarjs cognitive complexity ≤ 15 on every touched function;
    `pnpm run qa:pty` is green on darwin; and the tmux manual gate's output is attached.

---

## 10. Open questions for the user — ANSWERED 2026-09-05

**Q1 → (a) any key returns to the palette. Q2 → Ctrl-Z suspends (module move in §8 steps 1-2 stays).**

**Q1 — "reopen the command and run it again": palette, or re-run the same command?**
The Ukrainian phrasing supports both readings. *Recommended default: any key returns to the palette
(reading (a)).* It matches "the command list" in the same sentence, it is the only reading that keeps
one key doing one thing, and re-running is then two keys instead of one. A dedicated re-run key is a
clean follow-up: one entry in the classifier's byte map and one clause in the hint.

**Q2 — Ctrl-Z at the pause: suspend, or quit?**
The request listed Ctrl-Z among the exit keys, but in the palette Ctrl-Z means suspend.
*Recommended default: Ctrl-Z suspends.* Making it quit would give the same key two different meanings
one keystroke apart in the same shell, and a user who presses Ctrl-Z at the pause almost certainly
wants their shell back temporarily, not the session gone.

This is not simply the inverse of §5.2's argument for Esc. Esc changes meaning between the two screens
because the thing it pops changes: in the palette there is a filter to clear, at the pause there is
nothing but the session itself. Ctrl-Z has no such difference — the job is equally suspendable in both
places, so a second meaning would be arbitrary rather than contextual.

If you prefer quit, the change is one entry in `SINGLE_BYTE`, one hint string, and steps 1 and 2 of §8
(the module move and the boundary fix) become unnecessary — a meaningfully smaller diff, so this is
worth an explicit answer.

---

## 11. ADR — post-run keypress pause in the session shell

**Decision.** Insert a blocking single-keypress pause between the transcript footer and the next palette
draw, implemented React-free in `src/lib/session/post-run-pause.ts` and injected into `runSession`
through an `afterRun` seam that carries the signal-phase context. Any key returns to the palette; Esc,
Ctrl-C and Ctrl-D end the session; Ctrl-Z suspends the job. `installSessionSignals` gains a three-value
phase in place of its `isChildRunning` predicate.

**Drivers.** Scrollback fidelity; signal safety around a mashed Ctrl-C at `dev`; the palette
component's exhausted complexity budget.

**Alternatives considered.** (B) An Ink screen in `src/tui/`, rejected for the per-command mount cost,
the split of the feature across two chunks, and the loss of a pure-function classifier — not, as
revision 1 argued, for frame-erase risk or an async signal contract, both of which were overstated.
(C) Compacting the palette, rejected as not answering the request. (D) A cooked-mode "press Enter",
rejected as a worse interaction but recorded as the named rollback, since it removes every hazard in §6
at once.

**Why chosen.** The loop, the transcript writes and the signal state already live in one module, so the
pause belongs where the state is. The corollary, learned from this review round, is that "React-free"
buys nothing if the terminal primitives are re-derived instead of reused: the two defects revision 1
would have shipped were both a hand-rolled version of something the repo already had.

**Consequences.**
- `src/lib/session` gains raw-mode handling and therefore a real terminal contract, which means a third
  pty suite and a second manual pty script — the latter a required gate, because two acceptance
  criteria are not provable anywhere else.
- `installSessionSignals`'s signature changes, so `session-signals.test.ts` is rewritten. The phase
  model is the honest one and pays for itself immediately: SIGTSTP and SIGTERM need different answers
  in the pause than in a child.
- `suspendForeground` moves out of `src/tui/`, and `src/lib/session/**` joins `MACHINE_PATH_GLOBS` so
  the layering it assumes becomes enforced rather than asserted.
- The mashed-Ctrl-C byte exposure narrows from "until Ink mounts" to "until the drain ends". The
  pre-palette cooked-tty gap is **unchanged** — revision 1 claimed an improvement there that its own
  design does not deliver.
- The signal reset seam gains a `\r\x1b[2K` **scoped to the `'pause'` phase**. Revision 2 made it
  unconditional on the argument that it would also tidy a stranded Ink frame; that argument was false
  (`\x1b[2K` clears one row, and a palette frame is six-plus rows by construction) and is withdrawn.
  Scoping removes the corpse this change creates and leaves the pre-existing mid-palette path untouched.
- One new timing constant (`PAUSE_DRAIN_MS = 150`), documented like `PNPM_RELAY_WINDOW_MS` with the
  cost of being wrong in each direction.
- A terminal resize while the pause is open can strand one reflowed hint row. Accepted as a documented
  non-goal (§5.3), on the precedent that `safe-stderr.ts:14-17` already rejects resize-time geometry
  reasoning one layer down. Criterion 3 is narrowed to match rather than asserting more than the design
  delivers.
- The pause **incidentally narrows a pre-existing defect**: today a pnpm relay landing just after the
  loop clears `childOwnsSigint` can kill the session on an ordinary Ctrl-C at a fast child, and the
  pause now occupies that window and answers it with the relay test. The `'palette'` phase still carries
  the exposure, behind a keypress. Not fixed here; recorded in §5.4.

**Follow-ups (not in scope).**
- A dedicated re-run key at the pause, if Q1 is answered the other way.
- Verify the util-linux `script -qec` spelling so the pty suites can run on Linux CI, retiring the "CI
  never runs this" caveat now carried by three files. The Architect suggests doing it here to stop a
  third copy; declined, because it needs a real ubuntu-arm box to verify and this change already
  carries two gates. The caveat is copied once more, knowingly.
- A `SIGWINCH` redraw for the hint, if the accepted resize non-goal (§5.3) turns out to bite in use.
- The `'palette'`-phase relay exposure recorded in §5.4, which predates this change.

---

## Appendix — disposition of the re-review's optional and non-blocking items

The five required changes from the Architect's first review and the Critic's B1-B7 are dispositioned in
the body; both reviewers report them closed. This table covers only what iteration 3 added.

| Item | Disposition |
| --- | --- |
| Arch N1 — phase-scope the erase, false override rationale | Adopted. §5.4, §7 (`run-session.test.ts`), §8 step 4, ADR consequence. |
| Arch N2 — settle must run in a `finally` | Adopted. §5.8, plus the throw test in §7. |
| Arch N3 — re-format the post-`fg` hint from a fresh `columns()` | Adopted. §5.7 step 4, §7 resize unit test, tmux gate's `resize-window` step. |
| Arch N4 — inverted `lastSigintAt` rationale | Adopted, and it is the load-bearing correction: the replacement argument is what bounds the relay divergence. §5.4, criterion 9. |
| Arch N5 — citation drift | Adopted. Every anchor in this revision was re-verified against the source, not copied from the reviews: the signal seam is `run-session.ts:444-448` (not `:434-441`), the width precedent is `ruleSuffix` at `format-entry.ts:189-203` with the guard at `:195` (not `formatTranscriptEntry`), the relay test is `:316-319`, and `childStarted` is `:350-352`, called at `:512`. |
| Arch O1 — record the `'palette'`-phase relay exposure | Adopted. §5.4 and an ADR consequence. |
| Arch O2 — state the killability bound in one place | Adopted. Folded into N4's paragraph and criterion 9; they are the same sentence from two sides. |
| Arch O3 — add the throw test explicitly | Adopted. §7, named as the test without which N2's `finally` is a comment. |
| Arch O4 — say what happens if `armed()` is never called | Adopted **with the Critic's carve-out**: the obligation binds implementations that block, not the non-TTY default that returns synchronously, which would otherwise read as violating its own rule. §5.9. |
| Critic R1 — `disarmPause` and `settle` must not share the once-only guard | Adopted. §5.7, §5.8, §8 step 5, and the suspend-resume-quit unit test. |
| Critic R2 — resize while the pause is open | **Accepted as a documented non-goal**, of the three options offered. No fixed width survives an arbitrary narrowing, and a `SIGWINCH` redraw repeats the mistake `safe-stderr.ts:14-17` records one layer down. Criterion 3 narrowed rather than left overstated. §5.3. |
| Critic non-blocking 1 — missing `\r` in §5.4's erase | Adopted. §5.4 now says `\r\x1b[2K`, matching §5.3, §7 and N1. |
| Critic non-blocking 2 — O4's carve-out | Adopted, see Arch O4 above. |
| Critic non-blocking 3 — SIGHUP leaves raw mode armed | Recorded, no change. Pre-existing and identical at the palette; criterion 11 now says it is about the exit code only. |
| Critic non-blocking 4 — AC 5's cursor is true by construction | Adopted. Criterion 5 and the `suspendForeground` precondition list both attribute it to `runOne`'s `finally` rather than to the settle. |

---

## Appendix B — implementation deviations (2026-09-05, recorded after the tmux gate)

Three findings from `scripts/qa/post-run-pause-pty.sh` changed the shipped code relative to §5:

1. **Chunks are strings, not bytes.** Ink calls `setEncoding('utf8')` on every raw-mode arm and never
   clears it, so the pause's `data` listener receives one-character strings. `classifyPauseKey` accepts
   `Uint8Array | string` and classifies on the first code unit; the length-1 rule is unchanged.
2. **`disarmPause` does NOT call `stdin.pause()`** (§5.8 step 4 withdrawn). In flowing (`data`) mode,
   `pause()` stops the libuv read while the stream's `reading` flag stays true; Ink's `readable`
   listener only restarts the read when that flag is false, so the ref'd-but-stopped handle held nothing
   and node exited 0 after every palette redraw. The listener is detached and stdin left flowing with no
   consumer; the next reader (Ink) takes it over, and `boot.tsx`'s post-teardown `pause()` still fences
   the child. Cost: a few-millisecond window in which a keystroke between the pause and Ink's mount is
   dropped. A `readable`-mode reader would close it; deferred.
3. **The post-`fg` width needs an ioctl.** A stopped job is not in the foreground group, so a resize
   between Ctrl-Z and `fg` never reaches it and `stderr.columns` stays cached. `stderrColumns()` calls
   `stderr._refreshSize()` behind a `typeof` guard before reading. §5.7's "re-reading costs nothing" is
   true only with this call.

Evidence: `.omc/state/sessions/<id>/evidence/{post-run-pause-pty.log,SUMMARY.md,second-cycle.log}`.
