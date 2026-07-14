#!/usr/bin/env bash
#
# Ctrl-Z at the command palette — terminal-state verification on a REAL pty.
#
# LOCAL-ONLY MANUAL GATE. This is deliberately not wired into `pnpm run qa` and is deliberately not a
# vitest file:
#
#   * `qa` has no build step, and the thing under test is the BUNDLE (dist/cli.js), not the sources.
#   * CI runs on ubuntu-24.04-arm, which has no tmux and no prebuilt arm64 node-pty.
#   * A `describe.skipIf(!tmux)` vitest file would SKIP silently in CI and read as coverage. That false
#     green is the exact failure mode this whole change exists to avoid — the repo has already been
#     burned by ink-testing-library frame tests passing while the real terminal came apart.
#
# So: run it by hand, paste the output into the PR. `ink-testing-library` renders into a fake stdout,
# where raw mode, the cursor and the frame-erase are all fiction. Only a pty can prove them.
#
# Usage:  ./scripts/qa/suspend-pty.sh
#
set -euo pipefail

cd "$(dirname "$0")/../.."

SESSION="ikz-suspend-$$"

echo "==> Building the bundle (dist/cli.js is the artifact under test)"
pnpm run build >/dev/null

CLI="$PWD/dist/cli.js"
test -f "$CLI" || { echo "FAIL: $CLI missing after build"; exit 1; }

command -v tmux >/dev/null || { echo "FAIL: tmux not installed — brew install tmux"; exit 1; }

cleanup() { tmux kill-session -t "$SESSION" 2>/dev/null || true; }
trap cleanup EXIT

# The CI markers MUST be scrubbed. Ink resolves `interactive` as `!isInCi && stdout.isTTY`, and
# `is-in-ci` reads these four. With any of them set, Ink flips to non-interactive EVEN ON A REAL TTY:
# `beginSuspend` then returns before it can drop raw mode or erase the frame. boot.tsx now pins
# `interactive` to the tty alone, which is precisely what run (iii) below exists to prove — but the
# harness itself must not silently exercise that path when it means to test the default one.
SCRUB=(env -u CI -u CONTINUOUS_INTEGRATION -u BUILD_NUMBER -u RUN_ID -u INFRA_KIT_SESSION)

# Three runs, because each proves something the others cannot:
#   (i)   direct-bin        — the baseline suspend.
#   (ii)  pnpm exec         — THE GROUP-STOP CASE. pnpm shares our pgid and the shell only waits on
#                             PNPM; a self-stop would leave pnpm in waitpid and wedge the terminal with
#                             no prompt. This run is the only one that can fail if kill(0) regresses to
#                             kill(process.pid).
#   (iii) CI=true           — proves boot.tsx's `interactive: Boolean(stdout.isTTY)` pin. Without it,
#                             Ink goes non-interactive and hands back a raw-mode tty with a stranded
#                             frame and a hidden cursor, and `fg` never redraws.
run_case() {
  local label="$1" cmd="$2"

  echo
  echo "======================================================================"
  echo "==> CASE: $label"
  echo "    \$ $cmd"
  echo "======================================================================"

  tmux new-session -d -s "$SESSION" -x 120 -y 40 "${SCRUB[@]}" zsh -f
  sleep 1

  # A real command first, so there is genuine output in the scrollback to protect.
  tmux send-keys -t "$SESSION" "$cmd" Enter
  sleep 4
  tmux send-keys -t "$SESSION" "version" Enter   # pick it in the palette
  sleep 3

  # Type a partial filter. It must SURVIVE the suspend — that is the whole point of keeping the Ink
  # component mounted (Ink force-redraws the same live component on resume) rather than unmounting it.
  tmux send-keys -t "$SESSION" "rele"
  sleep 1

  echo "--- before Ctrl-Z ---"
  tmux capture-pane -p -t "$SESSION"

  tmux send-keys -t "$SESSION" C-z
  sleep 2

  echo "--- after Ctrl-Z (expect: shell prompt back, NO '❯' row, NO command list, cursor visible) ---"
  tmux capture-pane -p -t "$SESSION"

  # 1. Is the job actually stopped? Under `pnpm exec` this passes ONLY with a process-group stop.
  tmux send-keys -t "$SESSION" "jobs" Enter
  sleep 1
  # 2. Is the terminal cooked again? If raw mode leaked, this does not echo or run.
  tmux send-keys -t "$SESSION" "echo COOKED-OK" Enter
  sleep 1

  echo "--- jobs + echo (expect: 'suspended'/'Stopped', and COOKED-OK echoed by the SHELL) ---"
  tmux capture-pane -p -t "$SESSION"

  # 3. Scrollback intact? The `version` output from before the suspend must still be there — a
  #    regression on the ESC[3J filter (safe-stderr.ts) would have wiped it.
  echo "--- scrollback (expect: the pre-suspend 'version' output still present) ---"
  tmux capture-pane -p -S -100 -t "$SESSION" | head -30

  # 4. Does fg bring it back, WITH the filter?
  tmux send-keys -t "$SESSION" "fg" Enter
  sleep 3

  echo "--- after fg (expect: palette redrawn, filter 'rele' STILL in the prompt) ---"
  tmux capture-pane -p -t "$SESSION"

  tmux send-keys -t "$SESSION" C-c
  sleep 1
  cleanup
}

run_case "direct-bin"          "node $CLI"
run_case "pnpm exec (GROUP-STOP)" "pnpm exec infra-kit"
run_case "CI=true (interactive pin)" "CI=true node $CLI"

echo
echo "======================================================================"
echo "Manual assertions — check EVERY one against the captures above:"
echo "  [ ] shell prompt returns after Ctrl-Z, in ALL THREE cases"
echo "  [ ] 'jobs' reports suspended/Stopped — especially under 'pnpm exec'"
echo "  [ ] COOKED-OK is echoed by the shell (raw mode was restored)"
echo "  [ ] no '❯' row and no command list left on screen; cursor visible"
echo "  [ ] the pre-suspend 'version' output survives in the scrollback"
echo "  [ ] 'fg' redraws the palette WITH 'rele' still in the filter"
echo "  [ ] separately: start 'dev' from the palette, Ctrl-Z, 'fg' — still suspends/resumes as a unit"
echo "======================================================================"
