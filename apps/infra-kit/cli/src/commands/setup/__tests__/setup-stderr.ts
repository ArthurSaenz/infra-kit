import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'
import { vi } from 'vitest'

import type { PortlessServiceDeps } from 'src/commands/setup'
import { fakeLinkFs, fakeNodeFs } from 'src/dev/proxy/__tests__/portless-link-fixtures'
import { logger } from 'src/lib/logger'

/**
 * `setup` writes to stderr two ways: streamed lines through the (mocked) logger, and the report in one
 * raw `process.stderr.write`. Order between them is what several suites assert, so both are merged here
 * by invocation order into the lines a human would read.
 */

/** Swallow the report so it neither reaches the test output nor escapes the spy. Call after any `restoreAllMocks`. */
export const captureStderr = (): void => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => {
    return true
  })
}

interface Written {
  order: number
  text: string
}

const asText = (value: unknown): string => {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const loggerCalls = (): Written[] => {
  return [vi.mocked(logger.info).mock, vi.mocked(logger.warn).mock].flatMap((mock) => {
    return mock.calls.map((call, index) => {
      return { order: mock.invocationCallOrder[index] ?? 0, text: asText(call[0]) }
    })
  })
}

const reportCalls = (): Written[] => {
  const { mock } = vi.mocked(process.stderr.write)

  return mock.calls.map((call, index) => {
    return {
      order: mock.invocationCallOrder[index] ?? 0,
      text: stripVTControlCharacters(String(call[0])).replace(/\n$/, ''),
    }
  })
}

/** Every stderr line, colour stripped, in the order it was written. */
export const stderrLines = (): string[] => {
  return [...loggerCalls(), ...reportCalls()]
    .sort((a, b) => {
      return a.order - b.order
    })
    .flatMap((written) => {
      return written.text.split('\n')
    })
}

/** Only the report's lines. */
export const reportLines = (): string[] => {
  return reportCalls().flatMap((written) => {
    return written.text.split('\n')
  })
}

/**
 * A machine with no portless and a checkout install: all three portless rows are `skipped`, so a test
 * about the other steps is not coloured by whatever this host's real service file says.
 */
export const noPortless = (): PortlessServiceDeps => {
  const home = '/nowhere'
  const isGlobal = (): boolean => {
    return false
  }

  return {
    link: {
      resolveBin: () => {
        return null
      },
      isGlobal,
      home,
      fs: fakeLinkFs(),
    },
    node: {
      isGlobal,
      home,
      execPath: '/opt/node/bin/node',
      version: process.version,
      arch: process.arch,
      platform: 'darwin',
      fs: fakeNodeFs(),
    },
    target: {
      home,
      isGlobal,
      exists: () => {
        return false
      },
      processStartTime: () => {
        return null
      },
    },
  }
}
