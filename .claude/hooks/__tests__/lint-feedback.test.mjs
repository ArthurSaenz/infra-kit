// Unit tier for the report parsers, plus an integration tier that spawns the real hook.
//
// EVERY FIXTURE BELOW IS LITERAL CAPTURED OUTPUT, never a paraphrase. That rule is not stylistic:
// the earlier missing-config regex shipped broken because it was written against the wording
// someone remembered rather than the wording ESLint prints. A fixture does not care that the
// condition which produced it has since been repaired — it is a specimen of a SHAPE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runHook, edit, HOOKS_DIR } from './helpers.mjs';
import {
  parseEslintJson,
  parseTscDiagnostics,
  extractToolError,
  isMissingConfig,
  formatReport,
} from '../lint-report.mjs';

const REPO_ROOT = resolve(HOOKS_DIR, '..', '..');

// `makeTempPackage` in edit-hooks.test.mjs deliberately writes NO eslint.config.*, because the
// typecheck cases depend on eslint skipping. Lint cases need a package that has one, so they get
// their own factory rather than an overload that would change the typecheck cases' behavior.
function makeLintPackage(source, { eslintConfig, prettierConfig, fileName = 'src.ts' } = {}) {
  const pkgDir = join(REPO_ROOT, '.omc', '.tmp-lint-test');
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'tmp-lint', version: '0.0.0' }));
  if (eslintConfig) writeFileSync(join(pkgDir, 'eslint.config.mjs'), eslintConfig);
  // Pinned per-package when a case depends on prettier's behavior, so the assertion does not rest
  // on whatever the repo-root config happens to say today.
  if (prettierConfig) writeFileSync(join(pkgDir, '.prettierrc'), prettierConfig);
  writeFileSync(join(pkgDir, fileName), source);
  return {
    pkgDir,
    file: join(pkgDir, fileName),
    cleanup: () => rmSync(pkgDir, { recursive: true, force: true }),
  };
}

// A flat config with no TypeScript parser, so it lints plain JS syntax only — enough for
// no-unused-vars without dragging a parser dependency into a throwaway package.
const FLAT_CONFIG_UNUSED_ERROR = `export default [
  { files: ['**/*.js'], rules: { 'no-unused-vars': 'error' } },
];
`;

const FLAT_CONFIG_UNUSED_WARN = `export default [
  { files: ['**/*.js'], rules: { 'no-unused-vars': 'warn' } },
];
`;

// ------------------------------------------------------------------------------ parseEslintJson

test('parseEslintJson tolerates the real status-2 case and other non-JSON', () => {
  // Verified: on status 2 ESLint writes NOTHING to stdout — captured length 0. A parser that threw
  // here would lose the whole report, including the tsc section that had nothing to do with it.
  assert.deepEqual(parseEslintJson(''), { errors: 0, messages: [] });
  assert.deepEqual(parseEslintJson('Oops! Something went wrong'), { errors: 0, messages: [] });
  assert.deepEqual(parseEslintJson('{"not":"an array"}'), { errors: 0, messages: [] });
});

// THE REGRESSION THIS PINS. `--format json` promises one JSON array, but in this repo pnpm's
// catalog resolution prints to STDOUT ahead of it. A strict parse throws, the tolerant path returns
// "no findings", and a real error reaches nobody — the pipeline's own defect, one layer down. It
// passed every synthetic test, because a throwaway temp package has no catalog to resolve. The
// preamble below is LITERAL captured output from `eslint --quiet --format json src/cn/cn.ts` in
// vendor/packages/web-toolkit.
test('parseEslintJson finds the payload behind a non-JSON stdout preamble', () => {
  const captured = `Dependency "@types/react" could not be resolved for catalog "default"
Dependency "clsx" could not be resolved for catalog "default"
Dependency "react" could not be resolved for catalog "default"
[{"filePath":"/repo/src/cn/cn.ts","messages":[{"ruleId":"unused-imports/no-unused-vars","severity":2,"message":"'unusedRealCheck' is assigned a value but never used. Allowed unused vars must match /^_/u.","line":18,"column":7}],"errorCount":1}]
`;

  const result = parseEslintJson(captured);
  assert.equal(result.errors, 1, 'the finding must survive the preamble');
  assert.equal(result.messages[0].ruleId, 'unused-imports/no-unused-vars');
  assert.equal(result.messages[0].line, 18);
});

