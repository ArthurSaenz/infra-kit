import { DetectorGroup } from '#root/groups'
import { Severity } from '#root/severity'
import type { Detector } from '#root/types'

export const moduleDesignDetectors: Detector[] = [
  {
    id: 'god-module',
    group: DetectorGroup.moduleDesign,
    scope: 'project',
    title: 'God module (too many responsibilities)',
    description:
      'A single module exports far more symbols than a focused unit of responsibility should, indicating that multiple concerns have accumulated in one place.',
    rationale:
      'God modules become a gravitational sink: every new feature touches them, merge conflicts multiply, and the surface area an AI or developer must load to understand one concern includes dozens of unrelated ones. Splitting by responsibility yields modules small enough to reason about in isolation and test without mocking the world. Unlike ai-context-bloat — a file-scope detector that flags export count as a pure comprehension-budget concern — god-module operates at project scope and is driven by responsibility and coupling: it considers how many other modules import this one and whether those importers represent distinct concerns.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Everything in one barrel',
        bad: `// utils/index.ts
export { formatDate } from './date'
export { parseQuery } from './query'
export { sendEmail } from './email'
export { hashPassword } from './crypto'
export { resizeImage } from './image'
export { generatePdf } from './pdf'
export { sanitizeHtml } from './html'
export { buildCsv } from './csv'
export { validateSchema } from './schema'
export { computeDiscount } from './pricing'
export { trackEvent } from './analytics'
export { throttle } from './throttle'`,
        good: `// email/index.ts
export { sendEmail } from './send'
export { parseTemplate } from './template'

// pricing/index.ts
export { computeDiscount } from './discount'
export { applyTax } from './tax'

// crypto/index.ts
export { hashPassword } from './hash'
export { signToken } from './sign'`,
      },
    ],
    options: [
      {
        name: 'maxExports',
        type: 'number',
        default: 20,
        description:
          'Maximum number of public exports allowed from a single module before it is flagged as a god module.',
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'hub-module',
    group: DetectorGroup.moduleDesign,
    scope: 'project',
    title: 'Hub module (high fan-in and high fan-out)',
    description:
      'A module that is imported by many others (high fan-in) while itself importing many modules (high fan-out), making it a central hub through which unrelated concerns must route.',
    rationale:
      'Hub modules create fragile architecture: a change to any of their many dependencies can break any of their many consumers. They also create a context-loading tax — understanding one consumer requires understanding the hub and all of its imports. Narrowing the hub surface by extracting focused sub-modules reduces blast radius and improves navigability.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Mega-hub re-exporting everything',
        bad: `// shared/hub.ts (imported by 30 modules, imports 25 modules)
export { UserRepo } from './user-repo'
export { OrderRepo } from './order-repo'
export { AuthService } from './auth'
export { EmailService } from './email'
export { Logger } from './logger'`,
        good: `// auth/index.ts  — imported only by auth consumers
export { AuthService } from './auth-service'

// data/index.ts  — imported only by data-access layer
export { UserRepo } from './user-repo'
export { OrderRepo } from './order-repo'`,
      },
    ],
    options: [
      {
        name: 'maxConnections',
        type: 'number',
        default: 10,
        description: 'Combined fan-in + fan-out threshold above which a module is considered a hub.',
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'lcom',
    group: DetectorGroup.moduleDesign,
    scope: 'project',
    title: 'Low cohesion class (LCOM4)',
    description:
      'A class whose methods and fields form disconnected components under LCOM4 analysis — groups of members that never reference each other — indicating the class contains multiple independent responsibilities.',
    rationale:
      'LCOM4 > 1 is a measurable signal that a class is doing more than one thing. Each disconnected component is a candidate for its own class. Low-cohesion classes are harder to test (a test must construct the whole class to reach one component), harder for AI to summarise accurately, and accumulate unrelated changes over time.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Two disconnected responsibilities in one class',
        bad: `class ReportService {
  private title: string = ''

  setTitle(t: string) { this.title = t }
  getTitle() { return this.title }

  // Completely unrelated to title
  private count: number = 0
  increment() { this.count++ }
  getCount() { return this.count }
}`,
        good: `class ReportMeta {
  private title: string = ''
  setTitle(t: string) { this.title = t }
  getTitle() { return this.title }
}

class Counter {
  private count: number = 0
  increment() { this.count++ }
  getCount() { return this.count }
}`,
      },
    ],
    options: [
      {
        name: 'maxComponents',
        type: 'number',
        default: 1,
        description: 'Maximum number of disconnected LCOM4 components allowed in a single class before flagging.',
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'high-coupling',
    group: DetectorGroup.moduleDesign,
    scope: 'project',
    title: 'High efferent coupling (too many outgoing dependencies)',
    description:
      'A module imports from more distinct modules than the configured threshold, indicating it depends on too many external concerns rather than a focused abstraction.',
    rationale:
      'Efferent coupling (Ce) measures how many modules a given module depends on. High Ce means a change anywhere in those dependencies can force a re-test or re-build of this module. It also signals missing abstraction layers: the module should depend on a narrow interface rather than reaching into many concrete peers.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Service importing from 20 different modules',
        bad: `import { UserRepo } from './user-repo'
import { OrderRepo } from './order-repo'
import { PaymentGateway } from './payment'
import { EmailService } from './email'
import { Logger } from './logger'
import { Config } from './config'
import { Cache } from './cache'
import { Metrics } from './metrics'

export class CheckoutService {
  // uses all eight imports
}`,
        good: `import type { CheckoutDeps } from './checkout-deps'

export class CheckoutService {
  constructor(private deps: CheckoutDeps) {}
}`,
      },
    ],
    options: [
      {
        name: 'maxDependencies',
        type: 'number',
        default: 15,
        description:
          'Maximum number of distinct outgoing import targets allowed before flagging high efferent coupling.',
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'module-cohesion',
    group: DetectorGroup.moduleDesign,
    scope: 'project',
    title: 'Scattered module (single concern spread across many files)',
    description:
      'Code that implements a single logical concern (e.g. billing, notifications) is fragmented across many unrelated directories rather than co-located in one module.',
    rationale:
      'Scattered modules force developers and AI agents to load many files to understand one feature. Making a change requires discovering all fragments first — a search problem rather than a navigation problem. Co-locating code by responsibility makes the boundary of a concern visible in the file system and reduces the cognitive surface for both humans and LLMs.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Billing logic in four separate places',
        bad: `// src/utils/billing-helpers.ts
// src/services/billing.ts
// src/models/invoice.ts
// src/controllers/billing-controller.ts
// (no shared parent directory; all unrelated neighbours)`,
        good: `// src/billing/invoice.ts
// src/billing/billing-service.ts
// src/billing/billing-controller.ts
// src/billing/index.ts  — single entry point`,
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'feature-envy',
    group: DetectorGroup.moduleDesign,
    scope: 'graph',
    title: 'Feature envy (method uses another class more than its own)',
    description:
      'A method accesses fields or methods of a foreign class more frequently than it uses members of its own class, suggesting it belongs in that other class.',
    rationale:
      'Feature envy is a smell that the responsibility boundary was drawn incorrectly. The method has more cohesion with its target class than with its host class, so placing it there would increase cohesion in both classes, reduce coupling across the boundary, and make the behaviour discoverable where the data it manipulates lives.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Method living in the wrong class',
        bad: `class Order {
  items: { price: number; qty: number }[] = []
}

class Discount {
  compute(order: Order) {
    const subtotal = order.items.reduce(
      (sum, i) => sum + i.price * i.qty,
      0
    )
    return subtotal > 100 ? subtotal * 0.1 : 0
  }
}`,
        good: `class Order {
  items: { price: number; qty: number }[] = []

  subtotal() {
    return this.items.reduce((sum, i) => sum + i.price * i.qty, 0)
  }

  discount() {
    return this.subtotal() > 100 ? this.subtotal() * 0.1 : 0
  }
}`,
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'import-fan-in',
    group: DetectorGroup.moduleDesign,
    scope: 'graph',
    title: 'High import fan-in (load-bearing symbol)',
    description: 'A single exported symbol imported by a large fraction of the codebase.',
    rationale:
      'A symbol imported everywhere is high-blast-radius: editing its signature, semantics, or side effects ripples to every importer simultaneously. In an agentic flow, an agent must recognise before touching such a symbol that the change is not local — it is effectively a global contract change. This complements hub-dependency (which tracks over-reliance on an external package) with the internal-symbol case: a homegrown export that has become load-bearing across the module graph.',
    defaultSeverity: Severity.info,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Fragile util imported everywhere vs stable narrow contract',
        bad: `// src/lib/format.ts
export function formatAmount(value: number, currency: string, locale: string, decimals: number) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: decimals }).format(value)
}
// imported by 40+ modules with different argument combinations`,
        good: `// src/lib/format.ts
export interface FormatAmountOptions { currency: string; locale?: string; decimals?: number }
export function formatAmount(value: number, options: FormatAmountOptions) {
  const { currency, locale = 'en-US', decimals = 2 } = options
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: decimals }).format(value)
}
// stable options-object signature — adding fields is non-breaking`,
      },
    ],
    options: [
      {
        name: 'maxImporters',
        type: 'number',
        default: 30,
        description: 'Max modules that may import a single symbol before it is flagged.',
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
    tags: ['ai-agentic'],
  },
]
