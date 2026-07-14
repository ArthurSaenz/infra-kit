/**
 * The annotated JSONC reference templates for every infra-kit config file, in one
 * place. Extracted from `commands/init` (layers 2 + vendor) and `commands/config`
 * (layer 3), which each carried a private copy that drifted out of sync with the
 * schema.
 *
 * PURE by construction: strings only, zero I/O — no `node:fs`, `node:os` or
 * `node:path` here. Callers own the writing; this module owns the words. That is
 * what lets `config-templates.test.ts` diff the templates against
 * `infraKitConfigObject.shape` with no filesystem fakes.
 */

/**
 * The real config files are strict JSON and cannot carry comments, so every seeded
 * `infra-kit.json` starts life as an empty-but-valid object; the guidance lives in
 * the non-loaded `.example.jsonc` sibling built below.
 */
export const CONFIG_STUB = '{}\n'

// The documented key set, shared verbatim by the layer-2 (user-global) and layer-3
// (user-project) examples so the two can never disagree about what the schema is.
// Covers ALL eight top-level keys of `infraKitConfigObject` — `config-templates.test.ts`
// fails the build if a ninth is added to the schema and not documented here.
//
// Every line is a `//` comment: the surrounding braces are the only live JSON, so the
// file always parses to `{}` once the comments are stripped.
const CONFIG_KEY_DOCS = `  // "envManagement": {                            // required in layer 1; provider-tagged
  //   "provider": "doppler",
  //   "config": { "name": "my-doppler-project" }
  // },
  //
  // "ide": {
  //   "provider": "cursor",
  //   "config": { "workspaceConfigPath": "/path/to/your.code-workspace" }
  // },
  // // Or, for Zed (no workspace file — one window with all worktrees via "zed <root> <wt...>"):
  // "ide": { "provider": "zed", "config": {} },
  // // Or drive BOTH editors at once with an array (at most one entry per provider):
  // "ide": [
  //   { "provider": "cursor", "config": { "workspaceConfigPath": "/path/to/your.code-workspace" } },
  //   { "provider": "zed", "config": {} }
  // ],
  //
  // "taskManager": {
  //   "provider": "jira",
  //   "config": { "baseUrl": "https://acme.atlassian.net", "projectId": 123 }
  // },
  //
  // "worktrees": {
  //   "openInGithubDesktop": false,
  //   "openInCmux": true,
  //   // cmux pane layout for opened worktrees: "two-columns" (default, left | right)
  //   // or "three-pane" (left split top/bottom + full-height right).
  //   "cmux": { "layout": "two-columns" }
  // },
  //
  // // Auto-load Doppler env when working inside this project/worktree. Omit to
  // // disable. "trigger" (pick one): "shell-startup" (new shells) | "cli-invocation"
  // // (before each infra-kit command, primes subsequent commands). "config" is the
  // // environment to load — must have a service token (infra-kit env-token-set) or
  // // auto-load quietly disables. Requires the committed infra-kit.json at the git
  // // repo root, and the zsh shell integration (infra-kit init + a new shell). zsh only.
  // "envAutoLoad": { "trigger": "shell-startup", "config": "dev" },
  //
  // // Per-app local-dev overrides, keyed by APP FOLDER name (the directory under
  // // apps/). Both fields optional: "port" pins the local listen port (otherwise
  // // <APP>_PORT / PORT / a built-in default), "prefixUrl" pins the URL prefix the
  // // app is served under. An unknown app name is ignored at resolve time, never a
  // // parse error.
  // "dev": {
  //   "client": { "port": 4001, "prefixUrl": "/api" }
  // },
  //
  // // Named \`infra-kit dev <preset>\` sessions. The keys under "apps" are PACKAGES —
  // // "<app>/api" or "<app>/ui". A bare "<app>" is a FOLDER, not a package, and is
  // // REJECTED. Per target: "watchDeps" (api targets) rebuilds the shared-package
  // // dependency closure and restarts on change; "proxy" maps a route path to
  // // "local" | "cloud" for this session only. "cmux": true runs each launched target
  // // in its own cmux pane. Omit "apps" entirely to launch every discovered target.
  // "devServersPresets": {
  //   "backend": {
  //     "apps": {
  //       "client/api": { "watchDeps": true, "proxy": { "/api": "local", "/auth": "cloud" } },
  //       "client/ui": {}
  //     },
  //     "cmux": true
  //   }
  // },
  //
  // // DEPRECATED — accepted but IGNORED; safe to delete. Remove it and this note in a
  // // future release.
  // //
  // // The proxy port is no longer configurable. Every dev URL is now
  // // https://<release>.<package>.localhost with NO port, and the only port that can
  // // serve a port-free HTTPS URL is 443 — so a setting here could only put the port
  // // back into the URL. Set up the daemon once (the install is the only step needing
  // // root; trusting its local CA does not). Run \`infra-kit doctor\`: it checks both and
  // // prints each fix as a command you can paste, with the paths filled in for your
  // // machine. Do not type a bare \`portless\` — it lives in node_modules, not on PATH.
  // // infra-kit itself never elevates.
  // "devProxy": { "port": 443 }
  //
  // // Doppler SERVICE TOKENS are not a config key and never belong in this file. They live in
  // // tokens.json — a SIBLING of this file, at ~/.infra-kit/projects/<repo>/tokens.json (mode 0600) —
  // // shaped { "envs": { "<env>": "dp.st…" } }. Write it with \`infra-kit env-token-set <env>\` (which
  // // also fixes its modes), or by hand: both are supported, which is why the store carries no
  // // repo-identity field and no mandatory version. Pasting a token into an
  // // infra-kit.json (any layer) is REJECTED: the loader refuses to parse it and tells you to revoke
  // // the token first, because a config file can be committed, backed up by your editor, or shared.`

