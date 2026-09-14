export { CLAUDE_VERSION_ARGV, defaultClaudeRunner, PLUGIN_UPDATE_ARGV } from './claude-cli'
export type { ClaudeCommand, ClaudeCommandResult, ClaudeRunner } from './claude-cli'
export { installPluginForProject, MARKETPLACE_ADD_ARGV, PLUGIN_INSTALL_ARGV } from './install-plugin'
export type { PluginInstallOutcome } from './install-plugin'
export {
  isMarketplaceRegistered,
  listProjectPluginInstallations,
  readInstalledPluginVersion,
  resolvePluginInstall,
} from './install-state'
export type { PluginInstallation, PluginInstallState } from './install-state'
export { inspectLegacyMcpRegistration, isInfraKitServerEntry } from './mcp-registration'
export type { McpRegistration } from './mcp-registration'
export { MARKETPLACE_NAME, MARKETPLACE_REPO, PLUGIN_KEY } from './names'
export {
  ensurePluginPointer,
  MARKETPLACE_ADD_COMMAND,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_UPDATE_COMMAND,
} from './plugin-pointer'
export type { PluginPointerResult } from './plugin-pointer'
