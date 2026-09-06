export {
  inspectMcpRegistration,
  isMarketplaceRegistered,
  readInstalledPluginVersion,
  resolvePluginInstall,
} from './install-state'
export type { McpRegistration, PluginInstallation, PluginInstallationQuery, PluginInstallState } from './install-state'
export {
  ensurePluginPointer,
  MARKETPLACE_NAME,
  MARKETPLACE_REPO,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_KEY,
} from './plugin-pointer'
export type { PluginPointerResult, PluginPointerStatus } from './plugin-pointer'
