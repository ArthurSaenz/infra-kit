import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runHook, edit, HOOKS_DIR } from './helpers.mjs';
import { findPackageDir } from '../hooklib.mjs';

const REPO_ROOT = resolve(HOOKS_DIR, '..', '..');

// Build a throwaway package (standalone tsconfig + one .ts) UNDER the repo — gitignored `.omc/` —
// so `pnpm exec tsc` resolves the workspace tsc. Returns the pkg dir + the .ts path + a cleanup.
function makeTempPackage(tsSource) {
  const pkgDir = join(REPO_ROOT, '.omc', '.tmp-typecheck-test');
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'tmp-tc', version: '0.0.0' }));
  writeFileSync(
    join(pkgDir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true } }),
  );
  writeFileSync(join(pkgDir, 'src.ts'), tsSource);
  return { pkgDir, file: join(pkgDir, 'src.ts'), cleanup: () => rmSync(pkgDir, { recursive: true, force: true }) };
}

// -------------------------------------------------------------- protect-files

test('protect-files blocks the lockfile and .git/, allows everything else', () => {
  assert.equal(runHook('protect-files.mjs', edit('pnpm-lock.yaml')).status, 2);
  assert.equal(runHook('protect-files.mjs', edit('foo/.git/config')).status, 2);
  assert.equal(runHook('protect-files.mjs', edit('src/index.ts')).status, 0);
  assert.equal(runHook('protect-files.mjs', edit('.github/workflows/ci.yml')).status, 0); // NOT .git/
  assert.equal(runHook('protect-files.mjs', edit('src/.gitignore')).status, 0);
  assert.equal(runHook('protect-files.mjs', '{bad').status, 0); // fails open
});

// -------------------------------------------------------------- edit-pipeline gating

// The pipeline shells out to per-package tooling only for matching files inside a package. For a
// non-matching path it must exit 0 with NO output and never spawn anything.
test('edit-pipeline no-ops on a non-matching file (exit 0, no output)', () => {
  const res = runHook('edit-pipeline.mjs', edit('README.md'));
  assert.equal(res.status, 0, 'exit');
  assert.equal(res.stdout, '', 'stdout');
});

// RETIRED BY DECISION, NOT BROKEN BY ACCIDENT: the assertion that used to sit here was
// "auto-format emits no JSON (best-effort, never a systemMessage)". It pinned auto-format.mjs's
// silence — and that silence was the defect, not the feature: eslint ran with `stdio: 'ignore'` so
// no finding ever reached Claude. edit-pipeline.mjs replaces that hook precisely in order to speak
// up, so keeping the assertion would have pinned the bug. What survives is the part still true and
// still worth guarding — a path outside the repo produces nothing at all.
test('edit-pipeline is silent for a path outside the repo (exit 0, no output)', () => {
  const res = runHook('edit-pipeline.mjs', edit('/nonexistent/deep/x.ts'));
  assert.equal(res.status, 0, 'exit');
  assert.equal(res.stdout + res.stderr, '', 'no output');
});

// The kill switch must short-circuit before any work, matching the repo's DISABLE_OMC convention.
test('CLAUDE_HOOK_PIPELINE_OFF=1 exits 0 immediately', () => {
  const bad = makeTempPackage('export const x: number = "not a number";\n');
  try {
    const res = runHook('edit-pipeline.mjs', edit(bad.file), {
      env: { CLAUDE_HOOK_PIPELINE_OFF: '1' },
    });
    assert.equal(res.status, 0, 'kill switch must exit 0');
    assert.equal(res.stdout + res.stderr, '', 'kill switch must be silent');
    assert.ok(
      !existsSync(join(bad.pkgDir, 'node_modules', '.cache', 'hook-tsc.tsbuildinfo')),
      'no tsc spawn happened, so no tsbuildinfo exists',
    );
  } finally {
    bad.cleanup();
  }
});

// -------------------------------------------------------------- settings wiring

// AC4. The three parallel Edit|Write entries are the defect this pipeline replaced: Claude Code
// runs matching PostToolUse hooks in PARALLEL with no documented ordering, so auto-format rewrote
// the file while typecheck was reading it. Collapsing them to ONE entry is the fix, and this test
// is what stops a fourth entry being added later and quietly reintroducing the race.
test('settings declares one non-async Edit|Write PostToolUse entry', () => {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
  const entries = settings.hooks.PostToolUse.filter((entry) => entry.matcher === 'Edit|Write');

  assert.equal(entries.length, 1, 'exactly one Edit|Write entry — parallel entries cannot be ordered');
  for (const hook of entries[0].hooks) {
    // An async hook reaches Claude only via additionalContext and lands a turn late, describing
    // bytes that may no longer be on disk.
    assert.ok(!('async' in hook), 'the pipeline must be synchronous');
  }
});

