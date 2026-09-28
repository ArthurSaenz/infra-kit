// Public `@slip-stream-kit/config/playwright` entry: `import { infraKitE2e } from '@slip-stream-kit/config/playwright'`.
//
// Lightweight for the same reason `./vite` is: it runs inside the consumer's Playwright config process, so
// it imports only the package-config schema and node builtins — never the CLI graph.
export { DEV_SERVING_MARKER, E2E_MODE_ENV, infraKitE2e } from '../lib/playwright/playwright'
export type {
  InfraKitE2eMode,
  InfraKitE2eOptions,
  InfraKitE2eSetup,
  InfraKitWebServer,
} from '../lib/playwright/playwright'
