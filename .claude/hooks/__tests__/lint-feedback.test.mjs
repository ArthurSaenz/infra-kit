// Unit tier for the report parsers, plus an integration tier that spawns the real hook. EVERY
// FIXTURE IS LITERAL CAPTURED OUTPUT: the missing-config regex once shipped broken because it was
// written against remembered wording rather than what ESLint prints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runHook, edit, HOOKS_DIR } from './helpers.mjs';
import {
  parseEslintJson,
  splitTscBlocks,
  extractToolError,
  isMissingConfig,
  formatReport,
} from '../lint-report.mjs';

const REPO_ROOT = resolve(HOOKS_DIR, '..', '..');

// Separate from edit-hooks.test.mjs's factory, whose typecheck cases depend on eslint skipping.
function makeLintPackage(source, { eslintConfig, prettierConfig, fileName = 'src.ts' } = {}) {
  const pkgDir = join(REPO_ROOT, '.omc', '.tmp-lint-test');
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'tmp-lint', version: '0.0.0' }));
  if (eslintConfig) writeFileSync(join(pkgDir, 'eslint.config.mjs'), eslintConfig);
  // Pinned per-package, so prettier assertions do not rest on the repo-root config.
  if (prettierConfig) writeFileSync(join(pkgDir, '.prettierrc'), prettierConfig);
  writeFileSync(join(pkgDir, fileName), source);
  return {
    pkgDir,
    file: join(pkgDir, fileName),
    cleanup: () => rmSync(pkgDir, { recursive: true, force: true }),
  };
}

// No TS parser, so a throwaway package needs no parser dependency.
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
  // On status 2 ESLint writes NOTHING to stdout, and a throw would lose the whole report.
  assert.deepEqual(parseEslintJson(''), { errors: 0, messages: [] });
  assert.deepEqual(parseEslintJson('Oops! Something went wrong'), { errors: 0, messages: [] });
  assert.deepEqual(parseEslintJson('{"not":"an array"}'), { errors: 0, messages: [] });
});

// THE REGRESSION THIS PINS: pnpm's catalog resolution prints to STDOUT ahead of the array, so a
// strict parse throws. Every synthetic test passed — a temp package has no catalog to resolve.
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

// A `[`-to-`]` slice fails the same way, depending on pnpm's warning text staying bracket-free.
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
  // The severity-1 message must not be counted — that would make the hook stricter than CI.
  assert.equal(result.errors, 2);
  assert.equal(result.messages[0].ruleId, 'no-unused-vars');
  assert.equal(result.messages[0].fixable, false);
  // `fix` present => auto-fixable, the signal that detects a prettier/eslint standoff.
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

// A desynced-node_modules failure: the shape of "the tool failed", not "found problems".
const ESLINT_MODULE_NOT_FOUND_STDERR = `
Oops! Something went wrong! :(

ESLint: 10.7.0

Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@antfu/eslint-config' imported from /repo/vendor/packages/web-toolkit/eslint.config.js
    at packageResolve (node:internal/modules/esm/resolve:873:9)
    at moduleResolve (node:internal/modules/esm/resolve:946:18)
`;

test('extractToolError skips the banner and returns the substantive line', () => {
  // The banner names no cause, so emitting it as our one line would waste an agent cycle.
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
  assert.equal(isMissingConfig('ESLint could not find an eslint.config file.'), true);
  assert.equal(isMissingConfig(ESLINT_MODULE_NOT_FOUND_STDERR), false, 'a real failure is not a missing config');
  assert.equal(isMissingConfig(''), false);
});

// --------------------------------------------------------------------------------- splitTscBlocks

// Diagnostic-shape fixtures are literal `tsc --noEmit --pretty false` captures, paths as emitted.
// The CRLF/Windows and preamble ones are CONSTRUCTED, labelled at each site — this repo cannot
// emit them, and a blanket "all captured" is how the missing-config regex shipped broken.
const TSC_DEEP = `.omc/.tmp-tsc-capture/a.ts(7,6): error TS2345: Argument of type '(v: Outer) => void' is not assignable to parameter of type '(v: OuterBad) => void'.
  Types of parameters 'v' and 'v' are incompatible.
    Type 'OuterBad' is not assignable to type 'Outer'.
      The types of 'a.x' are incompatible between these types.
        Type 'number' is not assignable to type 'string'.`;

// The adversarial shape: a continuation whose TEXT embeds a headline, inside a quoted type literal.
const TSC_EMBEDDED_HEADLINE = `.omc/.tmp-tsc-capture/a.ts(5,6): error TS2345: Argument of type '(v: A) => void' is not assignable to parameter of type '(v: B) => void'.
  Types of parameters 'v' and 'v' are incompatible.
    Type 'B' is not assignable to type 'A'.
      Types of property 'x' are incompatible.
        Type '"a.ts(1,1): error TS1005: injected"' is not assignable to type '"plain"'.`;

// ASSERTS BOUNDARIES, NOT REJOINED BYTES. Rejoining is byte-identical no matter how the lines are
// grouped — measured with three candidate head regexes producing block counts of 2, 3 and 2 on one
// input, all of which rejoined identically. Only the block array can fail on a mis-grouping.
test('splitTscBlocks groups a deep diagnostic into ONE block, preserving tsc indentation', () => {
  assert.deepEqual(splitTscBlocks(TSC_DEEP), [TSC_DEEP]);
});