// The first fix for the above sliced from the first `[` to the last `]`, which is fragile in the
// SAME DIRECTION as the bug it replaced: it depends on pnpm's warning text staying bracket-free,
// and pnpm's warning text is not contractual. Both shapes below returned ZERO findings under the
// slice — failing silently, which is the one failure mode this pipeline exists to eliminate. The
// line scan is immune because `--format json` puts the array on a single line.
test('parseEslintJson survives brackets in the surrounding noise', () => {
  const payload =
    '[{"filePath":"/repo/a.js","messages":[{"ruleId":"no-unused-vars","severity":2,"message":"unused","line":1,"column":7}]}]';

  // A bracketed PREAMBLE: the slice starts at the `[` of "[deprecated]" and parses garbage.
  const withPrefix = parseEslintJson(`WARN [deprecated] something\n${payload}`);
  assert.equal(withPrefix.errors, 1, 'a bracketed warning before the payload must not hide it');

  // A bracketed POSTAMBLE: the slice runs to the trailing `]` and parses garbage.
  const withSuffix = parseEslintJson(`Dependency x\n${payload}\nWARN done ]`);
  assert.equal(withSuffix.errors, 1, 'a bracketed warning after the payload must not hide it');

  // Both at once, for good measure.
  const withBoth = parseEslintJson(`WARN [a] x\n${payload}\n[b] done ]`);
  assert.equal(withBoth.errors, 1);
});

test('parseEslintJson reads a real payload and keeps the fixable flag', () => {
  const payload = JSON.stringify([
    {
      filePath: '/tmp/x.js',
      messages: [
        {
          ruleId: 'no-unused-vars',
          severity: 2,
          message: "'foo' is assigned a value but never used.",
          line: 12,
          column: 5,
        },
        { ruleId: 'semi', severity: 2, message: 'Missing semicolon.', line: 3, column: 9, fix: { range: [1, 2], text: ';' } },
        { ruleId: 'no-console', severity: 1, message: 'Unexpected console.', line: 1, column: 1 },
      ],
    },
  ]);

  const result = parseEslintJson(payload);
  // The severity-1 message must not be counted: `--quiet` already drops warnings at the source, and
  // counting them here would make the hook stricter than CI.
  assert.equal(result.errors, 2);
  assert.equal(result.messages[0].ruleId, 'no-unused-vars');
  assert.equal(result.messages[0].fixable, false);
  // `fix` present => ESLint marks the rule auto-fixable. This is the signal that detects a
  // prettier/eslint standoff.
  assert.equal(result.messages[1].fixable, true);
});

// ------------------------------------------------------------- extractToolError / isMissingConfig

// LITERAL capture of `eslint --quiet --format json a.js` in a directory with no flat config.
const ESLINT_NO_CONFIG_STDERR = `
Oops! Something went wrong! :(

ESLint: 10.7.0

ESLint couldn't find an eslint.config.(js|mjs|cjs) file.

From ESLint v9.0.0, the default configuration file is now eslint.config.js.
If you are using a .eslintrc.* file, please follow the migration guide
to update your configuration file to the new format:

https://eslint.org/docs/latest/use/configure/migration-guide
`;

// LITERAL capture of the desynced-node_modules failure this pipeline was designed against: eslint
// exited 2 because its shared config could not be resolved. The environment has since been
// repaired, which does not make the specimen less real — this is the shape of "the tool itself
// failed", as distinct from "the tool found problems".
const ESLINT_MODULE_NOT_FOUND_STDERR = `
Oops! Something went wrong! :(

ESLint: 10.7.0

Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@antfu/eslint-config' imported from /repo/vendor/packages/web-toolkit/eslint.config.js
    at packageResolve (node:internal/modules/esm/resolve:873:9)
    at moduleResolve (node:internal/modules/esm/resolve:946:18)
`;

test('extractToolError skips the banner and returns the substantive line', () => {
  // "Oops! Something went wrong! :(" names no cause and suggests no action. Emitting it as the one
  // line we are allowed would be a wasted agent cycle, which is the whole reason the banner is
  // stripped rather than the first non-empty line taken.
  const extracted = extractToolError(ESLINT_NO_CONFIG_STDERR);
  assert.equal(extracted, "ESLint couldn't find an eslint.config.(js|mjs|cjs) file.");
  assert.doesNotMatch(extracted, /^Oops!/);
  assert.notEqual(extracted, '');
});

