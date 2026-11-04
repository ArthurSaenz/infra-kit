import type { TypedFlatConfigItem } from '@antfu/eslint-config'
import reactHooksPlugin from 'eslint-plugin-react-hooks'

import { GLOB_SRC_ALL, GLOB_TS_DOC_EXCLUDE } from '../globs.js'
import type { ConfigRules } from '../types.js'
import { publicApiPatterns } from './base.js'
import { isE2eSourceFile } from './e2e-boundaries.js'

/** Frontend-only code. Backends keep `services/` + `controllers/`, so none of these folders occur there. */
const GLOB_FE = ['**/*.tsx', '**/{features,components,containers,pages,routes,entities}/**/*.ts']

/** Where the app is allowed to touch the platform directly: its http layer, env module and bootstrap. */
const GLOB_PLATFORM_EDGE = [
  '**/lib/http-client/**',
  '**/lib/http-client.*',
  '**/lib/data-fetching/**',
  '**/lib/env/**',
  '**/lib/env.*',
  '**/app/**',
  '**/*.config.*',
]

const GLOB_DUMB_COMPONENT = ['**/features/*/components/**/*.{ts,tsx}', '**/*-component.tsx']

const GLOB_ROUTE_SHELLS = ['**/routes/**', '**/pages/**', '**/renderer/**', '**/web/**']

// antfu's own entries, repeated: a later block's options replace an earlier block's, never merge.
const ANTFU_RESTRICTED_SYNTAX = ['TSEnumDeclaration[const=true]', 'TSExportAssignment']
const ANTFU_RESTRICTED_GLOBALS = [
  { name: 'global', message: 'Use `globalThis` instead.' },
  { name: 'self', message: 'Use `globalThis` instead.' },
]

export type RestrictedSyntax = string | { selector: string; message: string }

const COMPONENT_TYPE =
  'TSTypeReference:matches([typeName.name=/^(ComponentType|ComponentClass)$/], [typeName.right.name=/^(ComponentType|ComponentClass)$/])'

// `ElementType` stays allowed: a polymorphic `as` prop picks the host element, it injects nothing.
const PROPS_MEMBER = `:matches(TSInterfaceDeclaration[id.name=/Props$/] > TSInterfaceBody, TSTypeAliasDeclaration[id.name=/Props$/] > TSTypeLiteral) > TSPropertySignature`
const FLAT_PROP_TYPE = `${PROPS_MEMBER}[key.name!='components'] > TSTypeAnnotation`
// Without type info `typeof X` is opaque; a PascalCase key is what marks it as a component.
const PASCAL_PROP_TYPE = `${PROPS_MEMBER}[key.name=/^[A-Z]/] > TSTypeAnnotation`
const FLAT_INJECTED_COMPONENT = [
  `${FLAT_PROP_TYPE} > ${COMPONENT_TYPE}`,
  `${FLAT_PROP_TYPE} > TSUnionType > ${COMPONENT_TYPE}`,
  `${PASCAL_PROP_TYPE} > TSTypeQuery`,
  `${PASCAL_PROP_TYPE} > TSUnionType > TSTypeQuery`,
].join(', ')

const FE_RESTRICTED_SYNTAX: RestrictedSyntax[] = [
  {
    selector: "MemberExpression[object.type='MetaProperty'][property.name='env']",
    message: 'Read environment variables through the app env module (`#root/lib/env`), not `import.meta.env`.',
  },
  {
    selector:
      "AssignmentExpression[left.object.name='window'][left.property.name='location'], AssignmentExpression[left.object.object.name='window'][left.object.property.name='location']",
    message: 'Navigate with the router. For an external redirect, disable this line and say why.',
  },
  {
    selector:
      "CallExpression[callee.object.object.name='window'][callee.object.property.name='location'][callee.property.name=/^(assign|replace)$/]",
    message: 'Navigate with the router. For an external redirect, disable this line and say why.',
  },
  {
    selector: "TSTypeReference[typeName.left.name='React'][typeName.right.name=/^(FC|FunctionComponent)$/]",
    message: 'Type props with a `{Component}Props` interface instead of `React.FC`.',
  },
  {
    selector: 'TSTypeReference[typeName.name=/^(FC|FunctionComponent)$/]',
    message: 'Type props with a `{Component}Props` interface instead of `FC`.',
  },
  {
    selector: FLAT_INJECTED_COMPONENT,
    message:
      "Inject components through one `components` prop, e.g. `components: Pick<XComponents, 'Foo'>`. ReactNode slots and render functions stay flat props.",
  },
]

const ROUTER_HOOKS = [
  'useNavigate',
  'useRouter',
  'useRouterState',
  'useSearch',
  'useParams',
  'useLocation',
  'useMatch',
  'useLoaderData',
]

const DUMB_MESSAGE = 'Dumb components render props only. Read it in the container and pass the value down as a prop.'

