import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

// -------------------------------------------------------------- format/typecheck/test gating

// These shell out to per-package tooling only for matching files inside a package. For a
// non-matching path they must exit 0 with NO output and never spawn anything.
test('format/typecheck/test hooks no-op on a non-matching file (exit 0, no output)', () => {
  for (const file of ['auto-format.mjs', 'typecheck.mjs', 'run-tests-async.mjs']) {
    const res = runHook(file, edit('README.md'));
    assert.equal(res.status, 0, `${file} exit`);
    assert.equal(res.stdout, '', `${file} stdout`);
  }
});

test('auto-format emits no JSON (best-effort, never a systemMessage)', () => {
  const res = runHook('auto-format.mjs', edit('/nonexistent/x.mjs'));
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('typecheck/run-tests skip files outside any package (exit 0, no output)', () => {
  for (const file of ['typecheck.mjs', 'run-tests-async.mjs']) {
    const res = runHook(file, edit('/nonexistent/deep/x.ts'));
    assert.equal(res.status, 0, `${file} exit`);
    assert.equal(res.stdout, '', `${file} stdout`);
  }
});

// -------------------------------------------------------------- quality-gate

test('quality-gate fails closed when CLAUDE_PROJECT_DIR is unset (exit 2)', () => {
  const res = runHook('quality-gate.mjs', { tool_name: 'Stop' }, { env: { CLAUDE_PROJECT_DIR: '' } });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /failing closed/);
});

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
test('typecheck surfaces type errors to Claude (exit 2 + stderr) and is incremental', () => {
  // A real TS2322 error.
  const bad = makeTempPackage('export const x: number = "not a number";\n');
  try {
    const res = runHook('typecheck.mjs', edit(bad.file));
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
    const res = runHook('typecheck.mjs', edit(good.file));
    assert.equal(res.status, 0, 'clean file must exit 0');
    assert.equal(res.stdout + res.stderr, '', 'clean file must be silent');
  } finally {
    good.cleanup();
  }
});
