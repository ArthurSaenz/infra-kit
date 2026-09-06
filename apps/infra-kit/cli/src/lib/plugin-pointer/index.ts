export {
  CLAUDE_VERSION_ARGV,
  defaultClaudeRunner,
  installPluginForProject,
  MARKETPLACE_ADD_ARGV,
  PLUGIN_INSTALL_ARGV,
} from './install-plugin'
export type { ClaudeCommand, ClaudeCommandResult, ClaudeRunner, PluginInstallOutcome } from './install-plugin'
export {
  inspectMcpRegistration,
  isMarketplaceRegistered,
  readInstalledPluginVersion,
  resolvePluginInstall,
} from './install-state'
export type { McpRegistration, PluginInstallState } from './install-state'
export {
  ensurePluginPointer,
  MARKETPLACE_ADD_COMMAND,
  MARKETPLACE_NAME,
  MARKETPLACE_REPO,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_KEY,
} from './plugin-pointer'
export type { PluginPointerResult } from './plugin-pointer'
