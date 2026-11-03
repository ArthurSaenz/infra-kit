import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { atomNaming } from '../atom-naming'

// Wire ESLint's RuleTester into vitest's lifecycle so each case becomes a real test.
const ruleTesterHooks = RuleTester as unknown as {
  afterAll: typeof afterAll
  describe: typeof describe
  it: typeof it
  itOnly: typeof it.only
}

ruleTesterHooks.afterAll = afterAll
ruleTesterHooks.describe = describe
ruleTesterHooks.it = it
// eslint-disable-next-line test/no-only-tests -- RuleTester requires an `itOnly` hook reference.
ruleTesterHooks.itOnly = it.only

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
})

const UNPREFIXED = 'const count = atom(0)'

ruleTester.run('atom-naming', atomNaming, {
  valid: [
    // A primitive atom whose initial value is null is readable, not write-only.
    'export const $error = atom<string | null>(null)',
    // Readable atoms of every factory carry the `$` prefix.
    { code: 'const $count = atom(0)' },
    { code: 'export const $count = atom<number>(0)' },
    { code: 'const $double = atom((get) => get($count) * 2)' },
    { code: "const $theme = atomWithStorage('theme', 'light')" },
    { code: 'const $filters = atomWithReset({})' },
    { code: 'const $draft = atomWithDefault((get) => get($saved))' },
    { code: 'const $user = loadable($userQuery)' },
    { code: 'const $name = selectAtom($user, (user) => user.name)' },
    { code: 'const $items = splitAtom($list)' },
    { code: "const $street = focusAtom($address, (optic) => optic.prop('street'))" },
    // A read-write atom is readable.
    { code: 'const $count = atom((get) => get($base), (get, set, value: number) => set($base, value))' },
    // atomFamily is readable even when its members are write-only.
    { code: 'const $cardFamily = atomFamily((id: string) => atom(null, (get, set) => set($open, id)))' },
    // Write-only atoms: async ends `Fx`, sync ends `Atom`.
    { code: 'const toggleOpenedCardAtom = atom(null, (get, set) => set($opened, !get($opened)))' },
    { code: 'export const loadUserFx = atom(null, async (get, set) => set($user, await fetchUser()))' },
    { code: 'const resetFormAtom = atom(null, function (get, set) { set($form, {}) })' },
    // A write fn passed by reference cannot be classified, so either suffix passes.
    { code: 'const startSearchFx = atom(null, startSearch)' },
    { code: 'const startSearchAtom = atom(null, startSearch)' },
    // A single named `*Args` argument, destructured or not, with or without a default.
    { code: 'const startSearchFx = atom(null, async (get, set, args: StartSearchArgs) => {})' },
    { code: 'const toggleAtom = atom(null, (get, set, { id }: ToggleArgs) => {})' },
    { code: 'const toggleAtom = atom(null, (get, set, args: ToggleArgs = DEFAULT) => {})' },
    // Unannotated args are typed through the generics (or are tsc's implicit-any concern).
    { code: 'const toggleAtom = atom<null, [ToggleArgs], void>(null, (get, set, args) => {})' },
    // Only module-level declarations are checked.
    { code: 'function make() { const count = atom(0); return count }' },
    // Not an atom factory, or a member call.
    { code: 'const count = useState(0)' },
    { code: 'const count = jotai.atom(0)' },
    // Custom prefix and suffixes.
    {
      code: 'const r_count = atom(0)\nconst saveEffect = atom(null, async (get, set, input: SaveInput) => {})',
      options: [{ readablePrefix: 'r_', asyncSuffix: 'Effect', argsSuffix: 'Input' }],
    },
    // paths / ignore.
    { code: UNPREFIXED, filename: '/repo/src/lib/x.ts', options: [{ paths: ['**/features/**'] }] },
    { code: UNPREFIXED, filename: '/repo/src/features/a/services.ts', options: [{ ignore: ['**/features/**'] }] },
  ],

  invalid: [
    {
      code: UNPREFIXED,
      errors: [{ message: 'Readable atom "count" must start with "$" (e.g. "$count").' }],
    },
    {
      code: "export const theme = atomWithStorage('theme', 'light')",
      errors: [{ messageId: 'readablePrefix' }],
    },
    {
      code: 'const cards = atomFamily((id: string) => atom(0))',
      errors: [{ messageId: 'readablePrefix' }],
    },
    {
      code: 'const toggleOpenedCard = atom(null, (get, set) => {})',
      errors: [{ message: 'Write-only atom "toggleOpenedCard" must end with "Atom" (sync).' }],
    },
    {
      code: 'const loadUserAtom = atom(null, async (get, set) => {})',
      errors: [{ message: 'Write-only atom "loadUserAtom" must end with "Fx" (async).' }],
    },
    {
      code: 'const resetFx = atom(null, (get, set) => {})',
      errors: [{ message: 'Write-only atom "resetFx" must end with "Atom" (sync).' }],
    },
    {
      code: 'const startSearch = atom(null, startSearch)',
      errors: [{ message: 'Write-only atom "startSearch" must end with "Fx" (async) or "Atom" (sync).' }],
    },
    {
      code: 'const $toggleAtom = atom(null, (get, set) => {})',
      errors: [{ message: 'Write-only atom "$toggleAtom" must not start with "$": that prefix marks readable atoms.' }],
    },
    // Args typed as a primitive, an inline object, or a generic utility type.
    {
      code: 'const toggleOpenedCardAtom = atom(null, (get, set, id: string) => {})',
      errors: [
        {
          message:
            'Write-only atom "toggleOpenedCardAtom" must take a single argument typed with a named `*Args` type (e.g. `args: ToggleOpenedCardArgs`).',
        },
      ],
    },
    {
      code: 'const startSearchFx = atom(null, async (get, set, args: { query: string }) => {})',
      errors: [
        { messageId: 'argsNotNamed', data: { name: 'startSearchFx', suffix: 'Args', example: 'StartSearchArgs' } },
      ],
    },
    {
      code: "const startSearchFx = atom(null, async (get, set, args: Omit<StartSearchArgs, 'page'>) => {})",
      errors: [{ messageId: 'argsNotNamed' }],
    },
    // More than one argument, or a rest argument, is not a single object.
    {
      code: 'const moveAtom = atom(null, (get, set, from: MoveArgs, to: MoveArgs) => {})',
      errors: [{ messageId: 'argsNotNamed' }],
    },
    {
      code: 'const moveAtom = atom(null, (get, set, ...args: MoveArgs[]) => {})',
      errors: [{ messageId: 'argsNotNamed' }],
    },
    // Every violation of one atom is reported.
    {
      code: 'const $move = atom(null, async (get, set, id: number) => {})',
      errors: [{ messageId: 'writeOnlyPrefix' }, { messageId: 'writeOnlySuffix' }, { messageId: 'argsNotNamed' }],
    },
    {
      code: dedent`
        const $ok = atom(0)
        export const bad = atom(0)
      `,
      errors: [{ messageId: 'readablePrefix', line: 2 }],
    },
    // Custom options flow into the messages.
    {
      code: 'const saveAtom = atom(null, async (get, set, args: SaveArgs) => {})',
      options: [{ asyncSuffix: 'Effect' }],
      errors: [{ message: 'Write-only atom "saveAtom" must end with "Effect" (async).' }],
    },
    {
      code: UNPREFIXED,
      filename: '/repo/src/features/a/services.ts',
      options: [{ paths: ['**/features/**'], readablePrefix: 'r_' }],
      errors: [{ message: 'Readable atom "count" must start with "r_" (e.g. "r_count").' }],
    },
  ],
})
