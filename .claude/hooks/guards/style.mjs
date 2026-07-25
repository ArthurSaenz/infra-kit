// Tool preferences with no correctness consequence: rg is faster than grep and find, and that is
// the whole of the argument. Nothing breaks if the model reaches for grep, so this ADVISES and
// never blocks — the split from `package-manager` is exactly this distinction. Blocking a tool call
// to deliver a performance tip is the anti-pattern the hook docs warn about: it burns a turn on the
// hot path, and the model learns nothing it could not have been told inline.
//
// Reads the WHOLE line, so it must not export `scope = 'segment'`. The `(?!.*\|)` lookahead below
// is a deliberate allowance for `grep foo | wc -l` — grep as a pipe stage is idiomatic and rg is no
// better there. Segmenting would hand this guard `grep foo` with the pipe already stripped off, and
// the allowance would invert into a nag on exactly the form it means to permit.

export const name = 'style';

const SUGGESTIONS = [
  [/^grep\b(?!.*\|)/, "Prefer 'rg' (ripgrep) over 'grep' — faster, and it respects .gitignore."],
  [/^find\s+\S+\s+-name\b/, "Prefer 'rg --files | rg pattern' over 'find -name'."],
];

export function check(command) {
  const tips = SUGGESTIONS.filter(([re]) => re.test(command)).map(([, tip]) => `* ${tip}`);
  if (tips.length > 0) {
    return { action: 'advise', context: tips.join('\n') };
  }
  return null;
}
