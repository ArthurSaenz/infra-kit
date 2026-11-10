import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DevContextStore } from '../dev-context-store'

let dir = ''

const app = { name: 'shop', packageName: 'shop-api', path: '' }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-dev-context-'))
  app.path = dir
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('devContextStore', () => {
  it('writes the fragment under the app name, with the bound port and the alias origin, leaving no temp file', () => {
    const contextDir = path.join(dir, '.infra-kit', 'dev-context')

    new DevContextStore(contextDir).write(app, 4010, 'main.shop-api.repo.localhost')

    expect(fs.readdirSync(contextDir)).toEqual(['shop.json'])
    expect(JSON.parse(fs.readFileSync(path.join(contextDir, 'shop.json'), 'utf-8'))).toMatchObject({
      package: 'shop-api',
      port: 4010,
      pid: process.pid,
      alias: 'main.shop-api.repo.localhost',
      origin: 'https://main.shop-api.repo.localhost',
    })
  })

  it('removes only its own app fragment, and tolerates one that is already gone', () => {
    const contextDir = path.join(dir, 'ctx')
    const store = new DevContextStore(contextDir)

    store.write(app, 1, 'a.localhost')
    fs.writeFileSync(path.join(contextDir, 'other.json'), '{}')

    store.remove(app)
    store.remove(app)

    expect(fs.readdirSync(contextDir)).toEqual(['other.json'])
  })
})