test('extractToolError names the cause for a module-resolution failure', () => {
  const extracted = extractToolError(ESLINT_MODULE_NOT_FOUND_STDERR);
  assert.match(extracted, /ERR_MODULE_NOT_FOUND/);
  assert.match(extracted, /@antfu\/eslint-config/);
  assert.doesNotMatch(extracted, /^Oops!/);
});

test('extractToolError caps at 300 chars and yields null when nothing remains', () => {
  const long = extractToolError(`x${'y'.repeat(500)}`);
  assert.ok(long.length <= 301, 'capped, with an ellipsis');
  assert.equal(extractToolError(''), null);
  assert.equal(extractToolError('\n\n  \n'), null);
  // Banner-only input must not produce a blank line masquerading as a diagnostic.
  assert.equal(extractToolError('Oops! Something went wrong! :(\n\nESLint: 10.7.0\n'), null);
});

test('isMissingConfig matches the literal captured stderr, and both spellings', () => {
  assert.equal(isMissingConfig(ESLINT_NO_CONFIG_STDERR), true);
  // A missing flat config is a NORMAL state for many directories, so it is the one status-2 case
  // that stays silent instead of emitting a line.
  assert.equal(isMissingConfig('ESLint could not find an eslint.config file.'), true);
  assert.equal(isMissingConfig(ESLINT_MODULE_NOT_FOUND_STDERR), false, 'a real failure is not a missing config');
  assert.equal(isMissingConfig(''), false);
});

// ------------------------------------------------------------------------- parseTscDiagnostics

// LITERAL capture of `tsc --noEmit --pretty false` against a tsconfig naming an unresolvable type
// package. Note the EXIT CODE WAS 2, not 1 — which is exactly why parse-presence rather than the
// exit code decides whether output counts as findings.
const TSC_PROGRAM_LEVEL = `error TS2688: Cannot find type definition file for 'vite/client'.
  The file is in the program because:
    Entry point of type library 'vite/client' specified in compilerOptions
`;

test('a program-level diagnostic parses as one entry with its continuation lines', () => {
  const diagnostics = parseTscDiagnostics(TSC_PROGRAM_LEVEL);

  assert.equal(diagnostics.length, 1, 'one diagnostic, not zero and not three');
  assert.equal(diagnostics[0].file, null, 'program-level diagnostics carry no file(line,col) prefix');
  assert.equal(diagnostics[0].code, 'TS2688');
  // The continuation lines carry the ONLY actionable content here — the headline just says a file
  // is missing. Dropping them yields a finding nobody can act on.
  assert.equal(diagnostics[0].details.length, 2);
  assert.match(diagnostics[0].details[0], /The file is in the program because/);
  assert.match(diagnostics[0].details[1], /Entry point of type library/);
});

test('file-scoped diagnostics parse, and both forms coexist in one run', () => {
  const diagnostics = parseTscDiagnostics(
    `${TSC_PROGRAM_LEVEL}src/x.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.\n`,
  );

  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[1].file, 'src/x.ts');
  assert.equal(diagnostics[1].line, 4);
  assert.equal(diagnostics[1].column, 7);
  assert.equal(diagnostics[1].code, 'TS2322');
});

test('a tsc crash dump is not reported as type errors', () => {
  // A non-zero exit with nothing parseable is tsc failing to RUN. Reporting it as type errors sends
  // the agent hunting through source for a problem that is in the toolchain.
  const crash = `Error: Cannot find module 'typescript/lib/tsc.js'
    at Module._resolveFilename (node:internal/modules/cjs/loader:1234:15)
`;
  assert.deepEqual(parseTscDiagnostics(crash), []);
});

// ------------------------------------------------------------------------------------ formatReport

