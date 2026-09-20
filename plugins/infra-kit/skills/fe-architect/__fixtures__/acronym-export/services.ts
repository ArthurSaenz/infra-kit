import { atom } from 'jotai'

import type { AIChatData, GetAIChatFxArgs } from './types'

export const $data = atom<AIChatData | null>(null)
export const $isLoading = atom<boolean>(false)
export const $error = atom<Error | null>(null)
export const $hasData = atom((get) => get($data) !== null)

export const getAIChatFx = atom(null, async (get, set, args: GetAIChatFxArgs) => {
  set($isLoading, true)
  set($data, { id: args.id })
  set($isLoading, false)
})

export const resetAIChatAtom = atom(null, (get, set) => {
  set($data, null)
})
