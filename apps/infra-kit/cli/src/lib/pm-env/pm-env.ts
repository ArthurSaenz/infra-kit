/**
 * `env` minus every package-manager marker a spawned child could mistake for a throwaway install:
 * the whole `npm_*` block plus `PNPM_SCRIPT_SRC_DIR`. The result makes the child look exactly like
 * a direct `node <pkg>/dist/cli.js` run — which it is.
 */
// Any child we launch through `node <bin>` (the portless driver, self-update, the mcp launcher)
// inherits our env, and a tool that sniffs those markers will conclude it was run via `npx`/`pnpm
// dlx` and refuse to work. portless is the motivating case; its guard (cli.js `main()`) is:
//
//     isNpx     = npm_command === 'exec' && !npm_lifecycle_event
//     isPnpmDlx = !!PNPM_SCRIPT_SRC_DIR  && !npm_lifecycle_event
//     if ((isNpx || isPnpmDlx) && !isLocallyInstalled()) -> abort
//
// `isLocallyInstalled()` walks up from the CHILD's cwd, so in a consumer repo (where portless is a
// transitive dep of infra-kit, absent from the root `node_modules`) it is false and the guard is
// live. `pnpm exec infra-kit dev` exports `npm_command=exec` with no lifecycle event, so `isNpx`
// holds, every portless call exits 1, `isAvailable()` is false, and `ensureProxy` aborts the whole
// dev boot with "portless is not installed", on a machine where it plainly is.
//
// `PNPM_SCRIPT_SRC_DIR` must be dropped ALONGSIDE the `npm_*` block, not left behind: it is set by
// `pnpm run <script>`, where `npm_lifecycle_event` is what suppresses `isPnpmDlx`. Stripping only
// `npm_*` removes that suppressor and creates an abort for the script-style invocation that
// previously worked. Both markers go, or neither is safe.
export const withoutPackageManagerEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      return !key.startsWith('npm_') && key !== 'PNPM_SCRIPT_SRC_DIR'
    }),
  )
}

/**
 * npm's own configuration — as opposed to the npx/dlx *markers* above. Case-insensitive because npm reads
 * `npm_config_*` case-insensitively (its parser matches `/^npm_config_/i`) and real environments export
 * both forms: shells write the lowercase name, Dockerfiles and CI images overwhelmingly write the
 * uppercase one.
 */
const NPM_CONFIG_TO_PRESERVE = /^npm_config_(?:prefix|registry)$/i

/**
 * The env for spawning a package-manager INSTALL: npx/dlx markers stripped, but npm's own config
 * kept — specifically `npm_config_prefix` and `npm_config_registry`.
 *
 * @example
 * packageManagerInstallEnv({ npm_command: 'exec', npm_config_prefix: '/p', PATH: '/bin' })
 * // => { npm_config_prefix: '/p', PATH: '/bin' }
 */
// `withoutPackageManagerEnv` is deliberately a blunt `npm_*` prefix filter, and it is the
// right tool for the portless driver — but it is the WRONG tool for spawning an install, because it
// also drops the two variables that tell the package manager where, and from where, to install:
//
//   - `npm_config_prefix` is the npm matcher's ONLY signal (see `install-manager.ts`). Strip it and
//     we detect a global install rooted at prefix P, then run the install with P erased — so it
//     lands in the DEFAULT prefix instead. That is either a permanent EACCES, or a second global
//     copy that is not the one on PATH. Nothing notices: the install exits 0, we report
//     `installed`, the version on PATH never moves, and the whole cycle repeats every window
//     forever. `export npm_config_prefix=~/.npm-global` is npm's own documented EACCES workaround,
//     so this is a mainstream layout, not an exotic one.
//   - `npm_config_registry` is what the update CHECK already used to pick a registry. Dropping it
//     here means we decide against a corporate mirror and then install from somewhere else.
//
// Preserving these cannot re-arm the dlx guard: that guard reads `npm_command`,
// `npm_lifecycle_event` and `PNPM_SCRIPT_SRC_DIR` — none of which are npm config, and all of which
// remain stripped.
export const packageManagerInstallEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const sanitised = withoutPackageManagerEnv(env)

  for (const [key, value] of Object.entries(env)) {
    if (NPM_CONFIG_TO_PRESERVE.test(key)) sanitised[key] = value
  }

  return sanitised
}