/**
 * fe-architect Rule 6 at the import level: a dumb component may not reach state, services, the http
 * client, analytics or the router. `import type` stays allowed.
 */
const dumbComponentImports: TypedFlatConfigItem = {
  name: 'wl/architecture/dumb-component-imports',
  files: GLOB_DUMB_COMPONENT,
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [{ name: '@tanstack/react-router', importNames: ROUTER_HOOKS, message: DUMB_MESSAGE }],
        patterns: [
          ...publicApiPatterns,
          { group: ['jotai', 'jotai/*'], allowTypeImports: true, message: DUMB_MESSAGE },
          {
            group: ['**/services', '**/services/*', '**/services.*', '**/service', '**/service.*'],
            allowTypeImports: true,
            message: DUMB_MESSAGE,
          },
          { group: ['**/http-client', '**/http-client/*'], allowTypeImports: true, message: DUMB_MESSAGE },
          {
            group: ['@pkg/analytics', '@pkg/analytics/*', '**/analytics', '**/analytics.*', '**/analytics/*'],
            allowTypeImports: true,
            message: DUMB_MESSAGE,
          },
        ],
      },
    ],
  } as ConfigRules,
}

/**
 * React-only architecture layer: hooks correctness, platform access through the app's own modules,
 * and dumb-component purity.
 *
 * @example
 * architecture({ restrictedSyntax: [{ selector: 'JSXText[value=/[\\u0590-\\u05FF]/]', message: 'Use T' }] })
 */
export const architecture = (extraRestrictedSyntax: RestrictedSyntax[]): TypedFlatConfigItem[] => [
  {
    // `react/rules-of-hooks` from @eslint-react crashes ESLint (null `.internal`) on real code, so the
    // official plugin owns this rule.
    name: 'wl/architecture/rules-of-hooks',
    files: [GLOB_SRC_ALL],
    // Plain test helpers named `use*` (e.g. `useLayerExpected` in Node suites) are not hooks; React tests call
    // hooks inside `renderHook` callbacks, which the rule never flags anyway.
    ignores: GLOB_TS_DOC_EXCLUDE,
    plugins: { 'react-hooks': reactHooksPlugin },
    rules: { 'react-hooks/rules-of-hooks': 'error' } as ConfigRules,
  },
  {
    // Playwright fixtures receive their continuation as `use`, which the rule reads as a hook call.
    name: 'wl/architecture/rules-of-hooks-e2e',
    files: [isE2eSourceFile as unknown as string],
    rules: { 'react-hooks/rules-of-hooks': 'off' } as ConfigRules,
  },
  {
    name: 'wl/architecture/platform-access',
    files: GLOB_FE,
    // Stories and tests legitimately hold demo copy and stub the platform.
    ignores: [...GLOB_PLATFORM_EDGE, ...GLOB_TS_DOC_EXCLUDE],
    rules: {
      'no-restricted-globals': [
        'error',
        ...ANTFU_RESTRICTED_GLOBALS,
        { name: 'fetch', message: 'Call the API through the app http client (`#root/lib/http-client`).' },
      ],
      'no-restricted-syntax': ['error', ...ANTFU_RESTRICTED_SYNTAX, ...FE_RESTRICTED_SYNTAX, ...extraRestrictedSyntax],
    } as ConfigRules,
  },
  {
    // The edge files above still get the consumer's extra selectors.
    name: 'wl/architecture/platform-edge',
    files: GLOB_PLATFORM_EDGE.filter((glob) => glob !== '**/*.config.*'),
    rules: {
      'no-restricted-syntax': ['error', ...ANTFU_RESTRICTED_SYNTAX, ...extraRestrictedSyntax],
    } as ConfigRules,
  },
  dumbComponentImports,
  {
    name: 'wl/architecture/only-export-components',
    files: ['**/*.tsx'],
    ignores: [...GLOB_ROUTE_SHELLS, ...GLOB_TS_DOC_EXCLUDE],
    rules: { 'react-refresh/only-export-components': ['error', { allowConstantExport: true }] } as ConfigRules,
  },
  {
    // A boundary disable hides a dependency the architecture forbids; fix the import instead. Every
    // other disable has to say why after `--`.
    name: 'wl/architecture/disable-directives',
    files: [GLOB_SRC_ALL],
    rules: {
      'eslint-comments/no-restricted-disable': [
        'error',
        'boundaries/*',
        '@wl/layer-imports',
        '@wl/feature-public-api',
        '@wl/no-feature-self-import',
      ],
      'eslint-comments/require-description': 'error',
    } as ConfigRules,
  },
  {
    name: 'wl/architecture/feature-file-size',
    files: ['**/features/**/*.{ts,tsx}'],
    ignores: GLOB_TS_DOC_EXCLUDE,
    rules: { 'sonarjs/max-lines': ['error', { maximum: 400 }] } as ConfigRules,
  },
]
