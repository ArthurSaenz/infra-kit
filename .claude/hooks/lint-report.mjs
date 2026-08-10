// Pure parsing/formatting for the edit pipeline's report. Two rules throughout: "failed to run" and
// "found problems" are never collapsed, and PARSE-PRESENCE decides which, not the exit code.

// Must never throw: status 2 gives empty stdout, a crash gives anything.
// pnpm's catalog warnings precede the array on stdout, so a strict parse fails. Line-oriented,
// not a `[`-to-`]` slice — the array is one line and a bracket in the noise would defeat a slice.
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
      // Belt-and-braces past `--quiet`, for fatal parse errors (severity 2, no ruleId).
      if (message.severity !== 2) continue;
      errors += 1;
      messages.push({
        line: message.line ?? 0,
        column: message.column ?? 0,
        ruleId: message.ruleId ?? null,
        message: message.message ?? '',
        fixable: message.fix !== undefined, // detects the prettier/eslint standoff, see edit-pipeline

      });
    }
  }

  return { errors, messages };
}

const TOOL_ERROR_MAX = 300;

// Skips ESLint's banner ("Oops! Something went wrong! :(" / "ESLint: 10.7.0"), which names no cause
// and would otherwise be the one line we emit.
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

// A normal state, not a failure — the one status-2 case that stays silent. ESLint prints "couldn't";
// the class also covers "could not" and "couldnt".
export function isMissingConfig(stderr) {
  return /could ?n[o']?t find an eslint\.config/i.test(stderr ?? '');
}

// Prefix is optional: tsc omits `file(line,col):` for whole-program conditions like TS2688.
// `^\S` and the lazy `\S.*?` both reject leading whitespace — without that an indented
// continuation reads as a diagnostic. Cost: a path starting with a space yields no blocks.
const RE_TSC_HEAD = /^(?:\S.*?\(\d+,\d+\): )?error TS\d+: /;
// Indented non-blank => continuation. For TS2688 these carry the only actionable content.
const RE_TSC_CONTINUATION = /^\s+\S/;

export function splitTscBlocks(stdout) {
  const blocks = [];
  // `\s` matches a BOM, so an unstripped one would hide the first diagnostic entirely.
  const text = (stdout ?? '').replace(/^\uFEFF/, '');

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');

    if (RE_TSC_HEAD.test(line)) blocks.push(line);
    else if (RE_TSC_CONTINUATION.test(line) && blocks.length > 0) {
      blocks[blocks.length - 1] += `\n${line}`;
    }
  }

  return blocks;
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

// Uncapped, one section eats the budget and the rest vanish: 200 lint errors rendered 3995 chars
// with no `TypeScript:` heading at all.
const DEFAULT_SECTION_MAX_CHARS = 2000;

// Sections are capped BEFORE the report is, so each gets a share rather than the first taking all.
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
