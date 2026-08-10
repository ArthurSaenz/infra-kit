#!/usr/bin/env node
// PostToolUse hook for Edit|Write: prettier -> `eslint --fix` -> prettier -> tsc, then one
// exit-2 + stderr report. One process, because Claude Code runs matching hooks in PARALLEL with no
// ordering. Prettier runs last and owns the final bytes; stage 3b re-derives the line numbers.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readInput, block, allow, addContext, findPackageDir } from './hooklib.mjs';
import { acquireLock, holdsLock, releaseLock } from './lock.mjs';
import {
  parseEslintJson,
  splitTscBlocks,
  extractToolError,
  isMissingConfig,
  formatReport,
} from './lint-report.mjs';

if (process.env.CLAUDE_HOOK_PIPELINE_OFF === '1') process.exit(0);

let input;
try {
  input = readInput();
} catch {
  allow(); // the edit already happened; our own parse failure is not the agent's problem
}

const filePath = input.filePath;
if (!filePath) allow();

const abs = resolve(filePath);
const wantsPrettier = /\.(ts|tsx|js|jsx|json|css|scss|mjs|cjs)$/.test(filePath);
const wantsEslint = /\.(ts|tsx|js|jsx)$/.test(filePath);
const wantsTsc = /\.(ts|tsx)$/.test(filePath);

if (!wantsPrettier && !wantsEslint && !wantsTsc) allow();

const pkgDir = findPackageDir(filePath);
if (!pkgDir) allow();

// Gated on config presence, not on pkgDir: findPackageDir returns the repo root for root-level
// files, where neither config exists, so both stages skip instead of emitting a blank diagnostic.
const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'];
const hasEslintConfig = ESLINT_CONFIGS.some((name) => existsSync(join(pkgDir, name)));
const hasTsconfig = existsSync(join(pkgDir, 'tsconfig.json'));

// --------------------------------------------------------------------------- process containment

// Stages must not go through `pnpm exec`: spawnSync's killSignal reaches only the DIRECT child, so
// a timeout would kill pnpm while the tool kept writing — after we released the lock.
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
    // From the signal, not the status: a killed process reports a null status, same as a spawn failure.
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

// staleMs (120s) > harness timeout (90s) > waitMs + stage budget (8 + 70). See lock.mjs.
// waitMs was missing from that chain at 2000ms — under the measured hold, 2.6s warm / 4.6s cold.
const lock = acquireLock(pkgDir, { waitMs: 8000, staleMs: 120_000 });

// No lock => skip everything, prettier included: it is a whole-file writer, so running it unlocked
// is the concurrent-truncation case itself. The skip must reach the MODEL — silence reads as clean.
// Not exit 2 (the ping-pong incident, README) and not stderr (dropped on exit 0; measured).
function skip(reason) {
  addContext(
    `Checks after editing ${abs}: SKIPPED — ${reason}. Nothing was verified — treat this file as unchecked, and re-check with: pnpm run qa`,
    'PostToolUse',
  );
}

if (!lock) skip(`another hook held the lock on ${pkgDir} for the whole wait`);
if (!holdsLock(lock)) skip('the lock was lost to a concurrent hook'); // steal-and-restore; see lock.mjs

const sections = [];

// Prettier runs under `--log-level silent`, so an unreported timeout is a 20s stall then exit 0.
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
    return null; // per-stage catch, so one throw cannot skip the stages after it
  }
}

