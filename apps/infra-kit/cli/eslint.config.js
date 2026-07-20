import config from '@wl/eslint-config'

/**
 * No-React boundary: the entry/MCP/command code must never STATICALLY import the
 * Ink TUI (or ink/react). The TUI is reached only via dynamic `await import()`
 * from the TTY branch, so React stays off the MCP / `--json` / non-TTY paths.
 * `no-restricted-imports` only flags static imports — dynamic import() is allowed.
 */
const MACHINE_PATH_GLOBS = [
  'src/entry/cli.ts',
  'src/entry/mcp.ts',
  'src/commands/**/*.ts',
  'src/commands/**/*.tsx',
  // The release-picker shim is the one lib module that legally reaches the TUI —
  // but only through a dynamic import(). Linting it here means an accidental
  // static ink/react/src/tui import fails at edit time, not just in the
  // hand-maintained no-react-boundary test.
  'src/lib/prompts/**/*.ts',
]

/**
 * Stdin ownership: nothing may read stdin outside `withEscape`, the sole caller of the refcount in
 * `src/lib/prompts/stdin-ref.ts`.
 *
 * zx's `question` opens its own readline and acquires no ref. Used after a `withEscape` prompt has
 * released the last reader — which unrefs stdin — the event loop drains MID-PROMPT and node exits
 * with the question still on screen. That was a live bug in `release create`: two wrapped `select`s
 * followed by a raw `question`, and the process died at the third prompt.
 *
 * Only the `question` binding is restricted. `import { $ } from 'zx'` is used by ~30 modules and is
 * unaffected: it never touches stdin.
 */
const zxQuestionRestriction = {
  name: 'zx',
  importNames: ['question'],
  message:
    "zx's `question` reads stdin without acquiring the ref in src/lib/prompts/stdin-ref.ts, so the event loop drains mid-prompt and node exits. Use `input` from '@inquirer/input' wrapped in `withEscape` (src/lib/prompts/escapable-context) instead. Importing `$` from 'zx' is fine.",
}

/**
 * No-React boundary: the entry/MCP/command code must never STATICALLY import the
 * Ink TUI (or ink/react). The TUI is reached only via dynamic `await import()`
 * from the TTY branch, so React stays off the MCP / `--json` / non-TTY paths.
 * `no-restricted-imports` only flags static imports — dynamic import() is allowed.
 */
const noTuiOnMachinePaths = {
  files: MACHINE_PATH_GLOBS,
  rules: {
    'no-restricted-imports': [
      'error',
      {
        // `zxQuestionRestriction` is repeated here rather than left to `noRawStdinReaders` below.
        // Flat config REPLACES a rule's options when two matching objects both set it, so these
        // machine paths only ever see whichever object matched last — they cannot inherit half of
        // each. Every `paths` entry that should apply here has to be present here.
        paths: [
          { name: 'ink', message: 'Do not import ink outside src/tui/* — load the TUI via dynamic import().' },
          { name: 'react', message: 'Do not import react outside src/tui/* — load the TUI via dynamic import().' },
          zxQuestionRestriction,
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

/**
 * The zx `question` ban everywhere `noTuiOnMachinePaths` does NOT already carry it.
 *
 * `ignores` is load-bearing, not tidiness. Flat config REPLACES `no-restricted-imports` when two
 * matching objects both set it — last match wins, whole option object. An earlier version of this
 * scoped `files: ['src/**\/*.ts']`, a strict superset of the machine-path globs, and so silently
 * deleted the ink/react boundary for EVERY `.ts` file under `src/`: a command file could import
 * react and lint stayed green. (It survived `pnpm run qa` — the rule simply stopped existing, which
 * produces no error to notice, and `src/tui/__tests__/no-react-boundary.test.ts` is a nine-file
 * hand-maintained allowlist rather than a sweep, so it did not cover the gap either.)
 *
 * So the two objects' file sets are kept DISJOINT: nothing matches both, and neither can replace the
 * other. `noTuiOnMachinePaths` repeats `zxQuestionRestriction` to cover its own half.
 * `config-boundaries.test.ts` pins the resolved config so this cannot silently regress again.
 *
 * KNOWN LIMITATION, one layer up: `@wl/eslint-config`'s base also sets `no-restricted-imports` (a
 * barrel guard on `**\/features/*\/**` and `**\/services/*\/**`). By the same replacement rule, these
 * two objects supersede it for every file under `src/`. That is inert TODAY — this package has no
 * `features/` or `services/` layout, so the base rule matches nothing here — and it predates this
 * change (`noTuiOnMachinePaths` always superseded it on its own globs). But if anyone ever adds
 * `src/features/` to the CLI, the barrel guard will NOT apply and nothing will announce that. Add
 * those patterns to both objects at that point.
 */
const noRawStdinReaders = {
  files: ['src/**/*.{ts,tsx}'],
  ignores: MACHINE_PATH_GLOBS,
  rules: {
    'no-restricted-imports': ['error', { paths: [zxQuestionRestriction] }],
  },
}

// `config()` returns a Promise resolving to the flat-config array; ESLint awaits
// the default export, so resolve it and append our local boundary rules.
export default config().then((base) => {
  return [...base, noTuiOnMachinePaths, noRawStdinReaders]
})