test('a large report is capped, with the tsc sub-cap and a truncation footer', () => {
  const lintLines = Array.from({ length: 40 }, (_, i) => `  ${i}:1  error  lint problem ${i}  some-rule`);
  const tscLines = Array.from({ length: 200 }, (_, i) => `  src/x.ts(${i},1): error TS2322: ${'y'.repeat(60)}`);

  const report = formatReport(
    [
      { title: 'ESLint (40 errors):', lines: lintLines },
      { title: 'TypeScript:', lines: tscLines, maxChars: 2000 },
    ],
    { maxChars: 4000 },
  );

  assert.ok(report.length <= 4000, `overall cap: ${report.length}`);
  assert.match(report, /more suppressed/, 'truncation must be announced, never silent');
  assert.match(report, /pnpm run eslint-check \/ pnpm run ts-check/, 'and must say how to see the rest');
  // The sub-cap is what stops a large type-error run crowding the lint findings out entirely.
  assert.match(report, /lint problem 0/, 'lint findings survive a huge tsc section');
  assert.match(report, /lint problem 39/);
});

test('formatReport drops empty sections entirely', () => {
  assert.equal(formatReport([{ title: 'ESLint:', lines: [] }]), '');
});

// The cap test above uses only 40 lint lines, so it never reaches the boundary and never noticed
// that ONLY the tsc section carried a sub-cap. With a realistic flood the uncapped ESLint section
// consumed the whole budget: verified at 3995 chars of lint output with no `TypeScript:` heading
// and no `TS2322` anywhere, ending mid-word. The erased section is the one the agent needed most —
// a type error is far harder to find by hand than a lint error.
test('a large lint run does not erase the TypeScript section', () => {
  const lintLines = Array.from(
    { length: 200 },
    (_, i) => `  ${i}:1  error  a fairly wordy lint message number ${i} ${'z'.repeat(40)}  some-rule`,
  );

  const report = formatReport(
    [
      { title: 'ESLint (200 errors):', lines: lintLines },
      { title: 'TypeScript:', lines: ["  src/x.ts(4,7): error TS2322: Type 'string' is not assignable."], maxChars: 2000 },
    ],
    { maxChars: 4000 },
  );

  assert.ok(report.length <= 4000, `overall cap: ${report.length}`);
  assert.match(report, /TypeScript:/, 'the second section must not be crowded out');
  assert.match(report, /TS2322/, 'and its content must actually survive');
  assert.match(report, /more suppressed/, 'the lint section announces its own truncation');
});

// -------------------------------------------------------------------------------- integration tier

test('reports a no-unused-vars error to the agent', () => {
  // The defect this whole pipeline exists to close: the retired auto-format.mjs ran eslint with
  // `stdio: 'ignore'` and an unchecked status, so a finding like this reached nobody.
  const pkg = makeLintPackage('const foo = 1\n', {
    eslintConfig: FLAT_CONFIG_UNUSED_ERROR,
    fileName: 'src.js',
  });
  try {
    const res = runHook('edit-pipeline.mjs', edit(pkg.file));
    assert.equal(res.status, 2, 'a lint error must exit 2 so stderr reaches Claude');
    assert.match(res.stderr, /no-unused-vars/, 'the RULE ID must be named — it is what makes it fixable');
    assert.match(res.stderr, /1:7/, 'line:col must be present');
    assert.equal(res.stdout, '', 'no user-only systemMessage JSON');
  } finally {
    pkg.cleanup();
  }
});

test('warnings are not reported', () => {
  // `--quiet` is kept deliberately, matching CI's `eslint --cache --quiet ... ./src`. A hook that
  // blocked on warnings would enforce a stricter policy than the build, and the agent would learn
  // to distrust the report.
  const pkg = makeLintPackage('const foo = 1\n', {
    eslintConfig: FLAT_CONFIG_UNUSED_WARN,
    fileName: 'src.js',
  });
  try {
    const res = runHook('edit-pipeline.mjs', edit(pkg.file));
    assert.equal(res.status, 0, 'warnings-only must exit 0');
    assert.equal(res.stdout + res.stderr, '', 'and be entirely silent');
  } finally {
    pkg.cleanup();
  }
});

