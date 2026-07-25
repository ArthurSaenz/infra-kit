// Pure parsing/formatting for the edit pipeline's report. No spawning, no fs, no process state —
// so every shape below is unit-testable against a LITERAL captured fixture rather than a
// paraphrase of one. Paraphrase is how the earlier missing-config regex shipped broken: it matched
// the wording someone remembered, not the wording ESLint prints.
//
// Two rules run through everything here:
//   - "The tool failed to run" and "the tool found problems" are different outcomes and must never
//     be collapsed. A crash dump reported as type errors costs the agent a whole wasted cycle.
//   - PARSE-PRESENCE, not the exit code, decides which one it is. Encoding tsc's and eslint's exit
//     taxonomies would be a fresh dependency on undocumented behavior; asking "did anything
//     diagnostic actually parse out of this?" is robust to both tools changing their minds.

// ESLint's `--format json` payload. Tolerant by contract: on status 2 (ESLint's own fatal failure)
// stdout is EMPTY — verified, length 0 — and on a crash it can be anything at all. Both yield "no
// findings" rather than throwing, because a hook that throws here would lose the report entirely,
// including the tsc section that had nothing to do with the failure.
//
// STDOUT IS NOT PURE JSON IN THIS REPO, and assuming it was is how this parser silently reported
// zero findings against every real package while passing every synthetic test. `--format json`
// writes one JSON array, but pnpm's catalog resolution prints lines like
//   Dependency "react" could not be resolved for catalog "default"
// to STDOUT ahead of it. A strict `JSON.parse(stdout)` throws on those, the tolerant path returns
// "no findings", and a genuine `unused-imports/no-unused-vars` error reaches nobody — reinstating
// the exact defect this pipeline was built to close, one layer further down.
//
// So the payload is LOCATED rather than assumed. The search is LINE-ORIENTED, not a slice from the
// first `[` to the last `]`: `--format json` emits the whole array on ONE line, so scanning lines
// for the first that starts with `[` and parses is robust against arbitrary preamble AND postamble.
// A `[`-bearing warning ahead of the payload, or a `]`-bearing one after it, would each defeat the
// bracket-slice — and would defeat it SILENTLY, by returning zero findings, which is the exact
// signature this whole pipeline exists to eliminate. pnpm's warning text is not contractual, so the
// parser must not depend on it staying bracket-free.
//
// Anything that still fails to parse yields no findings, keeping the original tolerance contract.
function extractJsonPayload(stdout) {
  const text = (stdout ?? '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // Not pure JSON — fall through to the line scan.
  }

  for (const line of text.split('\n')) {
    const candidate = line.trim();
    if (!candidate.startsWith('[')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // A noise line that merely begins with a bracket; keep looking.
    }
  }

  return null;
}

export function parseEslintJson(stdout) {
  const payload = extractJsonPayload(stdout);

  if (!Array.isArray(payload)) return { errors: 0, messages: [] };

  const messages = [];
  let errors = 0;

  for (const result of payload) {
    for (const message of result?.messages ?? []) {
      // `--quiet` already drops warnings at the source; this second filter is belt-and-braces for
      // the fatal-parse-error case, which ESLint reports with severity 2 and no ruleId.
      if (message.severity !== 2) continue;
      errors += 1;
      messages.push({
        line: message.line ?? 0,
        column: message.column ?? 0,
        ruleId: message.ruleId ?? null,
        message: message.message ?? '',
        // Present iff ESLint considers the rule auto-fixable. This is the signal that detects a
        // prettier/eslint standoff — see the conflict labelling in edit-pipeline.mjs.
        fixable: message.fix !== undefined,
      });
    }
  }

  return { errors, messages };
}

const TOOL_ERROR_MAX = 300;

// ESLint prints a fixed banner before the substantive line:
//
//     <blank>
//     Oops! Something went wrong! :(
//     <blank>
//     ESLint: 10.7.0
//     <blank>
//     ESLint couldn't find an eslint.config.(js|mjs|cjs) file.
//
// Reporting the first non-empty line verbatim would hand the agent "Oops! Something went wrong! :(",
// which names no cause and suggests no action. Dropping the banner is what makes the one line we
// are allowed to emit the line that actually says something.
export function extractToolError(stderr) {
  const substantive = (stderr ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !/^Oops! Something went wrong/.test(line) && !/^ESLint: \d/.test(line));

  if (!substantive) return null;
  return substantive.length > TOOL_ERROR_MAX
    ? `${substantive.slice(0, TOOL_ERROR_MAX)}…`
    : substantive;
}

