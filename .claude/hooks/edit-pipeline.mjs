#!/usr/bin/env node
// The single PostToolUse hook for Edit|Write. Formats the file, lints it, formats it again, type-
// checks the package, and feeds everything that survives back to Claude in ONE exit-2 + stderr
// report.
//
// WHY ONE PROCESS. Claude Code runs matching PostToolUse hooks in PARALLEL with no documented
// ordering. This replaced three separate Edit|Write entries (auto-format, typecheck,
// run-tests-async) that raced each other by construction: auto-format rewrote the file while
// typecheck read it. A single process is the only ordering guarantee the documented hook contract
// offers, so everything that must be ordered lives inside this one.
//
// WHY ESLINT NOW SPEAKS. The old auto-format ran eslint with `stdio: 'ignore'` and an unchecked
// status, so every finding it could not auto-fix was discarded — ESLint had no feedback channel to
// the agent at all. That is the defect this file exists to close.
//
// WHICH TOOL OWNS THE FINAL BYTES: PRETTIER. The order is prettier -> `eslint --fix` -> prettier,
// so the file left on disk is prettier-clean and `prettier-check` in CI cannot fail on a file this
// hook just touched. The cost is that the second prettier pass can move line numbers out from
// under the lint report, which is what stage 3b re-derives.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readInput, block, allow, findPackageDir } from './hooklib.mjs';
import { acquireLock, holdsLock, releaseLock } from './lock.mjs';
import {
  parseEslintJson,
  parseTscDiagnostics,
  extractToolError,
  isMissingConfig,
  formatTscDiagnostic,
  formatReport,
} from './lint-report.mjs';

// Kill switch, first statement — matching the repo's DISABLE_OMC / OMC_SKIP_HOOKS convention. A
// hook that adds seconds to every edit needs an off switch that costs nothing to reach, including
// when the pipeline itself is what is broken.
if (process.env.CLAUDE_HOOK_PIPELINE_OFF === '1') process.exit(0);

let input;
try {
  input = readInput();
} catch {
  // Fail OPEN on malformed stdin: the edit already happened, so refusing here would annotate the
  // agent with our own parse failure and teach it nothing about its code.
  allow();
}

const filePath = input.filePath;
if (!filePath) allow();

const abs = resolve(filePath);
const wantsPrettier = /\.(ts|tsx|js|jsx|json|css|scss|mjs|cjs)$/.test(filePath);
const wantsEslint = /\.(ts|tsx|js|jsx)$/.test(filePath);
const wantsTsc = /\.(ts|tsx)$/.test(filePath);

if (!wantsPrettier && !wantsEslint && !wantsTsc) allow();

// null only for a path outside the repo, which no stage can meaningfully act on.
const pkgDir = findPackageDir(filePath);
if (!pkgDir) allow();

// STAGE GATING IS BY CONFIG PRESENCE, NOT BY pkgDir NULLNESS. For a file at the repo root —
// including `.claude/hooks/*.mjs` and the root configs — findPackageDir returns the repo root,
// where neither an eslint flat config nor a tsconfig exists. Both stages then skip silently rather
// than emit a blank diagnostic from a tool that had nothing to check.
//
// Worth knowing precisely: for hook files this leaves ZERO effective stages, not "prettier only".
// `.prettierignore` opens with `*.*`, which matches the `.claude` directory name itself, and
// gitignore semantics forbid a later `!*.mjs` from re-including anything beneath it — verified by
// experiment, where an identical malformed file is flagged at the repo root and left untouched
// inside `.claude/hooks/`. The pipeline still behaves correctly (silent, edit stands); it simply
// does less here than the stage list suggests. `.prettierignore` is pre-existing config with its
// own reasons and is deliberately not changed to suit this hook.
const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'];
const hasEslintConfig = ESLINT_CONFIGS.some((name) => existsSync(join(pkgDir, name)));
const hasTsconfig = existsSync(join(pkgDir, 'tsconfig.json'));

// No path filter beyond that, deliberately. CI's `eslint-check` scopes itself to `./src`, but
// reproducing that here would mean parsing each package's script TEXT to infer its lint roots —
// fragile, and a fresh dependency on undocumented behavior. Each package's flat config already
// declares its own ignores, which is the correct gate, and a real error in `vite.config.ts` is a
// real error. CI converges upward instead.

// --------------------------------------------------------------------------- process containment

