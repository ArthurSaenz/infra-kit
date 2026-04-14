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
     * Print the equivalent CLI command if there was interactive input
     */
    print(): void {
      if (!isInteractive || options.length === 0) {
        return
      }

      const formattedOptions = options
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

      logger.info(`📟 Equivalent command: \npnpm exec infra-kit ${commandName} ${formattedOptions}\n`)
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
