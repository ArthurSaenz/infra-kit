/**
 * `env` minus every package-manager marker a spawned child could mistake for a throwaway install.
 *
 * Any child we launch through `node <bin>` (the portless driver, self-update, the mcp launcher) inherits
 * our env, and a tool that sniffs those markers will conclude it was run via `npx`/`pnpm dlx` and refuse
 * to work. portless is the motivating case; its guard (cli.js `main()`) is:
 *
 *     isNpx     = npm_command === 'exec' && !npm_lifecycle_event
 *     isPnpmDlx = !!PNPM_SCRIPT_SRC_DIR  && !npm_lifecycle_event
 *     if ((isNpx || isPnpmDlx) && !isLocallyInstalled()) → abort
 *
 * `isLocallyInstalled()` walks up from the CHILD's cwd, so in a consumer repo (where portless is a
 * transitive dep of infra-kit, absent from the root `node_modules`) it is false and the guard is live.
 * `pnpm exec infra-kit dev` exports `npm_command=exec` with no lifecycle event → `isNpx` → every
 * portless call exits 1 → `isAvailable()` is false → `ensureProxy` aborts the whole dev boot with
 * "portless is not installed", on a machine where it plainly is.
 *
 * `PNPM_SCRIPT_SRC_DIR` must be dropped ALONGSIDE the `npm_*` block, not left behind: it is set by
 * `pnpm run <script>`, where `npm_lifecycle_event` is what suppresses `isPnpmDlx`. Stripping only
 * `npm_*` removes that suppressor and *creates* an abort for the script-style invocation that
 * previously worked. Both markers go, or neither is safe.
 *
 * The result makes the child look exactly like a direct `node <pkg>/dist/cli.js` run — which it is.
 */
export const withoutPackageManagerEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      return !key.startsWith('npm_') && key !== 'PNPM_SCRIPT_SRC_DIR'
    }),
  )
}
