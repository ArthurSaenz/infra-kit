import { logger } from 'src/lib/logger'

interface CommandOption {
  flag: string
  value: string | string[] | boolean
}

const createCommandEcho = () => {
  let commandName = ''
  let options: CommandOption[] = []
  let isInteractive = false

  return {
    /**
     * Initialize command echo for a new command
     */
    start(name: string): void {
      commandName = name
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
     * Print the equivalent CLI command if there was interactive input
     */
    print(): void {
      if (!isInteractive || options.length === 0) {
        return
      }

      logger.info(`📟 Equivalent command: \npnpm exec infra-kit ${commandName} ${this.formatOptions()}\n`)
    },

    /**
     * Reset state (useful for testing)
     */
    reset(): void {
      commandName = ''
      options = []
      isInteractive = false
    },
  }
}

// Singleton instance (same pattern as logger)
export const commandEcho = createCommandEcho()
