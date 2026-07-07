// Public `infra-kit/vite` subpath entry: `import { infraKitDev } from 'infra-kit/vite'`.
// Deliberately LIGHTWEIGHT — the implementation imports only the `dev.proxy`
// config types/schema and node builtins, never the CLI/dev-server graph
// (fastify, chokidar, commander, ink, react) — so importing this from a
// consumer's vite.config.ts stays cheap. Uses a relative import so the emitted
// .d.ts stays portable for external consumers (mirrors src/entry/index.ts).
export { infraKitDev, infraKitProxy, resolveProxyConfig, slugifyRelease } from '../lib/vite/vite'
export type { InfraKitBasicAuth, InfraKitDevOptions, InfraKitViteProxy, InfraKitViteProxyEntry } from '../lib/vite/vite'
