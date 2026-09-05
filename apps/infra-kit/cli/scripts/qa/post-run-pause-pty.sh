#!/usr/bin/env bash
#
# The post-run pause — rendered-screen verification on a REAL pty.
#
# LOCAL-ONLY MANUAL GATE, and a REQUIRED one (plan §7 "Observability"). Like its sibling
# `suspend-pty.sh` it is deliberately not wired into `pnpm run qa` and deliberately not a vitest file:
#
#   * `qa` has no build step, and the thing under test is the BUNDLE (dist/cli.js), not the sources.
#   * CI runs on ubuntu-24.04-arm, which has no tmux and no prebuilt arm64 node-pty.
#   * A `describe.skipIf(!tmux)` vitest file would SKIP silently in CI and read as coverage.
#
# But this script also proves two things NO other layer can. The byte-level pty suite
# (`src/entry/__tests__/post-run-pause-pty.test.ts`) sees a stream, not a screen: it can prove that an
# erase sequence FOLLOWS the hint bytes, never that the hint is actually GONE from the rendered pane,
# and it cannot see wrapping at all because a wrapped row is two rows on screen and one run of bytes on
# the wire. Only a pane capture settles both:
#
#   * the hint occupies EXACTLY ONE row at 40 columns (it is 48 columns untruncated, so an unbounded
#     write would wrap to two rows and the single-row erase would leave a dim corpse behind);
#   * it is GONE from the pane after the palette draws, and gone after the stop;
#   * after `fg` it is back on a FRESH row at the NEW width — which is what proves the fresh
#     `columns()` read of plan §5.7 step 4 rather than merely exercising it.
#
# The 40-column window is the narrow-terminal lever. `COLUMNS=40` is inert: node reads the width from
# the pty winsize, and measured, `script -q /dev/null env COLUMNS=40 node -e '…stderr.columns'` reports
# 0, which `stderrColumns` maps to `undefined` (no truncation at all).
#
# Usage:  ./scripts/qa/post-run-pause-pty.sh
#
set -euo pipefail

cd "$(dirname "$0")/../.."

SESSION="ikp-pause-$$"

echo "==> Building the bundle (dist/cli.js is the artifact under test)"
pnpm run build >/dev/null

CLI="$PWD/dist/cli.js"
test -f "$CLI" || { echo "FAIL: $CLI missing after build"; exit 1; }

command -v tmux >/dev/null || { echo "FAIL: tmux not installed — brew install tmux"; exit 1; }
echo "==> tmux: $(tmux -V) at $(command -v tmux)"
echo "==> node: $(node -v)"

cleanup() { tmux kill-session -t "$SESSION" 2>/dev/null || true; }
trap cleanup EXIT

# The CI markers MUST be scrubbed. Ink resolves `interactive` as `!isInCi && stdout.isTTY`, and
# `is-in-ci` reads these four. With any of them set the palette flips to non-interactive, and the
# session shell under test is a different program. INFRA_KIT_SESSION is scrubbed for the same reason
# suspend-pty.sh scrubs it: it keys per-terminal caches, and a stale one changes what the shell boots.
SCRUB=(env -u CI -u CONTINUOUS_INTEGRATION -u BUILD_NUMBER -u RUN_ID -u INFRA_KIT_SESSION)

# Pane analysis. `capture-pane -p` strips SGR, so the dim hint arrives as plain text and a substring
# match is sound. Three numbers come out of it:
#
#   HINT_ROWS      — rows whose text starts the hint. The assertion is 1 while the pause is open and 0
#                    everywhere else. A count is the only way to see an un-erased corpse.
#   cells          — code points on that row. `capture-pane` TRIMS trailing spaces (and `-N` pads every
#                    row out to the pane width instead, so it cannot measure content either), so the
#                    formatter's `width - 1` truncation reads back one short whenever the cut lands on a
#                    space: 39 cells at 40 columns present as 38, and 29 at 30 columns present as 29.
#   AFTER          — the row directly below the hint, quoted. This is the wrap check. A wrapped hint is
#                    still ONE matching row plus a continuation row, so HINT_ROWS alone cannot see it;
#                    the continuation would show up here as the tail of the hint text. `-J` is
#                    deliberately NOT passed — joining wrapped rows would hide the very thing under test.
analyze() {
  node -e '
    let s = ""
    process.stdin.on("data", (d) => (s += d))
    process.stdin.on("end", () => {
      const lines = s.replace(/\n+$/, "").split("\n")
      const pick = (re) => lines.map((l, i) => [i, l]).filter(([, l]) => re.test(l))
      const hint = pick(/any key commands/)
      const palette = pick(/❯|Enter run/)
      console.log("    HINT_ROWS=" + hint.length + "  PALETTE_ROWS=" + palette.length)
      for (const [i, l] of hint) {
        console.log("    HINT[row " + i + "] cells=" + [...l].length + " " + JSON.stringify(l))
        console.log("    AFTER[row " + (i + 1) + "] " + JSON.stringify(lines[i + 1] ?? "<end of pane>"))
      }
      for (const [i, l] of palette) {
        console.log("    PALETTE[row " + i + "] " + JSON.stringify(l))
      }
    })
  '
}

