import { atom } from 'jotai'
import type { GetThingFxArgs } from './types'

export const $data = atom<string | null>(null)

// Derived atom sitting directly above a write-only atom - the layout the skill
// itself recommends. Must NOT be classified as an async write-only atom.
export const $hasData = atom((get) => get($data) !== null)

export const getThingFx = atom(null, async (get, set, args: GetThingFxArgs) => {
  set($data, args.id)
})
