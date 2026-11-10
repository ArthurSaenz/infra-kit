import { configCatalog } from 'src/entry/program/register/config'
import { deployCatalog, deprecatedLocalCatalog } from 'src/entry/program/register/deploy'
import { devCatalog } from 'src/entry/program/register/dev'
import { diagnosticsCatalog } from 'src/entry/program/register/diagnostics'
import { envCatalog } from 'src/entry/program/register/env'
import { releaseCatalog } from 'src/entry/program/register/release'
import { vendorCatalog } from 'src/entry/program/register/vendor'
import { worktreesCatalog } from 'src/entry/program/register/worktrees'

import type { CommandCatalogEntry, MenuGroup } from './catalog-entry'

/**
 * Single source of truth for the CLI command surface, composed from the entries each domain module
 * under `entry/program/register/` declares beside its Commander wiring — so a command is described
 * in one file, and what the palette lists cannot drift from what the program registers.
 *
 * In no-arg-menu display order (see entry/cli.ts): the palette groups by `MENU_GROUPS` and keeps this
 * order within a group. Nothing else reads the order: every other consumer addresses an entry by
 * `cliName` or `groupPath`.
 */
export const commandCatalog: CommandCatalogEntry[] = [
  ...devCatalog,
  ...releaseCatalog,
  ...deprecatedLocalCatalog,
  ...worktreesCatalog,
  ...envCatalog,
  ...configCatalog,
  ...vendorCatalog,
  ...deployCatalog,
  ...diagnosticsCatalog,
]

/**
 * Mutating commands that are DELIBERATELY exempt from the destructive-op confirm gate
 * (`mcpTool.requiresHumanConfirm`) because each is low-risk / reversible.
 *
 * Every command is agent-reachable over `Bash(infra-kit …)`, so the set this guards is `mutating`
 * alone — `mcpExposed` is historical and buys no exemption. Hand-maintained: adding a name here is
 * the ONLY sanctioned way to opt a mutating command out of the gate, and the default-deny test
 * (`command-catalog.test.ts`) reds CI for any mutating command that is neither gated nor listed here.
 * Every member carries a one-line justification so an audit reads at a glance.
 */
export const LOW_RISK_MUTATING_ALLOWLIST: readonly string[] = [
  // Overwrites the Jira fix-version description and the release PR body — reversible by re-editing;
  // no git/branch/deploy side effect.
  'release-edit',
  // Purely additive: creates worktrees for existing release branches; removing them is a separate op.
  'worktrees-add',
  // Reconciles the worktree set to the live release branches; recreatable via worktrees-add.
  'worktrees-sync',
  // Writes a load file under the infra-kit cache dir; cleared by env-clear, no remote/git effect.
  'env-load',
  // Writes one token into the local store; overwritten by the next set; no remote/git effect.
  'env-token-set',
  // Deletes one token from the local store; the Doppler token itself survives and env-token-set puts
  // it back; no remote/git effect.
  'env-token-remove',
  // Write/remove one top-level key in a per-machine override under ~/.infra-kit, kept only if the real
  // loader accepts the result; never the committed infra-kit.json; agents may not touch protectedEnvs.
  'config-set',
  'config-unset',
  // Opens $EDITOR on the per-machine config override under ~/.infra-kit — a human is in the editor;
  // no remote/git effect.
  'config-edit',
  // Scaffolds the vendor config factory under ~/.infra-kit locally; no remote/git effect.
  'vendor-config',
  // Rewrites only clean tracked vendor paths in local target checkouts (dirty ones block the target) and at
  // most commits locally; never pushes, so git undoes it. Still previews, and an agent applies only with `--yes`.
  'vendor-sync',
  // Rewrites only the two generated workflow files in the working tree; never commits or pushes, so
  // git undoes it, and `--check` is the read-only form.
  'deploy-sync',
  // Writes dev-context fragments and portless routes under ~/.infra-kit and runs local servers in the
  // foreground until Ctrl-C; no remote/git effect.
  'dev',
]

/**
 * Catalog entries for a menu group, in catalog (display) order.
 *
 * Yields ENTRIES, not names: every menu surface addresses a command by its {@link
 * CommandCatalogEntry.groupPath} (`['release','create']`), which is both what it renders and what it
 * spawns. `cliName` is an id — the tool name, which cannot hold a space — and is not a CLI surface.
 *
 * @example
 * getMenuGroupEntries('vendor').map((entry) => entry.groupPath.join(' ')) // => ['vendor check', …]
 */
export const getMenuGroupEntries = (group: MenuGroup): CommandCatalogEntry[] => {
  return commandCatalog.filter((entry) => {
    return entry.menuGroup === group
  })
}

/**
 * True when the invoked command runs until the user stops it (see {@link CommandCatalogEntry.longRunning}).
 * Keyed by the SPACE-JOINED Commander path (`'dev'`, `'vendor check'`) so it matches what `commandPath()`
 * hands the `postAction` hook, not the flat alias.
 *
 * @example
 * isLongRunningCommand('dev')          // => true  (no verdict to report; exits 128+signo)
 * isLongRunningCommand('vendor check') // => false
 */
export const isLongRunningCommand = (commandPath: string): boolean => {
  return commandCatalog.some((entry) => {
    return entry.longRunning === true && entry.groupPath.join(' ') === commandPath
  })
}
