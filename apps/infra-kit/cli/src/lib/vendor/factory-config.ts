import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

import { USER_CONFIG_DIR_NAME } from 'src/lib/infra-kit-config'

import { FACTORY_CONFIG_FILE, factoryConfigSchema } from './factory-config-schema'
import type { FactoryConfig } from './factory-config-schema'

/**
 * Absolute path to the machine-local factory config (`~/.infra-kit/vendor.json`).
 * Always returned, even when the file does not exist, so callers can surface a
 * "where would it go?" prompt.
 *
 * @example
 * getFactoryConfigPath() // => '/Users/arthur/.infra-kit/vendor.json'
 */
export const getFactoryConfigPath = (): string => {
  return path.join(os.homedir(), USER_CONFIG_DIR_NAME, FACTORY_CONFIG_FILE)
}

/**
 * Expand a leading `~` to the home dir. Absolute paths pass through unchanged.
 * A non-absolute, non-`~` value throws — cwd-relative resolution is ambiguous
 * across CLI vs long-running MCP-server invocations, so we reject it loudly.
 *
 * @example
 * expandTilde('~')          // => '/Users/arthur'
 * expandTilde('~/projects') // => '/Users/arthur/projects'
 * expandTilde('/abs/dir')   // => '/abs/dir'
 * expandTilde('rel/dir')    // throws
 */
export const expandTilde = (p: string): string => {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  if (path.isAbsolute(p)) return p

  throw new Error(`workspaceDir must be absolute or ~-prefixed, got: ${p}`)
}

/**
 * Load and validate the user-global factory config at `~/.infra-kit/vendor.json`.
 * Reads the static JSON with `JSON.parse` (an empty/whitespace-only file is treated
 * as `{}`), then validates against {@link factoryConfigSchema}.
 *
 * Reads the file on every call (no module cache to bust — unlike a `.ts`
 * `import()`, `JSON.parse` always sees the current bytes), so an absent → present
 * transition works within one process: a `--init` scaffold followed by a load
 * succeeds, and a long-running MCP server picks up edits without a restart.
 * Throws an actionable error pointing at `infra-kit vendor-config --init` when the
 * file is absent.
 *
 * @example
 * const { workspaceDir, targets } = await loadFactoryConfig()
 */
export const loadFactoryConfig = async (): Promise<FactoryConfig> => {
  const configPath = getFactoryConfigPath()

  let raw: string

  try {
    raw = await fs.readFile(configPath, 'utf-8')
  } catch {
    throw new Error(
      `Factory config not found at ${configPath}. infra-kit needs a machine-local factory ` +
        `registry to know where your project repos live and which to stamp. Run ` +
        `\`infra-kit vendor-config --init\` to scaffold it, or create it manually as JSON:\n\n` +
        `  {\n` +
        `    "workspaceDir": "~/projects",\n` +
        `    "targets": ["my-repo"]\n` +
        `  }\n`,
    )
  }

  let data: unknown

  try {
    data = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid JSON in vendor.json at ${configPath}: ${(err as Error).message}`)
  }

  const parsed = factoryConfigSchema.safeParse(data)

  if (!parsed.success) {
    throw new Error(`Invalid factory config at ${configPath}: ${z.prettifyError(parsed.error)}`)
  }

  return parsed.data
}
