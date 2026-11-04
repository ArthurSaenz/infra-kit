import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { servicesNamespaceImport } from '../services-namespace-import'

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
    parserOptions: { ecmaFeatures: { jsx: true }, ecmaVersion: 'latest', sourceType: 'module' },
  },
})

const CONTAINER = '/repo/src/features/search/containers/search-container.tsx'
const HOOK = '/repo/src/features/search/use-search.hook.ts'
const TEST = '/repo/src/features/search/__tests__/services.test.ts'

ruleTester.run('services-namespace-import', servicesNamespaceImport, {
  valid: [
    { code: "import * as service from '../services'\nservice.load()", filename: CONTAINER },
    { code: "import type { Item } from '../services'", filename: CONTAINER },
    { code: "import { type Item } from '../services'\nlet item: Item", filename: CONTAINER },
    { code: "import * as service from '../services'\nimport type { Item } from '../services'", filename: CONTAINER },
    // Side-effect import binds nothing.
    { code: "import '../services'", filename: CONTAINER },
    // Files inside `services/` import their siblings by name.
    { code: "import { getItems } from './api'", filename: '/repo/src/features/search/services/main.ts' },
    // Only a module literally named `services` is judged.
    { code: "import { x } from '../services-helpers'", filename: CONTAINER },
    { code: "import { x } from './user-services'", filename: CONTAINER },
    // Package and alias imports go through public APIs, which other rules own.
    { code: "import { x } from '#root/features/search/services'", filename: CONTAINER },
    { code: "import { x } from 'services'", filename: CONTAINER },
    { code: "import * as svc from '../services'", filename: CONTAINER, options: [{ name: 'svc' }] },
    // A barrel publishes the services under its own name.
    {
      code: "import * as mainLoaderService from './services'\nexport { mainLoaderService }",
      filename: '/repo/src/lib/main-loader/index.ts',
    },
    { code: "import { x } from '../services'", filename: CONTAINER, options: [{ ignore: ['**/containers/**'] }] },
  ],
  invalid: [
    {
      code: "import { $isOpen, load } from '../services'\nconst open = $isOpen\nload()",
      filename: CONTAINER,
      output: "import * as service from '../services'\nconst open = service.$isOpen\nservice.load()",
      errors: [{ messageId: 'namedImport' }],
    },
    {
      name: 'keeps type-only specifiers in their own import',
      code: "import { type Item, load } from './services'\nlet item: Item\nload()",
      filename: HOOK,
      output:
        "import * as service from './services'\nimport type { Item } from './services'\nlet item: Item\nservice.load()",
      errors: [{ messageId: 'namedImport' }],
    },
    {
      name: 'keeps the key of a shorthand property',
      code: "import { load } from '../services'\nexport const api = { load }",
      filename: CONTAINER,
      output: "import * as service from '../services'\nexport const api = { load: service.load }",
      errors: [{ messageId: 'namedImport' }],
    },
    {
      name: 'reads an aliased import through its exported name',
      code: "import { load as loadItems } from '../services'\nloadItems()",
      filename: CONTAINER,
      output: "import * as service from '../services'\nservice.load()",
      errors: [{ messageId: 'namedImport' }],
    },
    {
      name: 'folds into an existing namespace import',
      code: "import * as service from '../services'\nimport { load } from '../services'\nload()\nservice.reset()",
      filename: CONTAINER,
      output: "import * as service from '../services'\nservice.load()\nservice.reset()",
      errors: [{ messageId: 'namedImport' }],
    },
    {
      name: 'merges two named imports into one namespace',
      code: "import { a } from '../services'\nimport { b } from '../services'\na()\nb()",
      filename: CONTAINER,
      output: "import * as service from '../services'\nservice.a()\nservice.b()",
      errors: [{ messageId: 'namedImport' }, { messageId: 'namedImport' }],
    },
    {
      name: 'checks tests and the services folder barrel',
      code: "import { load } from '../services/index'\nload()",
      filename: TEST,
      output: "import * as service from '../services/index'\nservice.load()",
      errors: [{ messageId: 'namedImport' }],
    },
    {
      name: 'renames a wrongly named namespace',
      code: "import * as services from '../services'\nservices.load()",
      filename: CONTAINER,
      output: "import * as service from '../services'\nservice.load()",
      errors: [{ messageId: 'namespaceName' }],
    },
    {
      name: 'default import',
      code: "import load from '../services'\nload()",
      filename: CONTAINER,
      output: "import * as service from '../services'\nservice.default()",
      errors: [{ messageId: 'namedImport' }],
    },
    {
      name: 'no fix when `service` is shadowed at a reference',
      code: "import { load } from '../services'\nconst run = (service: number) => load(service)",
      filename: CONTAINER,
      output: null,
      errors: [{ messageId: 'namedImport' }],
    },
    {
      name: 'no fix when `service` is already bound',
      code: "import { load } from '../services'\nconst service = 1\nload(service)",
      filename: CONTAINER,
      output: null,
      errors: [{ messageId: 'namedImport' }],
    },
    {
      name: 'no fix for a local re-export',
      code: "import { load } from '../services'\nexport { load }",
      filename: CONTAINER,
      output: null,
      errors: [{ messageId: 'namedImport' }],
    },
    {
      name: 'no fix for a JSX tag',
      code: "import { Item } from '../services'\nexport const view = <Item />",
      filename: CONTAINER,
      output: null,
      errors: [{ messageId: 'namedImport' }],
    },
    {
      name: 'no fix when two services modules are imported',
      code: "import { a } from '../services'\nimport { b } from './services'\na()\nb()",
      filename: CONTAINER,
      output: null,
      errors: [{ messageId: 'namedImport' }, { messageId: 'namedImport' }],
    },
    {
      name: 'the named fix waits for the namespace rename',
      code: "import * as services from '../services'\nimport { load } from '../services'\nload()\nservices.reset()",
      filename: CONTAINER,
      output: "import * as service from '../services'\nimport { load } from '../services'\nload()\nservice.reset()",
      errors: [{ messageId: 'namespaceName' }, { messageId: 'namedImport' }],
    },
    {
      name: 'honours a custom name',
      code: "import { load } from '../services'\nload()",
      filename: CONTAINER,
      options: [{ name: 'svc' }],
      output: "import * as svc from '../services'\nsvc.load()",
      errors: [{ messageId: 'namedImport' }],
    },
  ],
})