test('splitTscBlocks keeps an embedded headline inside its parent block', () => {
  // The old parser fabricated a TS1005 here at line 1 of a file that does not exist, because its
  // lazy `(.+?)` file prefix consumed the leading indentation.
  assert.deepEqual(splitTscBlocks(TSC_EMBEDDED_HEADLINE), [TSC_EMBEDDED_HEADLINE]);
});

test('splitTscBlocks separates two file-scoped diagnostics', () => {
  const a = `.omc/.tmp-tsc-capture/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.`;
  const b = `.omc/.tmp-tsc-capture/b.ts(1,18): error TS2304: Cannot find name 'missingSymbolHere'.`;
  assert.deepEqual(splitTscBlocks(`${a}\n${b}`), [a, b]);
});

test('splitTscBlocks keeps a program-level diagnostic with its continuations', () => {
  const captured = `error TS2688: Cannot find type definition file for 'definitely-not-installed-xyz'.
  The file is in the program because:
    Entry point of type library 'definitely-not-installed-xyz' specified in compilerOptions`;
  assert.deepEqual(splitTscBlocks(captured), [captured]);
});

// Both shapes in one run: tsc mixes them freely, and a splitter that handles only the file-scoped
// form would silently drop whole-program conditions.
test('splitTscBlocks keeps program-level and file-scoped diagnostics apart in one run', () => {
  const program = `error TS2688: Cannot find type definition file for 'definitely-not-installed-xyz'.
  The file is in the program because:
    Entry point of type library 'definitely-not-installed-xyz' specified in compilerOptions`;
  const scoped = `.omc/.tmp-tsc-capture/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.`;

  assert.deepEqual(splitTscBlocks(`${program}\n${scoped}`), [program, scoped]);
});

test('splitTscBlocks yields nothing for a crash dump, so it stays a tool failure', () => {
  const crash = `Error: Cannot find module 'typescript/lib/tsc.js'
    at Module._resolveFilename (node:internal/modules/cjs/loader:1234:15)
`;
  assert.deepEqual(splitTscBlocks(crash), []);
});

// CONSTRUCTED, not captured — this repo runs on macOS and cannot emit either shape.
test('splitTscBlocks handles CRLF and Windows paths', () => {
  const win = `C:\\src\\x.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.`;
  assert.deepEqual(splitTscBlocks(`${win}\r\n`), [win], 'the \\r must not survive into the block');
  assert.deepEqual(splitTscBlocks(`${win}\r\n  detail line\r\n`), [`${win}\n  detail line`]);
});

