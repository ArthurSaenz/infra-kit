import path from 'node:path'

import type { ResourceKey } from '../../resources'

/** Absolute path of the `resources/` tree: `__tests__/helpers` → … → the package root. */
export const RESOURCES_DIR = path.resolve(import.meta.dirname, '../../../../../resources')

/**
 * A distinctive line fragment from each resource, used both to prove a file is the
 * one its key names and to prove esbuild inlined it into the bundle.
 *
 * Two constraints, both measured against the real build, both of which make a
 * sentinel silently unfindable in `dist` rather than wrong in an obvious way:
 *
 * 1. **ASCII only.** Esbuild's default `charset` is `ascii` and escapes everything
 *    else — and every bullet in these files contains an em dash.
 * 2. **No backtick.** Esbuild emits these resources as template literals, so each
 *    backtick in the markdown is written as `` \` ``. Inline code spans are the most
 *    natural thing to reach for in a sentinel and are exactly what cannot be used.
 *
 * `resources.test.ts` asserts both mechanically, so neither can creep back in.
 */
export const SENTINELS: Readonly<Record<ResourceKey, string>> = {
  'root/body': 'This repository uses the **infra-kit** CLI for environment, worktree, and release workflows.',
  'package/frontend': 'dev URLs are proxied and port-free.',
  'package/backend': 'Module-scope state belongs in the handler entry file',
  'package/lib': 'Changing that map is a breaking change for every dependent package.',
  'package/e2e': 'Selectors live in Page Objects, never inline in specs.',
  'package/mobile': 'The web build feeds the native shell, so a device run needs a rebuild first.',
  'design/skeleton': 'Replace every TODO below with the real design language.',
}
