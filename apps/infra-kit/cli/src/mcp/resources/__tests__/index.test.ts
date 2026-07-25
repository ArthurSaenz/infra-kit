import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'

import type { InfraKitConfig } from 'src/lib/infra-kit-config'

import type { ResourceDeps } from '..'
import { CONFIG_RESOURCE_URI, DEV_CONTEXT_RESOURCE_URI, initializeResources } from '..'
import type { DevContextSnapshot } from '../dev-context'

/** Reach into the SDK's private resource registry to assert what was registered. */
interface RegisteredResource {
  name: string
  readCallback: (uri: URL, extra: unknown) => Promise<{ contents: { uri: string; text: string }[] }>
}

const registeredOf = (server: McpServer): Record<string, RegisteredResource> => {
  return (server as unknown as { _registeredResources: Record<string, RegisteredResource> })._registeredResources
}

/** Read one registered resource back through its handler and parse the JSON body. */
const readResource = async (server: McpServer, uri: string): Promise<unknown> => {
  const resource = registeredOf(server)[uri]!
  const result = await resource.readCallback(new URL(uri), {})

  return JSON.parse(result.contents[0]!.text)
}

const fakeConfig = { environments: ['dev'] } as unknown as InfraKitConfig

const emptyDevContext: DevContextSnapshot = { session: 'none', fragmentDir: undefined, readAt: 0, apps: [] }

const makeDeps = (overrides: Partial<ResourceDeps> = {}): ResourceDeps => {
  return {
    loadConfig: async () => {
      return fakeConfig
    },
    readDevContext: () => {
      return emptyDevContext
    },
    ...overrides,
  }
}

const newServer = (): McpServer => {
  return new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { resources: {} } })
}

describe('initializeResources', () => {
  it('registers at least one resource (proves it is no longer a no-op)', async () => {
    const server = newServer()

    await initializeResources(server, makeDeps())

    const uris = Object.keys(registeredOf(server))

    expect(uris.length).toBeGreaterThanOrEqual(1)
    expect(uris).toContain(CONFIG_RESOURCE_URI)
    expect(uris).toContain(DEV_CONTEXT_RESOURCE_URI)
  })

  it('resolves the config resource to the merged config from the loader', async () => {
    const server = newServer()

    await initializeResources(server, makeDeps())

    expect(await readResource(server, CONFIG_RESOURCE_URI)).toEqual(fakeConfig)
  })

  it('resolves the config resource to an error payload (never throws) when the loader fails', async () => {
    const server = newServer()

    await initializeResources(
      server,
      makeDeps({
        loadConfig: async () => {
          throw new Error('infra-kit.json not found at /nope')
        },
      }),
    )

    expect(await readResource(server, CONFIG_RESOURCE_URI)).toEqual({ error: 'infra-kit.json not found at /nope' })
  })

  it('resolves the dev-context resource cleanly when no dev session is active', async () => {
    const server = newServer()

    await initializeResources(server, makeDeps())

    expect(await readResource(server, DEV_CONTEXT_RESOURCE_URI)).toMatchObject({ session: 'none', apps: [] })
  })

  it('resolves the dev-context resource to the active session snapshot', async () => {
    const server = newServer()
    const active: DevContextSnapshot = {
      session: 'active',
      fragmentDir: '/repo/.infra-kit/dev-context',
      readAt: 123,
      apps: [
        {
          app: 'backend',
          package: '@acme/backend',
          port: 4001,
          alias: 'a',
          origin: 'http://127.0.0.1:4001',
          release: 'main',
          pid: 9,
          writtenAt: 100,
          mtimeMs: 100,
          ageMs: 5,
        },
      ],
    }

    await initializeResources(
      server,
      makeDeps({
        readDevContext: () => {
          return active
        },
      }),
    )

    expect(await readResource(server, DEV_CONTEXT_RESOURCE_URI)).toMatchObject({
      session: 'active',
      apps: [{ app: 'backend', port: 4001 }],
    })
  })
})