// CONSTRUCTED. Also pins the blank line the CALLER always manufactures: it joins stdout and stderr
// with `\n`, and stdout already ends in one — so a blank line sits beside a diagnostic on every real
// run. `^\s+\S` requires a non-space, which is what keeps that blank line out of the block.
test('splitTscBlocks ignores an unindented preamble and blank lines around diagnostics', () => {
  assert.deepEqual(splitTscBlocks(`Some unindented tool chatter\n${TSC_DEEP}`), [TSC_DEEP]);
  assert.deepEqual(splitTscBlocks(`${TSC_DEEP}\n\n`), [TSC_DEEP], 'a trailing blank must not join the block');
  assert.deepEqual(splitTscBlocks(`${TSC_DEEP}\n   \n`), [TSC_DEEP], 'nor a whitespace-only line');
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

// 40 lint lines never reach the boundary. Under a real flood an uncapped ESLint section took the
// whole budget: 3995 chars with no `TypeScript:` heading anywhere.
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
  // The defect this pipeline exists to close: eslint findings used to reach nobody at all.
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
  // `--quiet` matches CI. A hook stricter than the build teaches the agent to distrust the report.
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

// eslint --fix collapses the arrow to one line, prettier splits it to three, so everything below
// shifts by two. The previous fixture reflowed WITHOUT moving the reported line and so pinned
// nothing. With stage 3b the symbol reports at line 4; without it at line 2, which is `  return 1`.
const FLAT_CONFIG_ARROW_BODY = `export default [
  {
    files: ['**/*.js'],
    rules: { 'no-unused-vars': 'error', 'arrow-body-style': ['error', 'always'] },
  },
];
`;

test('line numbers survive a prettier reflow', () => {
  // Prettier runs after `eslint --fix`, so the coordinates must resolve in the final file.
  const pkg = makeLintPackage('const f = () => 1\nconst unusedProbeValue = 2\n', {
    eslintConfig: FLAT_CONFIG_ARROW_BODY,
    fileName: 'src.js',
  });
  try {
    const res = runHook('edit-pipeline.mjs', edit(pkg.file));
    assert.equal(res.status, 2);

    const reported = /(\d+):(\d+)\s+error\s+'unusedProbeValue'/.exec(res.stderr);
    assert.ok(reported, `expected a reported position for the unused symbol, got:\n${res.stderr}`);

    const finalLines = readFileSync(pkg.file, 'utf8').split('\n');
    const line = finalLines[Number(reported[1]) - 1];
    assert.ok(line !== undefined, 'the reported line must exist in the FINAL file');
    assert.match(
      line,
      /unusedProbeValue/,
      'the reported line must hold the reported symbol in the FINAL file — a pre-reflow ' +
        'coordinate points two lines up, at the arrow body prettier just expanded',
    );

    // Guards the fixture itself: if a future prettier/eslint stops expanding the arrow there is no
    // reflow left to survive, and the assertion above would pass without testing anything.
    assert.ok(finalLines.length >= 4, `fixture must actually reflow, got:\n${finalLines.join('\n')}`);
  } finally {
    pkg.cleanup();
  }
});

// A fix that rewrites the identifier to itself: eslint applies it, sees no change, stops — so the
// message survives --fix still carrying `fix`. Exactly what survivedStage2 must exclude.
// arrow-body-style supplies the reflow that makes stage 3b run at all.
const FLAT_CONFIG_FIXABLE_BUT_UNFIXED = `const alwaysFixable = {
  meta: { fixable: 'code' },
  create(context) {
    return {
      Identifier(node) {
        if (node.name === 'probeSymbol') {
          context.report({
            node,
            message: 'probe rule always reports',
            fix: (fixer) => fixer.replaceText(node, 'probeSymbol'),
          });
        }
      },
    };
  },
};

export default [
  {
    files: ['**/*.js'],
    plugins: { probe: { rules: { always: alwaysFixable } } },
    rules: { 'probe/always': 'error', 'arrow-body-style': ['error', 'always'] },
  },
];
`;

// WITHOUT survivedStage2 this fixture is labelled "prettier reverts eslint's fix for probe/always"
// and told to fix the config — a false accusation about something no config change would help.
// "Fixable" alone cannot mean "eslint fixed it and prettier put it back".
test('a fixable rule that --fix could not resolve is not blamed on prettier', () => {
  const pkg = makeLintPackage('const f = () => 1\nconst probeSymbol = 2\nexport { probeSymbol }\n', {
    eslintConfig: FLAT_CONFIG_FIXABLE_BUT_UNFIXED,
    fileName: 'src.js',
  });
  try {
    const res = runHook('edit-pipeline.mjs', edit(pkg.file));
    assert.equal(res.status, 2, 'the probe rule must still be reported');
    assert.match(res.stderr, /probe\/always/, 'precondition: the fixable-but-unfixed rule is reported');
    assert.doesNotMatch(
      res.stderr,
      /prettier\/eslint conflict/,
      'a rule that survived --fix is not a prettier standoff — it never got fixed in the first place',
    );

    // Pins the precondition: without a reflow, stage 3b never runs and this passes vacuously.
    assert.ok(
      readFileSync(pkg.file, 'utf8').split('\n').length >= 5,
      'fixture must reflow, or stage 3b is skipped and nothing is being tested',
    );
  } finally {
    pkg.cleanup();
  }
});

// C6, timeout path — the most reachable one, and it used to print "inconclusive" AND the stale
// coordinates together. `probe/hang` busy-waits only past 4 lines, so it is quiet before the reflow
// and hangs after: a stage-3b-only failure with stage 2 clean, which nothing else produces.
const FLAT_CONFIG_HANG_AFTER_REFLOW = `const hangOnBigFiles = {
  create(context) {
    return {
      Program() {
        if (context.sourceCode.lines.length >= 4) {
          const end = Date.now() + 25000;
          while (Date.now() < end) { /* busy-wait past the 15s stage budget */ }
        }
      },
    };
  },
};

export default [
  {
    files: ['**/*.js'],
    plugins: { probe: { rules: { hang: hangOnBigFiles } } },
    rules: {
      'probe/hang': 'error',
      'no-unused-vars': 'error',
      'arrow-body-style': ['error', 'always'],
    },
  },
];
`;

test('a stage-3b timeout after a reflow drops the stale coordinates', { timeout: 90_000 }, () => {
  const pkg = makeLintPackage('const f = () => 1\nconst unusedProbeValue = 2\n', {
    eslintConfig: FLAT_CONFIG_HANG_AFTER_REFLOW,
    fileName: 'src.js',
  });
  try {
    const res = runHook('edit-pipeline.mjs', edit(pkg.file));

    assert.match(res.stderr, /inconclusive/, 'the expired stage must be reported as inconclusive');
    // THE BUG: stage 2 said 2:7, and after the reflow line 2 is `  return 1`.
    assert.doesNotMatch(
      res.stderr,
      /^\s*\d+:\d+\s+error/m,
      `a coordinate that no longer resolves must not be reported at all, got:\n${res.stderr}`,
    );
    // The findings themselves were real — only their positions died. Keep the rule names.
    assert.match(res.stderr, /no-unused-vars/, 'the rule that fired before reformatting is still named');
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
  // A config that throws on import: ESLint's own failure, not a finding about the code.
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

// `semi: never` against a prettier that wants semicolons: eslint strips it, prettier puts it back.
// Unlabelled, the agent fixes it correctly after every edit and prettier re-breaks it every time.
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
