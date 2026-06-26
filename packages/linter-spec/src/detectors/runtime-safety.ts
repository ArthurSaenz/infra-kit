import { DetectorGroup } from '#root/groups'
import { Severity } from '#root/severity'
import type { Detector } from '#root/types'

export const runtimeSafetyDetectors: Detector[] = [
  {
    id: 'test-leakage',
    group: DetectorGroup.runtimeSafety,
    scope: 'file',
    title: 'Test code leaking into production modules',
    description:
      'A production module imports from a test file, test utility, or `__tests__` directory, pulling test-only code into the production bundle.',
    rationale:
      'Test helpers, mocks, and fixtures are intentionally simplified or stripped-down stand-ins for real logic. When they leak into production code the shipped bundle carries dead weight, may expose internal test seams to consumers, and makes it impossible to tree-shake the test infrastructure out. It also signals that the production module has no clean public surface of its own.',
    defaultSeverity: Severity.error,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Importing a test fixture in app code',
        bad: `// src/services/user-service.ts
import { mockUser } from '../__tests__/fixtures/mock-user'

export const getUser = () => mockUser`,
        good: `// src/services/user-service.ts
import type { User } from '../models/user'

export const getUser = (): User => ({
  id: '1',
  name: 'Alice',
})`,
      },
    ],
    eslint: {
      messageId: 'testCodeInProd',
      fixable: null,
      recommended: true,
    },
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'vendor-coupling',
    group: DetectorGroup.runtimeSafety,
    scope: 'file',
    title: 'Tight coupling to vendor library types or API',
    description:
      "Application code references a third-party library's types, classes, or constants directly and pervasively rather than wrapping them behind a thin internal adapter.",
    rationale:
      'Spreading vendor-specific types across dozens of call sites makes library migrations expensive: every call site becomes a change point. An adapter layer confines the coupling to one module, letting the rest of the codebase work against a stable internal contract. It also gives AI tooling a single well-defined seam to reason about rather than scattered vendor surface area.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Direct Axios type spread across a feature',
        bad: `// src/features/orders/api.ts
import type { AxiosResponse, AxiosError } from 'axios'

export const fetchOrder = async (id: string): Promise<AxiosResponse> => {
  // ...
  throw new Error('not implemented')
}`,
        good: `// src/lib/http/index.ts  (adapter)
export interface HttpResponse<T> { data: T; status: number }
export type HttpError = { message: string; status: number }

// src/features/orders/api.ts
import type { HttpResponse } from '../../lib/http'

export const fetchOrder = async (id: string): Promise<HttpResponse<unknown>> => {
  // ...
  throw new Error('not implemented')
}`,
      },
    ],
    options: [
      {
        name: 'allow',
        type: 'string[]',
        description: 'Vendor modules exempt from the adapter rule.',
      },
    ],
    eslint: {
      messageId: 'tightVendorCoupling',
      fixable: null,
      recommended: false,
    },
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'hub-dependency',
    group: DetectorGroup.runtimeSafety,
    scope: 'graph',
    title: 'Hub dependency — over-reliance on one external package',
    description:
      'A single third-party package is imported directly by an unusually large fraction of the codebase, creating a wide blast radius if that dependency needs to change.',
    rationale:
      "When dozens of modules each reach for the same external package, a breaking change, security advisory, or major-version upgrade touches every one of those call sites. Isolating the package behind an internal module means the migration is bounded: only the adapter changes, and the rest of the graph is insulated. It also makes the codebase's external surface legible to reviewers and AI tools at a glance.",
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'date-fns imported in every module',
        bad: `// src/orders/format.ts
import { format } from 'date-fns'
export const formatDate = (d: Date) => format(d, 'yyyy-MM-dd')

// src/invoices/format.ts
import { format, parseISO } from 'date-fns'
export const parseDate = (s: string) => parseISO(s)`,
        good: `// src/lib/dates/index.ts  (one place that knows about date-fns)
import { format, parseISO } from 'date-fns'
export const formatDate = (d: Date) => format(d, 'yyyy-MM-dd')
export const parseDate = (s: string) => parseISO(s)

// src/orders/format.ts
import { formatDate } from '../../lib/dates'
export const orderDate = (d: Date) => formatDate(d)`,
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'side-effect-import',
    group: DetectorGroup.runtimeSafety,
    scope: 'file',
    title: 'Side-effect import executed on module load',
    description:
      "A bare `import './x'` statement runs arbitrary side effects the moment the module is loaded, making load order a hidden contract and behaviour impossible to defer or tree-shake.",
    rationale:
      'Side-effect imports couple load order to behaviour. Tests that import any module in the same graph transitively trigger the effect, which makes test isolation hard. Tree-shakers cannot eliminate the import even if the effect is not needed in a given build target. Replacing bare imports with explicit `init()` calls gives callers control over when and whether the effect fires, and makes the dependency visible in the call graph.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Global polyfill loaded via bare import',
        bad: `// src/bootstrap.ts
import './polyfills/array-at'
import './instrumentation/sentry'

export const bootstrap = () => { /* ... */ }`,
        good: `// src/bootstrap.ts
import { applyPolyfills } from './polyfills/array-at'
import { initSentry } from './instrumentation/sentry'

export const bootstrap = () => {
  applyPolyfills()
  initSentry()
}`,
      },
    ],
    eslint: {
      messageId: 'sideEffectImport',
      fixable: null,
      recommended: false,
    },
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'shared-mutable-state',
    group: DetectorGroup.runtimeSafety,
    scope: 'file',
    title: 'Exported mutable state reassigned at runtime',
    description:
      'A module exports a `let` binding or a mutable object whose reference is replaced at runtime, allowing any importer to observe inconsistent state depending on evaluation order.',
    rationale:
      "Mutable exports create invisible action-at-a-distance: one module's write is another's surprise read. This pattern defeats ESM static analysis, breaks tree-shaking, and makes behaviour non-deterministic across import orders. It is especially harmful in SSR and edge-runtime environments where module scope may be shared across requests. Exporting a readonly value or a getter function makes the module's contract explicit and safe.",
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Exported let counter mutated by callers',
        bad: `// src/lib/counter.ts
export let count = 0

export const increment = () => {
  count += 1
}`,
        good: `// src/lib/counter.ts
let _count = 0

export const getCount = () => _count

export const increment = () => {
  _count += 1
}`,
      },
    ],
    eslint: {
      messageId: 'mutableExport',
      fixable: null,
      recommended: true,
    },
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: {
      status: 'partial',
      plugin: 'eslint-core',
      rule: 'import/no-mutable-exports',
    },
  },
]
