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
  //
  // "taskManager": {
  //   "provider": "jira",
  //   "config": { "baseUrl": "https://acme.atlassian.net", "projectId": 123 }
  // },
  // NOTE: taskManager is validated but NOT yet used — Jira credentials and the project id are read
  // from the JIRA_BASE_URL / JIRA_EMAIL / JIRA_TOKEN / JIRA_PROJECT_ID environment variables
  // (Doppler), never from this file. Editing projectId here changes nothing; change it in Doppler.
  //
  // "worktrees": {
  //   "openInGithubDesktop": false,
  //   "openInOrca": true,
  //   // Orca pane layout for opened worktrees: "two-columns" (default, left | right)
  //   // or "three-pane" (left split top/bottom + full-height right).
  //   "orca": { "layout": "two-columns" }
  // },
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
  // // "local" | "cloud" for this session only. "orca": true runs each launched target
  // // in its own Orca terminal. Omit "apps" entirely to launch every discovered target.
  // "devServersPresets": {
  //   "backend": {
  //     "apps": {
  //       "client/api": { "watchDeps": true, "proxy": { "/api": "local", "/auth": "cloud" } },
  //       "client/ui": {}
  //     },
  //     "orca": true
  //   }
  // },
  //
  // // May this project deploy to the delivery-shaped environments ("prod")? The LIST lives in code
  // // (lib/workflow-envs/protected-envs); this decides only whether THIS project may reach it.
  // //   "disallow"  — the DEFAULT when the key is absent. Filtered out of every deploy picker and
  // //                 refused, on both \`--from local\` and \`--from ci\`. Use
  // //                 \`infra-kit release deliver\`, which also does the RC PR and the Jira version.
  // //   "allow"     — reachable from a human's terminal and from an agent's \`infra-kit --agent\` alike.
  // //   "cli-only"  — reachable from a human's terminal, but NOT under \`--agent\` (or a Claude Code
  // //                 shell): an agent's Bash call carries no human keystroke, so agents keep the
  // //                 refusal.
  // // Allowing it does not remove the other gates: a local deploy still requires the AWS account to
  // // report that environment, and still refuses a dirty tree — unconditionally, with nothing to pass
  // // that waives it. A \`--from ci\` dispatch has no such second gate and prints a warning naming
  // // what it skips.
  // //
  // // It IS honoured from this layer — the merge treats it like any other key — but it belongs in the
  // // committed project infra-kit.json, where a reviewer and \`git blame\` can see it. Setting it here
  // // grants yourself production access with no trace in the repo.
  // "protectedEnvs": "disallow"
  //
  // // MCP servers fronted by \`ik-mcp\`, the credential-agnostic stdio proxy: one entry per server,
  // // naming the command to spawn and the env-var NAMES it reads from the \`ik env-load\` session
  // // file. \`ik setup\` derives a committed \`.mcp.json\` entry from each; \`ik audit\` guards drift.
  // //
  // // PROJECT LAYER ONLY. This key is REFUSED here and in the per-project override — the loader
  // // throws with a message saying so — because it feeds a committed file and the layer merge is
  // // shallow: a per-machine copy would replace the project's servers for everyone. For a
  // // machine-only override of one server (a local fork), use Claude Code's own local scope:
  // //   claude mcp add --scope local <name> -- ik-mcp --name <name> --env <VAR> -- <command> <args>
  // // The proxy is for STATELESS servers: a credential change respawns the child.
  // "mcp": {
  //   "grafana": {
  //     "command": "mcp-grafana",
  //     "args": ["-t", "stdio"],
  //     "env": ["GRAFANA_URL", "GRAFANA_SERVICE_ACCOUNT_TOKEN"],
  //     "unset": ["GRAFANA_API_KEY", "GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE"]
  //   }
  // }
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
 * real `~/.infra-kit/infra-kit.json` by `infra-kit setup`. Documents every top-level
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
// envManagement, ide, taskManager, worktrees, dev, devServersPresets,
// protectedEnvs, mcp (project layer only). The schema is strict — an
// unrecognized top-level key is a parse error, not a silently ignored one.
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
// concatenate. Top-level keys recognized: envManagement, ide, taskManager,
// worktrees, dev, devServersPresets, protectedEnvs, mcp (project layer only —
// refused here). The schema is strict — an unrecognized top-level key is a parse
// error, not a silently ignored one.
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
 * file is scaffolded by `infra-kit vendor config --init`, never seeded by `setup`.
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