/**
 * Annotated JSONC reference for the user-global (layer 2) config, written next to the
 * real `~/.infra-kit/infra-kit.json` by `infra-kit init`. Documents every top-level
 * key of the schema.
 *
 * @example
 * buildUserGlobalExample()
 * // => '// infra-kit user-global config — ~/.infra-kit/infra-kit.json\n…\n{\n  // "envManagement": …\n}\n'
 */
export const buildUserGlobalExample = (): string => {
  return `// infra-kit user-global config — ~/.infra-kit/infra-kit.json
//
// Merge chain (later layers override earlier ones at top-level keys):
//   1. <repo>/infra-kit.json                            — committed project config (required)
//   2. ~/.infra-kit/infra-kit.json                      — user-global (the sibling of this file)
//   3. ~/.infra-kit/projects/<repo-name>/infra-kit.json — user-scope per-project override
//
// Merge is shallow: setting a top-level key replaces that whole section from
// layer 1. Arrays do not concatenate. Top-level keys recognized:
// envManagement, ide, taskManager, worktrees, envAutoLoad, dev,
// devServersPresets, devProxy. The schema is strict — an unrecognized top-level
// key is a parse error, not a silently ignored one.
//
// This .example.jsonc is reference only — it is NOT loaded. Put real global
// overrides in the sibling infra-kit.json (strict JSON: no comments, double-quoted
// keys). Per-project tweaks belong in layer 3 — run \`infra-kit config edit\`.
//
// Every recognized key is documented below. NOTE: \`envManagement\` is REQUIRED in
// the committed project infra-kit.json (layer 1) and is usually NOT set in this
// user-global layer — it is shown here only to document the full, valid config shape.
{
${CONFIG_KEY_DOCS}
}
`
}

/**
 * Annotated JSONC reference for the user-scope per-project override (layer 3), written
 * alongside the real `~/.infra-kit/projects/<projectName>/infra-kit.json`. Same key
 * documentation as layer 2 — only the header differs. Deterministic: the project name
 * is the only input, and no path or timestamp from the host leaks into the output.
 *
 * @example
 * buildUserProjectExample('hulyo-monorepo')
 * // => '// infra-kit user override for hulyo-monorepo — ~/.infra-kit/projects/hulyo-monorepo/infra-kit.json\n…'
 */
export const buildUserProjectExample = (projectName: string): string => {
  return `// infra-kit user override for ${projectName} — ~/.infra-kit/projects/${projectName}/infra-kit.json
//
// Layer 3 (highest precedence) of the config merge chain. Shallow-merged on top of
// <repo>/infra-kit.json (layer 1) and ~/.infra-kit/infra-kit.json (layer 2) — a
// top-level key set here replaces that whole section wholesale; arrays do not
// concatenate. Top-level keys recognized: envManagement, ide,
// taskManager, worktrees, envAutoLoad, dev, devServersPresets, devProxy. The schema
// is strict — an unrecognized top-level key is a parse error, not a silently ignored
// one.
//
// This .example.jsonc is reference only — it is NOT loaded. Put real overrides
// in the sibling infra-kit.json (strict JSON: no comments, double-quoted keys).
//
// Every recognized key is documented below. NOTE: \`envManagement\` is REQUIRED in
// the committed project infra-kit.json (layer 1) and is usually NOT set in this
// override layer — it is shown here only to document the full, valid config shape.
{
${CONFIG_KEY_DOCS}
}
`
}

/**
 * Annotated JSONC reference for the machine-local factory registry
 * (`~/.infra-kit/vendor.json`). Independent of the infra-kit.json merge chain: the real
 * file is scaffolded by `infra-kit vendor config --init`, never seeded by `init`.
 *
 * @example
 * buildVendorExample()
 * // => '// infra-kit factory registry — ~/.infra-kit/vendor.json\n…\n{\n  // "workspaceDir": …\n}\n'
 */
export const buildVendorExample = (): string => {
  return `// infra-kit factory registry — ~/.infra-kit/vendor.json
//
// Machine-local registry the vendor commands (sync/manifest/diff) read to know
// where your project repos live and which ones to stamp. This .example.jsonc is
// reference only — it is NOT loaded. The real file is the strict-JSON sibling
// vendor.json (no comments, double-quoted keys); run \`infra-kit vendor config --init\`
// to scaffold it.
{
  // "workspaceDir": "~/projects",   // string (absolute or ~-prefixed) — where target repos are cloned
  // "targets": ["my-repo-a", "my-repo-b"]   // string[] (>=1) — repo dir names resolved under workspaceDir
}
`
}
