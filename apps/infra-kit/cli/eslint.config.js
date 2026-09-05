import ikPlugin from '@slip-stream-kit/eslint-plugin'

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
  // The session shell is the eager CLI chunk: it must not statically depend on the lazily-imported
  // Ink tree, even for a React-free leaf like suspendForeground — see its module doc.
  'src/lib/session/**/*.ts',
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

/**
 * Turn on `@wl/max-jsdoc-lines` as an error across all CLI source. This is a severity change only:
 * the plugin is already registered for these files through `wl.configs.recommended` (the base config
 * this file imports as `config()`), which leaves the rule off. No plugin registration and no
 * dependency change happen here. It landed at `warn` first (113 findings, 2026-09-05), was cleaned
 * to zero with no inline disables, and only then flipped to `error` — see
 * docs/comment-review-skill-plan.md §9 for the numbers.
 *
 * Flat config REPLACES a rule's options when two matching objects both set the same rule — last
 * match wins, whole option object (see `noTuiOnMachinePaths` above, and the history it records of a
 * boundary rule silently deleted by exactly this mechanism). This object is safe from that failure
 * mode because no other object in this file sets `@wl/max-jsdoc-lines`, so it only ever composes
 * with the base config instead of replacing anything.
 */
const enableMaxJsdocLines = {
  files: ['src/**/*.{ts,tsx}'],
  rules: {
    '@wl/max-jsdoc-lines': 'error',
  },
}

/**
 * Registers the WORKSPACE plugin `apps/infra-kit/eslint-plugin` under its own `@ik` namespace and
 * turns on `@ik/max-jsdoc-summary-lines` as a warning across all CLI source.
 *
 * Why a second namespace rather than adding the rule to `@wl`. The base config imported above as
 * `config()` registers the PUBLISHED `@wl/eslint-plugin` (the lockfile resolves 0.1.23) under `@wl`.
 * The workspace copy is 0.4.0 and carries rules 0.1.23 does not ship, `max-jsdoc-summary-lines`
 * among them, so the rule cannot be reached through `@wl` at all. Registering the workspace build as
 * a SECOND `@wl` would be a flat-config plugin redefinition — the same namespace bound to a
 * different object, which throws — and it would also erase, at a glance, which of the two builds any
 * given `@wl/...` rule came from. `@ik` keeps the two apart and makes the source of every rule
 * legible from its name: `@wl/...` is the published plugin, `@ik/...` is this repo's own.
 *
 * `workspace:*` in this package's devDependencies means the link resolves to
 * `apps/infra-kit/eslint-plugin/dist/`, so a rule edit takes effect here only after that package is
 * rebuilt. Editing `src/` alone changes nothing that ESLint sees.
 *
 * `warn`, not `error`, matching the staging `enableMaxJsdocLines` above uses: the rule is new and its
 * findings across this package have not been triaged, so it must not fail `eslint-check` yet.
 *
 * Flat config REPLACES a rule's options when two matching objects both set the same rule — last
 * match wins, whole option object (see `noTuiOnMachinePaths` above and the boundary rule it records
 * being silently deleted by exactly that mechanism). This object is safe from it: no other object in
 * this file, and nothing in the base config, sets either the `@ik` plugin key or any `@ik/...` rule,
 * so it only ever composes.
 */
const enableMaxJsdocSummaryLines = {
  files: ['src/**/*.{ts,tsx}'],
  plugins: {
    '@ik': ikPlugin,
  },
  rules: {
    '@ik/max-jsdoc-summary-lines': 'warn',
  },
}

// `config()` returns a Promise resolving to the flat-config array; ESLint awaits
// the default export, so resolve it and append our local boundary rules.
export default config().then((base) => {
  return [...base, noTuiOnMachinePaths, noRawStdinReaders, enableMaxJsdocLines, enableMaxJsdocSummaryLines]
})