test('line numbers survive a prettier reflow', () => {
  // Prettier owns the final bytes, so it runs AFTER `eslint --fix` and can move line numbers out
  // from under a report generated before it. The reported coordinates must resolve in the file the
  // agent will actually open.
  const pkg = makeLintPackage('const   a=1;const   foo   =   2\n', {
    eslintConfig: FLAT_CONFIG_UNUSED_ERROR,
    fileName: 'src.js',
  });
  try {
    const res = runHook('edit-pipeline.mjs', edit(pkg.file));
    assert.equal(res.status, 2);

    const reported = /(\d+):(\d+)\s+error\s+'foo'/.exec(res.stderr);
    assert.ok(reported, `expected a reported position for 'foo', got:\n${res.stderr}`);

    const finalLines = readFileSync(pkg.file, 'utf8').split('\n');
    const line = finalLines[Number(reported[1]) - 1];
    assert.ok(line !== undefined, 'the reported line must exist in the FINAL file');
    assert.match(line, /foo/, 'and must actually be the line holding the reported symbol');
  } finally {
    pkg.cleanup();
  }
});

test('a missing eslint config is silent', () => {
  // No flat config is a normal state, not a failure — the one status-2 case that emits nothing.
  const pkg = makeLintPackage('const foo = 1\n', { fileName: 'src.js' });
  try {
    const res = runHook('edit-pipeline.mjs', edit(pkg.file));
    assert.equal(res.status, 0);
    assert.equal(res.stdout + res.stderr, '', 'a package with no flat config must not be annotated');
  } finally {
    pkg.cleanup();
  }
});

test('an eslint fatal error yields one substantive line, not a blank', () => {
  // A flat config that throws on import — ESLint exits 2 with its own failure, which is NOT a
  // finding about the code and must not be dressed as one.
  const pkg = makeLintPackage('const foo = 1\n', {
    eslintConfig: "import 'node:nonexistent-module-for-fixture';\nexport default [];\n",
    fileName: 'src.js',
  });
  try {
    const res = runHook('edit-pipeline.mjs', edit(pkg.file));
    assert.equal(res.status, 2, 'the agent must hear that its linter is broken');
    assert.match(res.stderr, /ESLint failed to run/, 'labelled as a TOOL failure, not a lint finding');
    assert.doesNotMatch(res.stderr, /Oops! Something went wrong/, 'never the contentless banner');
    // One line, not a stack dump: the report body after the title must stay short.
    const body = res.stderr.split('ESLint failed to run:')[1] ?? '';
    assert.ok(body.trim().length > 0, 'and it must not be blank');
    assert.ok(body.trim().length <= 320, `capped at ~300 chars, got ${body.trim().length}`);
  } finally {
    pkg.cleanup();
  }
});

// AC16. This repo's shared eslint config carries stylistic rules, so prettier reverting an
// `eslint --fix` is the CLASSIC case, not an exotic one. `semi: never` against a prettier that
// wants semicolons is the smallest faithful reproduction: eslint strips the semicolon, prettier
// puts it back, and the file can never satisfy both.
//
// WHY LABELLING MATTERS. Unlabelled, the agent sees the identical error after every single edit,
// "fixes" it correctly, and prettier re-breaks it on the next edit — an unactionable report, which
// costs more than no report at all. The evidence is already available for free: stage 3 changed the
// file AND stage 3b still reports a rule ESLint itself marks fixable.
test('a prettier/eslint conflict is labeled not-agent-fixable', () => {
  const pkg = makeLintPackage('const foo = 1;\nexport default foo;\n', {
    eslintConfig: "export default [\n  { files: ['**/*.js'], rules: { semi: ['error', 'never'] } },\n];\n",
    prettierConfig: JSON.stringify({ semi: true }),
    fileName: 'src.js',
  });
  try {
    const res = runHook('edit-pipeline.mjs', edit(pkg.file));
    assert.equal(res.status, 2);
    assert.match(res.stderr, /not agent-fixable/, 'the standoff must be named as such');
    assert.match(res.stderr, /Fix the config, not the file/, 'and must point at the real fix');
    assert.match(res.stderr, /semi/, 'naming the rule that is deadlocked');
  } finally {
    pkg.cleanup();
  }
});

test('the lint stage is skipped for a file the extension gate excludes', () => {
  const pkg = makeLintPackage('# not code\n', {
    eslintConfig: FLAT_CONFIG_UNUSED_ERROR,
    fileName: 'notes.md',
  });
  try {
    const res = runHook('edit-pipeline.mjs', edit(pkg.file));
    assert.equal(res.status, 0);
    assert.equal(res.stdout + res.stderr, '');
    assert.ok(existsSync(pkg.file), 'and the file is left alone');
  } finally {
    pkg.cleanup();
  }
});
