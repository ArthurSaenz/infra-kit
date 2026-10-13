import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getInfraKitConfig } from 'src/lib/infra-kit-config'

import { readDefaultEnv } from '../default-env'

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

beforeEach(() => {
  vi.mocked(getInfraKitConfig).mockReset()
})

describe('readDefaultEnv', () => {
  it('returns the merged defaultEnv', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({ defaultEnv: 'roman' } as never)

    expect(await readDefaultEnv()).toBe('roman')
  })

  it('returns null when no layer sets it', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({} as never)

    expect(await readDefaultEnv()).toBeNull()
  })

  it('returns null instead of throwing on an unreadable config', async () => {
    vi.mocked(getInfraKitConfig).mockRejectedValue(new Error('Invalid infra-kit.json'))

    expect(await readDefaultEnv()).toBeNull()
  })
})
