import { logger } from 'src/lib/logger'

interface CommandOption {
  flag: string
  value: string | string[] | boolean
}

const createCommandEcho = () => {
  let cliPath = ''
  let options: CommandOption[] = []
  let isInteractive = false

  return {
    /**
     * Bind the echo to the command about to run, and clear the previous one's recording.
     *
     * `cliPath` must be the argv Commander actually parsed (`release create`), which is why the ONLY
     * caller is program.ts's `preAction` hook, feeding it `commandPath(actionCommand)`. Commands used to
     * name themselves here, and that is precisely how the printed line rotted: they passed the flat
     * `release-create`, which stopped being a command the day the flat aliases were dropped, so the
     * "equivalent command" we told the user to retype no longer parsed. Commander is the only thing that
     * knows the real path, so it is the only thing allowed to say it.
     */
    start(path: string): void {
      cliPath = path
      options = []
      isInteractive = false
    },

    /**
     * Mark that the command had interactive input (prompts)
     * Call this once when ANY prompt happens
     */
    setInteractive(): void {
      isInteractive = true
    },

    /**
     * Track an option selection
     * @param flag The CLI flag (e.g., "--versions")
     * @param value The selected value
     */
    addOption(flag: string, value: string | string[] | boolean): void {
      options.push({ flag, value })
    },

    /**
     * Format the tracked options into a replayable flag string (empty when none).
     */
    formatOptions(): string {
      return options
        .map((opt) => {
          if (typeof opt.value === 'boolean') {
            return opt.value ? opt.flag : ''
          }

          if (Array.isArray(opt.value)) {
            return `${opt.flag} "${opt.value.join(', ')}"`
          }

          return `${opt.flag} "${opt.value}"`
        })
        .filter(Boolean)
        .join(' ')
    },

    /**
     * The recorded interactive flags for the session shell's report side channel, so the transcript's
     * equivalent line carries the resolved options (`--versions "1.2.5"`), not just the bare command.
     * `null` when nothing was recorded — the caller then falls back to the bare spawned argv.
     */
    snapshot(): { formattedOptions: string } | null {
      if (options.length === 0) {
        return null
      }

      return { formattedOptions: this.formatOptions() }
    },

    /**
     * Print the equivalent CLI command if there was interactive input.
     *
     * Silent without a bound `cliPath`: the only caller that binds one is Commander's `preAction`, so an
     * unbound echo means the command ran off the CLI (an MCP tool), where a `pnpm exec` line would be
     * nonsense. Printing a path-less `pnpm exec infra-kit --yes` would be worse than printing nothing.
     */
    print(): void {
      if (!isInteractive || options.length === 0 || !cliPath) {
        return
      }

      logger.info(`📟 Equivalent command: \npnpm exec infra-kit ${cliPath} ${this.formatOptions()}\n`)
    },

    /**
     * Reset state (useful for testing)
     */
    reset(): void {
      cliPath = ''
      options = []
      isInteractive = false
    },
  }
}

// Singleton instance (same pattern as logger)
export const commandEcho = createCommandEcho()
