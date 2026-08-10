import { atom } from 'jotai'
import type { ValidData, GetValidFxArgs } from './types'

export const $data = atom<ValidData | null>(null)
export const $isLoading = atom<boolean>(false)
export const $error = atom<Error | null>(null)
export const $hasData = atom((get) => get($data) !== null)

export const getValidFx = atom(null, async (get, set, args: GetValidFxArgs) => {
  set($isLoading, true)
  set($data, { id: args.id })
  set($isLoading, false)
})

export const resetValidAtom = atom(null, (get, set) => {
  set($data, null)
})