capture() {
  local label="$1" expect="$2" scroll="${3:-}"
  local pane
  if [ -n "$scroll" ]; then
    pane=$(tmux capture-pane -p -S -60 -t "$SESSION")
  else
    pane=$(tmux capture-pane -p -t "$SESSION")
  fi

  echo
  echo "--- $label ---"
  echo "    EXPECT: $expect"
  echo "    WINDOW: $(tmux display-message -p -t "$SESSION" '#{window_width}x#{window_height}')"
  echo "-----8<----- pane -----8<-----"
  printf '%s\n' "$pane"
  echo "----->8----- pane ----->8-----"
  printf '%s\n' "$pane" | analyze
}

# Two runs, because the second proves something the first cannot:
#   (i)  direct-bin  — the baseline pause.
#   (ii) pnpm exec   — THE GROUP-STOP CASE. pnpm shares our pgid and the shell only waits on PNPM, so a
#                      self-stop (kill(process.pid) instead of kill(0)) would leave pnpm in waitpid and
#                      wedge the terminal with no prompt. This run is the only one that can fail if the
#                      suspend seam regresses now that it is called from the pause instead of from Ink.
run_case() {
  local label="$1" cmd="$2"

  echo
  echo "======================================================================"
  echo "==> CASE: $label"
  echo "    \$ $cmd"
  echo "======================================================================"

  # 40 columns is the narrow-terminal lever (see the header). 30 rows leaves room for the transcript.
  tmux new-session -d -s "$SESSION" -x 40 -y 30 "${SCRUB[@]}" zsh -f
  sleep 1

  tmux send-keys -t "$SESSION" "$cmd" Enter
  sleep 8

  # A real command, so there is genuine output in the scrollback for the pause to sit under.
  #
  # Three separate send-keys, and both of the reasons are measured, not defensive:
  #
  #   1. The filter text and Enter must NOT ride in one burst. `send-keys "version" Enter` delivers
  #      "version\r" as a single read, and the palette's key handler treats a multi-byte chunk as text
  #      input — the filter fills in and the Enter is swallowed. The pause never opens, and the capture
  #      reads as a feature regression when it is a harness bug.
  #   2. `version` as a filter fuzzy-matches `release deliver` FIRST (r-e-l-...-e-r-s-i-o-n scattered
  #      across "release deliver"), so the selection sits on a git-touching command, not on `version`.
  #      One Down moves it onto the exact `version` row. Confirm this against CAPTURE A's header: it
  #      must read `$ infra-kit version`.
  tmux send-keys -t "$SESSION" "version"
  sleep 2
  tmux send-keys -t "$SESSION" Down
  sleep 1
  tmux send-keys -t "$SESSION" Enter
  sleep 4

  capture "CAPTURE A — after the command ran" \
    "'\$ infra-kit version' header + version output + '✓ ok' footer, and BELOW it EXACTLY ONE hint row (HINT_ROWS=1, cells=38 — the 39-cell truncation 'any key commands · Esc / Ctrl-C quit · ' with its trailing space trimmed by capture-pane), AFTER row NOT a wrap continuation; NO palette (PALETTE_ROWS=0)"

  # --- Ctrl-Z: the pause must hand a cooked, erased terminal back to the shell -------------------
  tmux send-keys -t "$SESSION" C-z
  sleep 2

  capture "CAPTURE B — after Ctrl-Z" \
    "shell prompt back; the hint row ERASED (HINT_ROWS=0) — not merely followed by an erase sequence; transcript above intact; still no palette"

  # 1. Is the job actually stopped? Under `pnpm exec` this passes ONLY with a process-group stop.
  tmux send-keys -t "$SESSION" "jobs" Enter
  sleep 1
  # 2. Is the terminal cooked again? If raw mode leaked, this neither echoes nor runs.
  tmux send-keys -t "$SESSION" "echo COOKED-OK" Enter
  sleep 1

  capture "CAPTURE C — jobs + echo while stopped" \
    "'suspended'/'Stopped' listed, and COOKED-OK echoed by the SHELL (raw mode was dropped before the stop)"

  # --- N3: narrow the window WHILE THE JOB IS STOPPED, then resume ------------------------------
  # This is what makes the fg step prove the fresh columns() read of §5.7 step 4 rather than merely
  # exercising it: a hint string snapshotted before the stop is 39 cells and would wrap at 30.
  tmux resize-window -t "$SESSION" -x 30
  sleep 1
  echo
  echo "--- resized to $(tmux display-message -p -t "$SESSION" '#{window_width}') columns while stopped ---"

  tmux send-keys -t "$SESSION" "fg" Enter
  sleep 3

  capture "CAPTURE D — after fg at 30 columns" \
    "the hint is BACK on a FRESH row (below the shell's own 'fg' line, never overwriting it), EXACTLY ONE row at the NEW width (HINT_ROWS=1, cells=29 — 'any key commands · Esc / Ctrl'), AFTER row NOT a wrap continuation; transcript above intact; still no palette" \
    scroll

  # --- any key returns to the palette, and the hint must not survive it --------------------------
  tmux send-keys -t "$SESSION" Space
  sleep 2

  # Scrollback, because at 30 columns every command row wraps and the palette is taller than the pane:
  # its '❯' prompt row scrolls above the fold, so a visible-pane capture would report PALETTE_ROWS=0
  # for a palette that is plainly drawn. HINT_ROWS is the assertion that must hold on the WHOLE
  # history — an un-erased hint anywhere in it is the corpse this gate exists to catch.
  capture "CAPTURE E — after a space" \
    "the palette is drawn (PALETTE_ROWS>=1: the '❯' prompt row and/or the 'Enter run' hint) and the pause hint is GONE (HINT_ROWS=0 across the scrollback)" \
    scroll

  # --- Ctrl-C at the palette ends the session cleanly -------------------------------------------
  tmux send-keys -t "$SESSION" C-c
  sleep 2
  tmux send-keys -t "$SESSION" "echo AFTER-OK" Enter
  sleep 1

  capture "CAPTURE F — after Ctrl-C" \
    "back at the shell prompt (the session exited), cursor visible and the tty cooked: AFTER-OK is echoed and run by the SHELL" \
    scroll

  tmux send-keys -t "$SESSION" C-c
  sleep 1
  cleanup
}

