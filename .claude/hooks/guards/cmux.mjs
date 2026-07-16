// Dev servers must run inside a cmux session (so they survive and stay inspectable). Blocks
// `pnpm dev` / `pnpm run dev` unless the command already mentions cmux.

export const name = 'cmux';

export function check(command) {
  const startsDevServer = /pnpm dev|pnpm run dev/.test(command);
  if (startsDevServer && !command.includes('cmux')) {
    return {
      action: 'block',
      message: 'Dev servers must run in cmux. Use: cmux new-session -d -s dev "pnpm dev"',
    };
  }
  return null;
}