// Resolve `<tool>` to a real binary by walking `node_modules/.bin` upward from the package.
//
// THIS IS A CORRECTNESS REQUIREMENT, NOT A SPEED OPTIMIZATION, though it is also faster. Stages
// must NOT spawn `pnpm exec <tool>`: `spawnSync`'s killSignal reaches only the DIRECT child, so on
// timeout `pnpm` dies and the tool it launched keeps running — and keeps writing the tsbuildinfo,
// or the source file, AFTER this process has released the lock. An orphaned whole-file writer
// outliving its lock is exactly the source-loss scenario the lock exists to prevent, so the lock
// would be closing a race the timeout path quietly reopened. With no intermediary, the signal
// reaches the tool.
//
// If no binary resolves, the stage is SKIPPED rather than run through an intermediary. Containment
// is not negotiable, and a silent skip is already this hook's answer to "the tool is absent".
function resolveBin(startDir, tool) {
  let dir = startDir;

  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin', tool);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Uniform stage result so no caller has to remember which of status/error/signal means what.
// `timedOut` is derived from the killSignal rather than from the status, because a killed process
// reports a null status that is otherwise indistinguishable from a spawn failure.
function runStage(tool, args, { cwd, timeout }) {
  const bin = resolveBin(cwd, tool);
  if (!bin) return { missing: true, timedOut: false, status: null, stdout: '', stderr: '' };

  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024,
  });

  return {
    missing: false,
    timedOut: result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL',
    spawnFailed: Boolean(result.error) && result.error?.code !== 'ETIMEDOUT',
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function readBytes(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------------------- the run

// staleMs is passed explicitly because lock.mjs carries no default: 120s here is derived from THIS
// site's 90s harness timeout and 70s stage budget (staleMs > harness > stages), and would be wrong
// for any other caller.
const lock = acquireLock(pkgDir, { waitMs: 2000, staleMs: 120_000 });

// Could not get the lock => skip EVERYTHING, including prettier, and exit silent. Prettier is a
// whole-file writer; running it unlocked is the concurrent-truncation case itself. A missed format
// is free to recover from, a truncated source file is not.
if (!lock) allow();

// Immediately, BEFORE stage 1 — see the note on holdsLock in lock.mjs. There is a two-syscall
// window during a steal-and-restore in which this process can hold a lock whose record is already
// gone from disk; this check is what makes it abort before writing anything.
if (!holdsLock(lock)) allow();

const sections = [];

// Prettier runs twice and its result used to be DISCARDED at both call sites — combined with
// `--log-level silent`, that made it the one stage physically incapable of reporting anything,
// including its own expiry. A prettier hanging past both budgets produced a 20-second stall and
// then exit 0 with no output: the agent waited, learned nothing, and had no way to know a stage had
// not run. Principle 4 is "every stage, not just one", so its outcome is captured here. Reported at
// most once, because two timeouts of the same tool are one fact about the environment.
let prettierReported = false;

function runPrettier() {
  try {
    const run = runStage('prettier', ['--log-level', 'silent', '--write', abs], {
      cwd: pkgDir,
      timeout: 10_000,
    });

    if (run.timedOut && !prettierReported) {
      sections.push({ title: 'Prettier:', lines: ['  inconclusive (timed out)'] });
      prettierReported = true;
    }

    return run;
  } catch {
    // Each stage carries its own try/catch so one throw cannot silently skip every stage after it
    // — which would turn a prettier hiccup into a missing type-error report.
    return null;
  }
}

try {
  // --- stage 1: prettier ---------------------------------------------------------------- 10s
  // Prettier is gated on the extension alone, with no config to consult, so a missing binary here
  // genuinely means "this checkout has no prettier" and stays silent — unlike the eslint and tsc
  // stages below, which only run when the package has declared it wants those tools.
  if (wantsPrettier) runPrettier();

  // --- stage 2: eslint ------------------------------------------------------------------ 15s
  //
  // `--quiet` is KEPT: it reports errors only, exactly matching CI's
  // `eslint --cache --quiet --report-unused-disable-directives ./src`. The repo has decided
  // warnings are not failures, and a hook that blocked on warnings would be enforcing a stricter
  // policy than the build — teaching the agent to distrust the report.
  //
  // `--format json` because stylish's layout is not contractual and truncates badly mid-report.
  // `--cache` deliberately NOT used: its value is skipping UNCHANGED files across a multi-file
  // run, and this lints exactly one file that just changed, so every lookup is a guaranteed miss.
  // It would also need its cache location steered away from CI's `.eslintcache` to avoid
  // corrupting it by concurrent write.
  let lintReport = null;
  let lintFailed = false;

  if (wantsEslint && hasEslintConfig) {
    try {
      const run = runStage('eslint', ['--quiet', '--fix', '--format', 'json', abs], {
        cwd: pkgDir,
        timeout: 15_000,
      });

      if (run.timedOut) {
        sections.push({ title: 'ESLint:', lines: ['  inconclusive (timed out)'] });
        lintFailed = true;
      } else if (run.missing) {
        // REACHING HERE MEANS THE PACKAGE ASKED FOR ESLINT — this stage only runs when a flat
        // config is present — and the binary is not there. That is not "this checkout has no
        // eslint"; it is a desynced `node_modules`, the same class of breakage that made ESLint
        // unrunnable across this repo and went unnoticed for revisions. Staying silent here while a
        // merely BROKEN eslint gets a loud report has the asymmetry backwards: the silent case is
        // the one nobody discovers.
        sections.push({
          title: 'ESLint failed to run:',
          lines: ['  eslint binary not found, but this package has an eslint config — try `pnpm install`'],
        });
        lintFailed = true;
      } else if (run.spawnFailed) {
        // Distinct from `missing`: the binary exists but could not be executed at all.
      } else if (run.status === 2 && !isMissingConfig(run.stderr)) {
        // ESLint's OWN fatal failure — not a finding about the code. One capped line, clearly
        // attributed to the tool, because reporting it as a lint error sends the agent hunting
        // through source for a problem that is in the toolchain.
        const detail = extractToolError(run.stderr);
        if (detail) {
          sections.push({ title: 'ESLint failed to run:', lines: [`  ${detail}`] });
          lintFailed = true;
        }
      } else if (run.status !== 2) {
        lintReport = parseEslintJson(run.stdout);
      }
      // status 2 + missing config => silent skip: a package with no flat config is a normal state.
    } catch {
      lintFailed = true;
    }
  }

  // --- stage 3: prettier again ------------------------------------------------------------ 10s
  //
  // `eslint --fix` may have left bytes prettier disagrees with, so prettier gets the last word and
  // owns what lands on disk. We snapshot around it because a reflow moves line:col numbers, and a
  // report whose coordinates do not resolve in the final file is worse than no report.
  let reflowed = false;

  if (wantsPrettier) {
    try {
      const before = readBytes(abs);
      runPrettier();
      const after = readBytes(abs);
      reflowed = Boolean(before && after && !before.equals(after));
    } catch {
      // See stage 1.
    }
  }

  // --- stage 3b: re-lint without --fix ------------------------------------------------------ 15s
  //
  // Only when stage 3 actually moved bytes. Without `--fix` so the run is a pure observation of the
  // final file: its line:col are the ones the agent will see when it opens the file.
  let conflictRules = [];

  // Which rules SURVIVED stage 2's `--fix`. Anything still here is something eslint could not or
  // would not fix, so its reappearance in 3b proves nothing about prettier.
  const survivedStage2 = new Set(lintReport?.messages.map((message) => message.ruleId) ?? []);

  if (reflowed && wantsEslint && hasEslintConfig && !lintFailed) {
    try {
      const run = runStage('eslint', ['--quiet', '--format', 'json', abs], {
        cwd: pkgDir,
        timeout: 15_000,
      });

      if (run.timedOut) {
        sections.push({ title: 'ESLint:', lines: ['  inconclusive (timed out)'] });
        lintFailed = true;
      } else if (!run.missing && !run.spawnFailed && run.status !== 2) {
        lintReport = parseEslintJson(run.stdout);
        // PRETTIER/ESLINT STANDOFF. This repo's shared config carries stylistic rules, so prettier
        // reverting an `eslint --fix` is the classic case, not an exotic one. The evidence is here
        // for free: stage 3 changed the file AND a rule ESLint itself marks fixable is STILL
        // reported. That means eslint fixed it and prettier put it back — so the finding is not
        // the agent's to fix. Reporting it unlabelled would show the identical error after every
        // single edit while the agent's correct fix is re-broken each time: an unactionable report,
        // which costs more than no report.
        //
        // "Fixable AND absent from stage 2's output" is the precise test. Merely "fixable" is not:
        // plenty of fixable rules are reported by BOTH stages because `eslint --fix` never resolved
        // them in the first place, and naming one of those as a rule prettier reverted would be a
        // confident, specific, wrong accusation — the report sending the agent to argue with a
        // config that was never involved.
        conflictRules = [
          ...new Set(
            lintReport.messages
              .filter((message) => message.fixable && !survivedStage2.has(message.ruleId))
              .map((message) => message.ruleId),
          ),
        ];
      }
    } catch {
      lintFailed = true;
    }
  }

  if (lintReport?.errors) {
    const lines = lintReport.messages.map((message) => {
      const rule = message.ruleId ? `  ${message.ruleId}` : '';
      return `  ${message.line}:${message.column}  error  ${message.message}${rule}`;
    });

    if (conflictRules.length > 0) {
      lines.push(
        `  prettier/eslint conflict — not agent-fixable (prettier reverts eslint's fix for ${conflictRules.join(', ')}).`,
        '  Fix the config, not the file.',
      );
    }

    sections.push({
      title: `ESLint (${lintReport.errors} error${lintReport.errors === 1 ? '' : 's'}):`,
      lines,
    });
  }

  // --- stage 4: tsc ------------------------------------------------------------------------ 20s
  //
  // Never short-circuited on a lint failure: one report covering both beats two round trips.
  if (wantsTsc && hasTsconfig) {
    try {
      // tsc will not create intermediate dirs. This is the same cache path the retired
      // typecheck.mjs used, so existing build info carries over with no cold-rebuild penalty, and
      // it stays distinct from the `tsconfig.tsbuildinfo` that CI's `ts-check` writes at the
      // package root — different files, no conflict.
      const tsBuildInfo = join(pkgDir, 'node_modules', '.cache', 'hook-tsc.tsbuildinfo');
      mkdirSync(dirname(tsBuildInfo), { recursive: true });

      const run = runStage(
        'tsc',
        // `--pretty false` EXPLICITLY. tsc defaults to non-pretty on a pipe, but `"pretty": true`
        // in a tsconfig forces ANSI colour and multi-line layout that neither diagnostic regex can
        // match — turning every real type error into a reported "tool failure". The retired
        // typecheck.mjs got away without the flag only because it dumped raw output; once parsing
        // is load-bearing the flag has to be explicit.
        ['--noEmit', '--incremental', '--tsBuildInfoFile', tsBuildInfo, '--pretty', 'false'],
        { cwd: pkgDir, timeout: 20_000 },
      );

      if (run.timedOut) {
        sections.push({ title: 'TypeScript:', lines: ['  inconclusive (timed out)'] });
      } else if (run.missing) {
        // Same asymmetry as the eslint stage: this only runs when the package HAS a tsconfig, so a
        // missing binary means a desynced install, not a checkout that never wanted tsc.
        sections.push({
          title: 'TypeScript failed to run:',
          lines: ['  tsc binary not found, but this package has a tsconfig — try `pnpm install`'],
        });
      } else if (!run.spawnFailed && run.status !== 0) {
        // Joined with a newline, never concatenated bare: if stdout does not end in one, its last
        // line fuses with stderr's first and BOTH stop matching the diagnostic regexes — silently
        // downgrading two real errors into a tool failure.
        const diagnostics = parseTscDiagnostics(`${run.stdout}\n${run.stderr}`);

        if (diagnostics.length > 0) {
          // ALL diagnostics are reported — file-scoped and program-level alike, and whether or not
          // they sit in the file that was just edited. tsc checks the whole package program, so an
          // edit to file A can legitimately introduce an error in file B; filtering to the edited
          // file would drop real errors the agent just caused.
          sections.push({
            title: 'TypeScript:',
            lines: diagnostics.map((d) => `  ${formatTscDiagnostic(d).replaceAll('\n', '\n  ')}`),
            // Own sub-cap, below the report's, so a large type-error run cannot crowd the lint
            // findings out of the report.
            maxChars: 2000,
          });
        } else {
          // Non-zero with nothing parseable is tsc failing to RUN, not the code failing to check.
          // Parse-presence rather than the exit code decides, so this stays correct without
          // encoding tsc's exit-code taxonomy.
          const detail = extractToolError(`${run.stderr}\n${run.stdout}`);
          if (detail) sections.push({ title: 'TypeScript failed to run:', lines: [`  ${detail}`] });
        }
      }
    } catch {
      // See stage 1.
    }
  }
} finally {
  // Latency optimization only. Correctness comes from the stale-steal in lock.mjs, because this
  // does not run when the harness SIGKILLs us at the timeout.
  releaseLock(lock);
}

// Nothing pushed a section => exit 0, no output. Clean code and the normal no-op states (missing
// flat config, tool absent, extension not covered) are SILENT, which is what keeps the report worth
// reading on the occasions it does appear.
//
// Anything pushed a section => exit 2 + stderr, which on PostToolUse is the channel that reaches
// Claude (the edit already ran, so this annotates rather than blocks; systemMessage is shown only
// to the user). Tool failures and timeouts ride the same channel as findings ON PURPOSE — exit 0
// stderr goes nowhere, so emitting them any other way would mean not emitting them. They are kept
// honest by their SECTION TITLE ("ESLint failed to run:", "inconclusive (timed out)") rather than
// by being suppressed, so the agent is never handed a toolchain problem dressed as its own bug.
if (sections.length > 0) {
  const report = formatReport(sections, { maxChars: 4000 });
  if (report) block(`Checks after editing ${abs}:\n\n${report}`);
}

allow();
