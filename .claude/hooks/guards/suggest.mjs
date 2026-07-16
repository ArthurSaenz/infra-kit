// Nudges toward rg over grep/find and pnpm over npm/yarn. Blocks (exit 2) listing every match —
// same behavior as the original Python hook.

export const name = 'suggest';

const SUGGESTIONS = [
  [/^grep\b(?!.*\|)/, "Use 'rg' (ripgrep) instead of 'grep' for better performance"],
  [/^find\s+\S+\s+-name\b/, "Use 'rg --files | rg pattern' instead of 'find -name'"],
  [/^npm\s+(install|run|test)/, "Use 'pnpm' instead of 'npm' in this project"],
  [/^yarn\s+(add|run|test)/, "Use 'pnpm' instead of 'yarn' in this project"],
];

export function check(command) {
  const issues = SUGGESTIONS.filter(([re]) => re.test(command)).map(([, msg]) => `* ${msg}`);
  if (issues.length > 0) {
    return { action: 'block', message: issues.join('\n') };
  }
  return null;
}
