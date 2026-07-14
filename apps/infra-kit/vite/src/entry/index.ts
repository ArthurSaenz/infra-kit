// Public `@slip-stream-kit/vite` entry: `import { infraKit } from '@slip-stream-kit/vite'`.
//
// One export, on purpose. The resolution logic it wraps stays in `@slip-stream-kit/config` (whose
// `./vite` entry still exports `infraKitDev` for a consumer who wants the raw `server` block) — this
// package owns only the vite-plugin SHAPE: the `config` hook that merges without overruling, and the
// dev-context watcher that re-resolves the proxy while the server is up.
export { infraKit } from '../lib/plugin/plugin'
export type { InfraKitPluginOptions } from '../lib/plugin/plugin'
