// Blocks recursive force-remove, force push, and SQL drops/truncates. Unanchored, case-sensitive
// substring match — same shape (and same known false-positive) as the original hook.

export const name = 'destructive';

const RE_DESTRUCTIVE = /rm\s+-rf|git push.*--force|drop table|drop database|truncate\s/;

export function check(command) {
  if (RE_DESTRUCTIVE.test(command)) {
    return { action: 'block', message: 'Blocked: destructive command not allowed' };
  }
  return null;
}