// "No flat config in this package" is a normal state for plenty of directories, not a failure, so
// it is the one status-2 case that stays SILENT instead of emitting a line.
//
// Both spellings are covered on purpose. ESLint's current text is "couldn't"; older and
// paraphrased forms say "could not". The character class also tolerates the apostrophe-less
// "couldnt". Tested against the literal captured stderr, never a hand-written approximation.
export function isMissingConfig(stderr) {
  return /could ?n[o']?t find an eslint\.config/i.test(stderr ?? '');
}

// tsc emits diagnostics in TWO shapes, and a parser that knows only the first silently downgrades
// real errors into "tool failure":
//
//   file-scoped:    src/x.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.
//   program-level:  error TS2688: Cannot find type definition file for 'vite/client'.
//
// The program-level form carries no `file(line,col):` prefix — tsc uses it for any whole-program
// condition (missing type roots, bad `types` entries, config-level failures). Verified against real
// output, not inferred.
const RE_TSC_FILE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const RE_TSC_PROGRAM = /^error (TS\d+): (.*)$/;
// An indented non-blank line is a continuation of the diagnostic above it.
const RE_TSC_CONTINUATION = /^\s+\S/;

export function parseTscDiagnostics(stdout) {
  const diagnostics = [];

  for (const raw of (stdout ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');

    const fileMatch = RE_TSC_FILE.exec(line);
    if (fileMatch) {
      diagnostics.push({
        file: fileMatch[1],
        line: Number(fileMatch[2]),
        column: Number(fileMatch[3]),
        code: fileMatch[4],
        message: fileMatch[5],
        details: [],
      });
      continue;
    }

    const programMatch = RE_TSC_PROGRAM.exec(line);
    if (programMatch) {
      diagnostics.push({
        file: null,
        line: null,
        column: null,
        code: programMatch[1],
        message: programMatch[2],
        details: [],
      });
      continue;
    }

    // Continuations attach to the entry above. For TS2688 the continuation lines ("The file is in
    // the program because: / Entry point of type library …") carry the ONLY actionable content —
    // the headline just says a file is missing. Dropping them produces a finding nobody can act on.
    if (RE_TSC_CONTINUATION.test(line) && diagnostics.length > 0) {
      diagnostics.at(-1).details.push(line.trim());
    }
  }

  return diagnostics;
}

export function formatTscDiagnostic(diagnostic) {
  const head =
    diagnostic.file === null
      ? `error ${diagnostic.code}: ${diagnostic.message}`
      : `${diagnostic.file}(${diagnostic.line},${diagnostic.column}): error ${diagnostic.code}: ${diagnostic.message}`;

  return [head, ...diagnostic.details.map((detail) => `    ${detail}`)].join('\n');
}

const TRUNCATION_HINT = 'Full list: pnpm run eslint-check / pnpm run ts-check';

function capLines(lines, maxChars) {
  const kept = [];
  let used = 0;

  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }

  const suppressed = lines.length - kept.length;
  if (suppressed > 0) kept.push(`  … ${suppressed} more suppressed. ${TRUNCATION_HINT}`);
  return kept;
}

// Applied to EVERY section that does not name its own. An uncapped section is not merely untidy —
// it consumes the whole budget and the sections after it vanish, heading and all. Verified: 200
// lint errors plus one type error rendered 3995 chars of lint output with no `TypeScript:` heading
// and no `TS2322` anywhere, ending mid-word. The section that got erased is exactly the one the
// agent most needed, because a type error is the harder of the two to find by hand.
const DEFAULT_SECTION_MAX_CHARS = 2000;

/**
 * Render `[{ title, lines, maxChars? }]` into one bounded stderr report.
 *
 * Every section is capped BEFORE the whole report is, so each is guaranteed a share rather than the
 * first one winning the entire budget. That guarantee is the point: a large run of one kind of
 * finding must never silently erase the other kind.
 */
export function formatReport(sections, { maxChars = 4000 } = {}) {
  const blocks = [];

  for (const section of sections) {
    if (!section.lines?.length) continue;
    const lines = capLines(section.lines, section.maxChars ?? DEFAULT_SECTION_MAX_CHARS);
    blocks.push([section.title, ...lines].join('\n'));
  }

  const report = blocks.join('\n\n');
  if (report.length <= maxChars) return report;

  return `${report.slice(0, maxChars - TRUNCATION_HINT.length - 8)}\n… ${TRUNCATION_HINT}`;
}
