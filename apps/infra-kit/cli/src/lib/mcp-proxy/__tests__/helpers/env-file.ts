/**
 * Mirrors `shellSingleQuote` in `src/commands/env-load/env-load.ts`, which is the encoder
 * every fixture here has to match.
 *
 * Defined once rather than in each test file: two independent copies drift apart, and the
 * real one is not imported because `env-load.ts` drags `zx` and `@inquirer/select` into
 * the module graph of what are otherwise pure unit tests.
 */
export const quoteEnvValue = (value: string): string => {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** An `env-load.sh` body: the `set -a` wrapper `env-load` writes, around `lines`. */
export const envFileBody = (lines: readonly string[]): string => {
  return `${['set -a', ...lines, 'set +a'].join('\n')}\n`
}

/** The two assignments the shim needs, encoded exactly as `env-load` would write them. */
export const credentialLines = (url: string, token: string): string[] => {
  return [`GRAFANA_URL=${quoteEnvValue(url)}`, `GRAFANA_SERVICE_ACCOUNT_TOKEN=${quoteEnvValue(token)}`]
}
