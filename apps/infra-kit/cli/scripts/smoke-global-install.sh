#!/usr/bin/env bash
#
# Prove that `npm i -g infra-kit` yields a WORKING binary. Table tests cannot do this: the bugs in this
# class (a missing hashbang, a bin the package.json never declared, sibling-bundle resolution through a
# symlinked bin, macOS `/var` -> `/private/var` realpath asymmetry) only exist in a real install tree.
#
# Published 0.1.130 shipped a `dist/cli.js` with no hashbang, so the global bin died with a shell syntax
# error. Nothing in `pnpm run qa` noticed, because `qa` never builds and never installs.
#
# `pnpm pack` (not a raw tarball of the working tree) is deliberate: `pack` runs the `prepack` script,
# which rebuilds `dist/`. So this exercises the very build hook that guards `publish` and asserts against
# the exact bytes npm would upload. NOTE: `pack` does NOT run `prepublishOnly` — that hook only fires on
# `publish` — which is why `prepack` must exist and why this script packs rather than trusting `dist/`.
#
# Usage: apps/infra-kit/cli/scripts/smoke-global-install.sh
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="$(mktemp -d)"
FAILURES=0

cleanup() { rm -rf "$PREFIX"; }
trap cleanup EXIT

# Every assertion is explicit. A filtered/proxied runner can report exit 0 for a failing command, so we
# never rely on `set -e` alone to catch a bad step.
check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  ok    $label"
  else
    echo "  FAIL  $label"
    FAILURES=$((FAILURES + 1))
  fi
}

# Same, for an assertion that needs a pipeline. Passing a pipeline to `check` would pipe *check's* own
# stdout into the next stage instead of the command's.
check_sh() {
  local label="$1"
  local script="$2"
  if bash -c "$script" >/dev/null 2>&1; then
    echo "  ok    $label"
  else
    echo "  FAIL  $label"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "==> packing (runs prepack -> clean + build)"
cd "$PKG_DIR"
TARBALL="$(pnpm pack | tail -1)"
# `pnpm pack` may print a bare filename or an absolute path depending on version.
case "$TARBALL" in
  /*) ;;
  *) TARBALL="$PKG_DIR/$TARBALL" ;;
esac
test -f "$TARBALL" || { echo "FAIL: pack produced no tarball at $TARBALL"; exit 1; }
echo "    tarball: $TARBALL"

echo "==> installing globally into $PREFIX"
npm install -g --prefix "$PREFIX" "$TARBALL" >/dev/null 2>&1
echo "    installed"

INSTALLED="$PREFIX/lib/node_modules/infra-kit"

echo "==> assertions"
# Both bins, by ABSOLUTE path. Invoking a bare `ik` could resolve some other `ik` already on PATH and
# report a false green — the failure mode this script exists to prevent.
check "bin/infra-kit exists and is executable" test -x "$PREFIX/bin/infra-kit"
check "bin/ik exists and is executable"        test -x "$PREFIX/bin/ik"

check_sh "dist/cli.js carries the hashbang" \
  "head -1 '$INSTALLED/dist/cli.js' | grep -qx '#!/usr/bin/env node'"

# The background worker is spawned as `node dist/update-check.js`, never exec'd, so it must NOT have one.
check_sh "dist/update-check.js has no hashbang" \
  "! head -1 '$INSTALLED/dist/update-check.js' | grep -q '^#!'"

check "dist/update-check.js was published" test -f "$INSTALLED/dist/update-check.js"
check "dist/mcp.js was published"          test -f "$INSTALLED/dist/mcp.js"

# The real proof the hashbang works: exec the symlinked bin directly, as a shell would.
if VERSION_OUT="$("$PREFIX/bin/ik" version 2>&1)"; then
  echo "  ok    \`ik version\` exits 0 (prints: ${VERSION_OUT})"
else
  echo "  FAIL  \`ik version\` exited non-zero: ${VERSION_OUT}"
  FAILURES=$((FAILURES + 1))
fi

# `infra-kit mcp` spawns dist/mcp.js resolved via `new URL('./mcp.js', import.meta.url)`. Under a global
# install the bin is a SYMLINK, so this only works because Node resolves import.meta.url to the realpath.
# That is exactly the realpath-asymmetry class of bug, so assert it rather than assume it.
MCP_OUT="$("$PREFIX/bin/infra-kit" mcp </dev/null 2>&1 &
  MCP_PID=$!
  sleep 2
  kill "$MCP_PID" 2>/dev/null || true
  wait "$MCP_PID" 2>/dev/null || true)"

if printf '%s' "$MCP_OUT" | grep -qi 'cannot find module'; then
  echo "  FAIL  \`infra-kit mcp\` could not resolve its sibling bundle: $MCP_OUT"
  FAILURES=$((FAILURES + 1))
else
  echo "  ok    \`infra-kit mcp\` resolves dist/mcp.js through the symlinked global bin"
fi

rm -f "$TARBALL"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "✅ global install smoke test passed"
else
  echo "❌ $FAILURES assertion(s) failed"
  exit 1
fi
