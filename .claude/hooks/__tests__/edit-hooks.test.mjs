import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runHook, edit, HOOKS_DIR } from './helpers.mjs';
import { findPackageDir } from '../hooklib.mjs';

const REPO_ROOT = resolve(HOOKS_DIR, '..', '..');

// Under the repo, so the workspace tsc resolves.
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

// A non-matching path must exit 0 with no output and never spawn anything.
test('edit-pipeline no-ops on a non-matching file (exit 0, no output)', () => {
  const res = runHook('edit-pipeline.mjs', edit('README.md'));
  assert.equal(res.status, 0, 'exit');
  assert.equal(res.stdout, '', 'stdout');
});

// Only for a path outside the repo: silence in general was the old defect, not a feature.
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

// Matching PostToolUse hooks run in PARALLEL, so separate entries race by construction. This stops
// a second being added later and quietly reintroducing it.
test('settings declares one non-async Edit|Write PostToolUse entry', () => {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
  const entries = settings.hooks.PostToolUse.filter((entry) => entry.matcher === 'Edit|Write');

  assert.equal(entries.length, 1, 'exactly one Edit|Write entry — parallel entries cannot be ordered');
  for (const hook of entries[0].hooks) {
    // An async hook lands a turn late, describing bytes that may no longer be on disk.
    assert.ok(!('async' in hook), 'the pipeline must be synchronous');
  }
});

// A substring regex, so `Edit|Write` also catches `MultiEdit` — hence no separate entry.
test('the Edit|Write matcher still catches MultiEdit', () => {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
  const entry = settings.hooks.PostToolUse.find((e) => e.matcher === 'Edit|Write');
  assert.match('MultiEdit', new RegExp(entry.matcher));
});

// quality-gate's own cases live in quality-gate.test.mjs.

// -------------------------------------------------------------- findPackageDir

test('findPackageDir returns the nearest ancestor holding a package.json', () => {
  const result = findPackageDir(join(HOOKS_DIR, 'block-deploy.mjs'));
  assert.ok(result, 'should resolve a package dir for a repo file');
  assert.ok(existsSync(join(result, 'package.json')));
});

test('findPackageDir returns null for a path outside any package', () => {
  assert.equal(findPackageDir('/nonexistent/deep/x.ts'), null);
});

// Two properties: type errors reach Claude via exit-2 + stderr, and the run is incremental.
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

// tsc checks the WHOLE program, so filtering diagnostics to the edited file would drop the error
// the agent just caused elsewhere.
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

// No config above a repo-root file, so both stages skip silently. Not even prettier runs:
// `.prettierignore` opens with `*.*`, matching `.claude` and `.omc` themselves.
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
