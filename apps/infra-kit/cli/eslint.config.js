import config from '@wl/eslint-config'

/**
 * No-React boundary: the entry/MCP/command code must never STATICALLY import the
 * Ink TUI (or ink/react). The TUI is reached only via dynamic `await import()`
 * from the TTY branch, so React stays off the MCP / `--json` / non-TTY paths.
 * `no-restricted-imports` only flags static imports — dynamic import() is allowed.
 */
const noTuiOnMachinePaths = {
  files: ['src/entry/cli.ts', 'src/entry/mcp.ts', 'src/commands/**/*.ts', 'src/commands/**/*.tsx'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          { name: 'ink', message: 'Do not import ink outside src/tui/* — load the TUI via dynamic import().' },
          { name: 'react', message: 'Do not import react outside src/tui/* — load the TUI via dynamic import().' },
        ],
        patterns: [
          {
            group: ['src/tui', 'src/tui/*', '**/tui', '**/tui/*'],
            message:
              'Do not statically import the Ink TUI from CLI/MCP/command code; use a dynamic import() in the TTY branch.',
          },
        ],
      },
    ],
  },
}

// `config()` returns a Promise resolving to the flat-config array; ESLint awaits
// the default export, so resolve it and append our local boundary rule.
export default config().then((base) => {
  return [...base, noTuiOnMachinePaths]
})
