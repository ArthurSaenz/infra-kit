// Public `@slip-stream-kit/config/vite` entry:
// `import { infraKitDev } from '@slip-stream-kit/config/vite'`.
//
// Byte-for-byte the same value surface the old `infra-kit/vite` exported, so a consumer's
// vite.config.ts changes only its import specifier.
//
// Deliberately LIGHTWEIGHT — the implementation imports only the `dev.proxy` config types/schema and
// node builtins, never the CLI graph (fastify, chokidar, commander, ink, react), which no longer even
// lives in this package. Uses relative imports so the emitted .d.ts stays portable.
export { infraKitDev, infraKitProxy, resolveProxyConfig, slugifyRelease } from '../lib/vite/vite'
export type { InfraKitBasicAuth, InfraKitDevOptions, InfraKitViteProxy, InfraKitViteProxyEntry } from '../lib/vite/vite'
