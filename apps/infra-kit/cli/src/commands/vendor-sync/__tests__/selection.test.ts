import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readTargetSelection } from '../selection'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-selection-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const writeConfig = (content: string): void => {
  fs.writeFileSync(path.join(root, 'infra-kit.json'), content)
}

describe('readTargetSelection', () => {
  it('takes every module when the target has no infra-kit.json', () => {
    expect(readTargetSelection(root)).toStrictEqual({ kind: 'all' })
  })

  it('takes every module when infra-kit.json has no vendorTarget block', () => {
    writeConfig('{ "envManagement": { "provider": "doppler" } }')

    expect(readTargetSelection(root)).toStrictEqual({ kind: 'all' })
  })

  it('returns the listed modules, an empty list included', () => {
    writeConfig('{ "vendorTarget": { "modules": ["auth", "web-toolkit"] } }')
    expect(readTargetSelection(root)).toStrictEqual({ kind: 'modules', modules: ['auth', 'web-toolkit'] })

    writeConfig('{ "vendorTarget": { "modules": [] } }')
    expect(readTargetSelection(root)).toStrictEqual({ kind: 'modules', modules: [] })
  })

  it('reports an invalid block and broken JSON instead of syncing everything', () => {
    writeConfig('{ "vendorTarget": { "modules": "auth" } }')
    expect(readTargetSelection(root).kind).toBe('invalid')

    writeConfig('{ "vendorTarget": ')
    expect(readTargetSelection(root)).toMatchObject({
      kind: 'invalid',
      reason: expect.stringContaining('not valid JSON'),
    })
  })
})