try {
  // --- stage 1: prettier ---------------------------------------------------------------- 10s
  if (wantsPrettier) runPrettier();

  // --- stage 2: eslint ------------------------------------------------------------------ 15s
  // `--quiet` matches CI. No `--cache`: one just-changed file always misses, and it would risk
  // corrupting CI's `.eslintcache` by concurrent write.
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
        // The package has a flat config, so a missing binary is a desynced install, not a
        // checkout without eslint. Silence here is the failure nobody would discover.
        sections.push({
          title: 'ESLint failed to run:',
          lines: ['  eslint binary not found, but this package has an eslint config — try `pnpm install`'],
        });
        lintFailed = true;
      } else if (run.spawnFailed) {
        // Unlike `missing`: the binary exists but could not be executed.
      } else if (run.status === 2 && !isMissingConfig(run.stderr)) {
        // ESLint's own failure. Reported as a lint finding it would send the agent hunting through
        // source for a toolchain problem.
        const detail = extractToolError(run.stderr);
        if (detail) {
          sections.push({ title: 'ESLint failed to run:', lines: [`  ${detail}`] });
          lintFailed = true;
        }
      } else if (run.status !== 2) {
        lintReport = parseEslintJson(run.stdout);
      }
      // status 2 + missing config => silent: a package with no flat config is a normal state.
    } catch {
      lintFailed = true;
    }
  }

  // --- stage 3: prettier again ------------------------------------------------------------ 10s
  // Snapshotted, because a reflow moves the line:col stage 2 just reported.
  let reflowed = false;

  if (wantsPrettier) {
    try {
      const before = readBytes(abs);
      runPrettier();
      const after = readBytes(abs);
      reflowed = Boolean(before && after && !before.equals(after));
    } catch {
      // see stage 1
    }
  }

  // --- stage 3b: re-lint without --fix ------------------------------------------------------ 15s
  // A pure observation of the final file, so its coordinates are the ones the agent will see.
  let conflictRules = [];

  // Rules eslint could not fix, so their reappearance below proves nothing about prettier.
  const survivedStage2 = new Set(lintReport?.messages.map((message) => message.ruleId) ?? []);

  if (reflowed && wantsEslint && hasEslintConfig && !lintFailed) {
    let refreshed = false;

    try {
      const run = runStage('eslint', ['--quiet', '--format', 'json', abs], {
        cwd: pkgDir,
        timeout: 15_000,
      });

      if (!run.timedOut && !run.missing && !run.spawnFailed && run.status !== 2) {
        lintReport = parseEslintJson(run.stdout);
        // Fixable AND absent from stage 2 => eslint fixed it, prettier put it back.
        // Why this stays despite never having fired — see README Design notes.
        conflictRules = [
          ...new Set(
            lintReport.messages
              .filter((message) => message.fixable && !survivedStage2.has(message.ruleId))
              .map((message) => message.ruleId),
          ),
        ];
        refreshed = true;
      }
    } catch {
      // falls through to the discard below
    }

    // The reflow killed stage 2's line:col, so no fresh report means DISCARD — never print findings
    // at positions that no longer resolve. Catches all three failures: timeout, status 2, throw.
    // The rules were real, only their coordinates died, so they are still named.
    if (!refreshed) {
      const rules = [...survivedStage2].filter(Boolean).sort();

      sections.push({
        title: 'ESLint:',
        lines:
          rules.length > 0
            ? [
                '  inconclusive — the re-lint after reformatting did not complete, so line numbers were dropped.',
                `  Rules reported before reformatting: ${rules.join(', ')}`,
              ]
            : ['  inconclusive — the file was reformatted and could not be re-checked.'],
      });
      lintReport = null;
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
  // Runs even after a lint failure: one report covering both beats two round trips.
  if (wantsTsc && hasTsconfig) {
    try {
      // Distinct from the `tsconfig.tsbuildinfo` CI writes at the package root.
      const tsBuildInfo = join(pkgDir, 'node_modules', '.cache', 'hook-tsc.tsbuildinfo');
      mkdirSync(dirname(tsBuildInfo), { recursive: true });

      const run = runStage(
        'tsc',
        // `--pretty false` explicitly: `"pretty": true` in a tsconfig forces ANSI colour and a
        // multi-line layout neither diagnostic regex can match.
        ['--noEmit', '--incremental', '--tsBuildInfoFile', tsBuildInfo, '--pretty', 'false'],
        { cwd: pkgDir, timeout: 20_000 },
      );

      if (run.timedOut) {
        sections.push({ title: 'TypeScript:', lines: ['  inconclusive (timed out)'] });
      } else if (run.missing) {
        sections.push({
          title: 'TypeScript failed to run:',
          lines: ['  tsc binary not found, but this package has a tsconfig — try `pnpm install`'],
        });
      } else if (!run.spawnFailed && run.status !== 0) {
        // Joined with a newline: bare concatenation fuses stdout's last line to stderr's first and
        // both stop matching.
        const blocks = splitTscBlocks(`${run.stdout}\n${run.stderr}`);

        if (blocks.length > 0) {
          // Including diagnostics outside the edited file — tsc checks the whole program, and an
          // edit to A can break B.
          sections.push({
            title: 'TypeScript:',
            // Uniform 2-space indent, so tsc's own nesting depth survives.
            lines: blocks.map((block) => `  ${block.replaceAll('\n', '\n  ')}`),
            maxChars: 2000, // sub-cap, so a type-error flood cannot crowd out the lint findings
          });
        } else {
          // Non-zero with nothing parseable is tsc failing to RUN, not the code failing to check.
          const detail = extractToolError(`${run.stderr}\n${run.stdout}`);
          if (detail) sections.push({ title: 'TypeScript failed to run:', lines: [`  ${detail}`] });
        }
      }
    } catch {
      // see stage 1
    }
  }
} finally {
  releaseLock(lock); // latency only; correctness is lock.mjs's stale-steal
}

// exit 2 + stderr is the only PostToolUse channel that BLOCKS (additionalContext reaches the model
// but cannot stop the turn). Tool failures ride it too, kept honest by their section title so the
// agent never gets a toolchain problem dressed as its bug.
if (sections.length > 0) {
  const report = formatReport(sections, { maxChars: 4000 });
  if (report) block(`Checks after editing ${abs}:\n\n${report}`);
}

allow();