run_case "direct-bin" "node $CLI"
run_case "pnpm exec (GROUP-STOP)" "pnpm exec infra-kit"

echo
echo "======================================================================"
echo "Manual assertions — check EVERY one against the captures above, in BOTH cases:"
echo "  [ ] A: the header reads '\$ infra-kit version' (the Down landed on the right command)"
echo "  [ ] A: the hint is EXACTLY ONE row at 40 columns (HINT_ROWS=1, cells=38), never two"
echo "  [ ] A: the AFTER row is not a continuation of the hint text (it did not wrap)"
echo "  [ ] A: it sits BELOW the '✓ ok' footer, and no palette ('❯' row / 'Enter run') is drawn"
echo "  [ ] B: after Ctrl-Z the hint row is GONE from the pane and the shell prompt is back"
echo "  [ ] B: the transcript above (header, version output, footer) is untouched"
echo "  [ ] C: 'jobs' reports suspended/Stopped — especially under 'pnpm exec' (group stop)"
echo "  [ ] C: COOKED-OK is echoed by the shell (raw mode was restored before the stop)"
echo "  [ ] D: after 'fg' at 30 columns the hint is back, ONE row, cells=29 (fresh columns() read)"
echo "  [ ] D: it is on a FRESH row below the shell's 'fg' line — nothing of the shell's is overwritten"
echo "  [ ] E: a space draws the palette AND the hint is gone from the pane"
echo "  [ ] F: Ctrl-C returns the shell prompt and AFTER-OK runs (clean exit, cooked tty)"
echo "======================================================================"
