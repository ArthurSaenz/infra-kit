import { atom } from 'jotai'
import { describe, expectTypeOf, it } from 'vitest'

import type { ExtractAtomActionArgs, ExtractAtomSetter, ExtractedAtomType } from './extracted-atom-type'

describe('atom utility types', () => {
  describe('extractedAtomType', () => {
    it('should extract type from primitive atom', () => {
      const _numberAtom = atom(0)
      const _stringAtom = atom('hello')
      const _booleanAtom = atom(true)

      expectTypeOf<ExtractedAtomType<typeof _numberAtom>>().toEqualTypeOf<number>()
      expectTypeOf<ExtractedAtomType<typeof _stringAtom>>().toEqualTypeOf<string>()
      expectTypeOf<ExtractedAtomType<typeof _booleanAtom>>().toEqualTypeOf<boolean>()
    })

    it('should extract type from object atom', () => {
      interface User {
        id: string
        name: string
        age: number
      }

      const _userAtom = atom<User>({ id: '1', name: 'John', age: 30 })

      expectTypeOf<ExtractedAtomType<typeof _userAtom>>().toEqualTypeOf<User>()
    })

    it('should extract type from nullable atom', () => {
      interface User {
        id: string
        name: string
      }

      const _nullableUserAtom = atom<User | null>(null)

      expectTypeOf<ExtractedAtomType<typeof _nullableUserAtom>>().toEqualTypeOf<User | null>()
    })

    it('should extract type from array atom', () => {
      const _stringArrayAtom = atom<string[]>([])
      const _numberArrayAtom = atom<number[]>([1, 2, 3])

      expectTypeOf<ExtractedAtomType<typeof _stringArrayAtom>>().toEqualTypeOf<string[]>()
      expectTypeOf<ExtractedAtomType<typeof _numberArrayAtom>>().toEqualTypeOf<number[]>()
    })

    it('should extract type from union type atom', () => {
      type Status = 'idle' | 'loading' | 'success' | 'error'
      const _statusAtom = atom<Status>('idle')

      expectTypeOf<ExtractedAtomType<typeof _statusAtom>>().toEqualTypeOf<Status>()
    })
  })

  describe('extractAtomActionArgs', () => {
    it('should extract action type from WritableAtom with union actions', () => {
      type CounterActionArgs = { type: 'increment' } | { type: 'decrement' } | { type: 'set'; value: number }

      const _countAtom = atom(0)
      const _counterAtom = atom(null, (get, set, action: CounterActionArgs) => {
        const current = get(_countAtom)

        if (action.type === 'increment') {
          set(_countAtom, current + 1)
        } else if (action.type === 'decrement') {
          set(_countAtom, current - 1)
        } else if (action.type === 'set') {
          set(_countAtom, action.value)
        }
      })

      expectTypeOf<ExtractAtomActionArgs<typeof _counterAtom>>().toEqualTypeOf<CounterActionArgs>()
    })

    it('should extract args from atom with object payload', () => {
      interface SetUserArgs {
        name: string
        age: number
      }

      const _userAtom = atom({ name: 'John', age: 30 })
      const _setUserAtom = atom(null, (_get, set, args: SetUserArgs) => {
        const { name, age } = args

        set(_userAtom, { name, age })
      })

      expectTypeOf<ExtractAtomActionArgs<typeof _setUserAtom>>().toEqualTypeOf<SetUserArgs>()
    })

    it('should extract args from atom with primitive payload', () => {
      const _message = atom('')
      const _messageAtom = atom(null, (_get, set, message: string) => {
        set(_message, message)
      })

      expectTypeOf<ExtractAtomActionArgs<typeof _messageAtom>>().toEqualTypeOf<string>()
    })
  })

  describe('extractAtomSetter', () => {
    it('should extract updater function from primitive atom', () => {
      const _numberAtom = atom(0)
      const _stringAtom = atom('hello')

      expectTypeOf<ExtractAtomSetter<typeof _numberAtom>>().toEqualTypeOf<(prev: number) => number>()
      expectTypeOf<ExtractAtomSetter<typeof _stringAtom>>().toEqualTypeOf<(prev: string) => string>()
    })

    it('should extract updater function from object atom', () => {
      interface User {
        id: string
        name: string
      }

      const _userAtom = atom<User>({ id: '1', name: 'John' })

      expectTypeOf<ExtractAtomSetter<typeof _userAtom>>().toEqualTypeOf<(prev: User) => User>()
    })

    it('should extract updater function from nullable atom', () => {
      interface User {
        id: string
        name: string
      }

      const _nullableUserAtom = atom<User | null>(null)

      expectTypeOf<ExtractAtomSetter<typeof _nullableUserAtom>>().toEqualTypeOf<(prev: User | null) => User | null>()
    })

    it('should extract updater function from array atom', () => {
      const _todosAtom = atom<string[]>([])

      expectTypeOf<ExtractAtomSetter<typeof _todosAtom>>().toEqualTypeOf<(prev: string[]) => string[]>()
    })

    it('should work with complex nested types', () => {
      interface Todo {
        id: string
        text: string
        completed: boolean
      }

      const _todosAtom = atom<Todo[]>([])

      expectTypeOf<ExtractAtomSetter<typeof _todosAtom>>().toEqualTypeOf<(prev: Todo[]) => Todo[]>()
    })
  })
})