// The matcher is a substring regex, so `Edit|Write` also catches `MultiEdit` — which is the whole
// reason no separate MultiEdit entry exists. Nothing pinned that until now, and a future change to
// anchored matching would silently stop covering multi-edits.
test('the Edit|Write matcher still catches MultiEdit', () => {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
  const entry = settings.hooks.PostToolUse.find((e) => e.matcher === 'Edit|Write');
  assert.match('MultiEdit', new RegExp(entry.matcher));
});

// quality-gate's own cases moved to quality-gate.test.mjs when that hook grew a lock and a parser.

// -------------------------------------------------------------- findPackageDir

test('findPackageDir returns the nearest ancestor holding a package.json', () => {
  const result = findPackageDir(join(HOOKS_DIR, 'block-deploy.mjs'));
  assert.ok(result, 'should resolve a package dir for a repo file');
  assert.ok(existsSync(join(result, 'package.json')));
});

test('findPackageDir returns null for a path outside any package', () => {
  assert.equal(findPackageDir('/nonexistent/deep/x.ts'), null);
});

// Locks F-A (type errors reach Claude via exit-2+stderr) AND F2 (incremental writes a tsbuildinfo).
// Carried over from the retired typecheck.mjs — the tsc stage inherits its behavior and its cache
// path unchanged, so these assertions still hold and still guard the same regressions.
test('edit-pipeline surfaces type errors to Claude (exit 2 + stderr) and is incremental', () => {
  // A real TS2322 error.
  const bad = makeTempPackage('export const x: number = "not a number";\n');
  try {
    const res = runHook('edit-pipeline.mjs', edit(bad.file));
    assert.equal(res.status, 2, 'type error must exit 2 (feeds stderr to Claude)');
    assert.match(res.stderr, /TS2322|not assignable/, 'the error text must reach Claude on stderr');
    assert.equal(res.stdout, '', 'no user-only systemMessage JSON');
    assert.ok(
      existsSync(join(bad.pkgDir, 'node_modules', '.cache', 'hook-tsc.tsbuildinfo')),
      'incremental run writes a tsbuildinfo',
    );
  } finally {
    bad.cleanup();
  }

  // Clean file → silent success.
  const good = makeTempPackage('export const x: number = 42;\n');
  try {
    const res = runHook('edit-pipeline.mjs', edit(good.file));
    assert.equal(res.status, 0, 'clean file must exit 0');
    assert.equal(res.stdout + res.stderr, '', 'clean file must be silent');
  } finally {
    good.cleanup();
  }
});

// AC14. tsc checks the WHOLE package program, so an edit to one file can legitimately introduce an
// error in another. This is the assertion that the withdrawn "report only the edited file's
// diagnostics" design would have failed: the agent edits the importer, and the error it just caused
// lives in the imported file.
test('a diagnostic in a non-edited file is reported', () => {
  const pkg = makeTempPackage('export const value: number = 1;\n');
  try {
    // `other.ts` is never the edited file, and it is where the type error lives.
    writeFileSync(join(pkg.pkgDir, 'other.ts'), 'export const broken: number = "nope";\n');
    const res = runHook('edit-pipeline.mjs', edit(pkg.file));
    assert.equal(res.status, 2, 'an error outside the edited file must still block');
    assert.match(res.stderr, /other\.ts/, 'the NON-edited file must be named in the report');
    assert.match(res.stderr, /TS2322|not assignable/);
  } finally {
    pkg.cleanup();
  }
});

// AC19 / verification step 4. A repo-root file has neither an eslint flat config nor a tsconfig
// above it, so both stages must skip SILENTLY rather than emit a blank diagnostic from a tool that
// had nothing to check.
//
// THE AC'S NAME IS "runs prettier only" AND THAT NAME IS OPTIMISTIC. `.prettierignore` opens with
// `*.*`, which matches the `.claude` and `.omc` directory names themselves; gitignore semantics do
// not let a later `!*.mjs` re-include anything under an excluded directory. Confirmed by
// experiment: an identically malformed file reports `[warn]` and exit 1 at the repo root, but
// "All matched files use Prettier code style!" and BYTES UNCHANGED inside `.claude/hooks/`. So for
// hook files and anything under `.omc/` the pipeline runs ZERO effective stages, not "prettier
// only" — the plan's described outcome is right by accident rather than by mechanism.
//
// The observable contract asserted here (exit 0, no output, edit stands) holds either way, which is
// why this is documented rather than fixed: `.prettierignore` is pre-existing config with its own
// reasons and is not this work's to change.
test('a file at the repo root emits nothing (prettier at most, and it is ignored here)', () => {
  const rootFile = join(REPO_ROOT, '.omc', 'tmp-root-file.mjs');
  mkdirSync(join(REPO_ROOT, '.omc'), { recursive: true });
  writeFileSync(rootFile, 'export const x = 1\n');
  try {
    const res = runHook('edit-pipeline.mjs', edit(rootFile));
    assert.equal(res.status, 0, 'no config above it => nothing to report');
    assert.equal(res.stdout + res.stderr, '', 'must not emit a blank diagnostic');
  } finally {
    rmSync(rootFile, { force: true });
  }
});
