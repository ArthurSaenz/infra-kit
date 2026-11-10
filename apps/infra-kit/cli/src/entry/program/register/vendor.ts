import type { Command } from 'commander'
import process from 'node:process'

import { vendorCheck, vendorCheckMcpTool } from 'src/commands/vendor-check'
import { vendorConfig } from 'src/commands/vendor-config'
import { vendorSync } from 'src/commands/vendor-sync'
import type { CommandCatalogEntry } from 'src/entry/command-catalog/catalog-entry'
import { emit } from 'src/lib/json-output'

const configureVendorConfig = (cmd: Command): Command => {
  return cmd
    .description('Show the machine-local factory config (~/.infra-kit/vendor.json) or scaffold it with --init')
    .option('--init', 'Scaffold ~/.infra-kit/vendor.json (skips if it already exists)')
    .action(async (options) => {
      emit(await vendorConfig({ init: options.init }))
    })
}

const configureVendorCheck = (cmd: Command): Command => {
  return cmd
    .description('Verify vendor/ matches vendor/.sync-manifest.json (self-contained; for any consumer repo)')
    .action(async () => {
      const result = await vendorCheck()

      emit(result)

      if (!result.structuredContent.ok) {
        process.exitCode = 1
      }
    })
}

const configureVendorSync = (cmd: Command): Command => {
  return cmd
    .description(
      'Mirror vendorSource files from the ~/.infra-kit/vendor.json source into every target, from any directory',
    )
    .argument('[targets...]', 'Narrow to these target names from ~/.infra-kit/vendor.json')
    .option('-y, --yes', 'Apply the previewed plan')
    .option('--check', 'Preview only; exit 1 when any target would change')
    .option('--commit', 'Commit exactly the synced paths in each target after it syncs')
    .option('--manifest-only', 'Rewrite vendor/README.md and vendor/.sync-manifest.json only; copy nothing')
    .action(async (targets: string[], options) => {
      const result = await vendorSync({
        targets,
        confirmedCommand: options.yes,
        check: options.check,
        commit: options.commit,
        manifestOnly: options.manifestOnly,
      })

      emit(result)

      const { failed, changed, mode } = result.structuredContent

      if (failed || (mode === 'check' && changed)) process.exitCode = 1
    })
}

/** The `vendor` group. */
export const registerVendorCommands = (program: Command): void => {
  const vendorCmd = program.command('vendor').description('Mirror and verify the vendored starter files')

  configureVendorCheck(vendorCmd.command('check'))
  configureVendorConfig(vendorCmd.command('config'))
  configureVendorSync(vendorCmd.command('sync'))
}

/** Cross-surface metadata of the commands registered above, in palette order. */
export const vendorCatalog: CommandCatalogEntry[] = [
  // --- Vendor (menu group) ---
  {
    cliName: 'vendor-check',
    menuGroup: 'vendor',
    mcpTool: vendorCheckMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['vendor', 'check'],
  },
  {
    cliName: 'vendor-config',
    menuGroup: 'vendor',
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['vendor', 'config'],
  },
  {
    cliName: 'vendor-sync',
    menuGroup: 'vendor',
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['vendor', 'sync'],
  },
  // The bare group: help + a non-zero exit, so it never belongs in the leaf-only menu.
  { cliName: 'vendor', menuGroup: null, mcpTool: null, mcpExposed: false, mutating: false, groupPath: ['vendor'] },
]
