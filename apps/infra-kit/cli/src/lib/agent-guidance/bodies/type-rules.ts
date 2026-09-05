import type { PackageType } from '../package-type'

/**
 * `DESIGN.md` is named only by the types that own a visual language. Keeping it
 * in `firstReads` (rather than in a branch inside `buildPackageBody`) makes the
 * "frontend and mobile only" rule a property of the registry.
 */
const DESIGN_BULLET =
  '- `DESIGN.md` — the visual language (colors, typography, spacing, components). It is the source of truth for UI decisions; if it is absent, ask before inventing one.'

export interface TypeRules {
  /** Display name rendered in the block's summary line. */
  label: string
  /** Extra `## Read first` bullets for this type, inserted after `README.md`. */
  firstReads: readonly string[]
  /** The `## Rules` bullets for this type. Three or four; the body budget is 25 lines. */
  rules: readonly string[]
}

/**
 * The per-type text registry behind every package guidance block. One entry per
 * {@link PackageType}; `buildPackageBody` renders the shared skeleton around it.
 */
export const TYPE_RULES: Readonly<Record<PackageType, TypeRules>> = {
  frontend: {
    label: 'frontend',
    firstReads: [DESIGN_BULLET],
    rules: [
      '- Start the app with `infra-kit dev`, never a bare `vite` — dev URLs are proxied and port-free.',
      '- Backend calls go through the path prefixes declared in `dev.proxy` in `infra-kit.config.ts`. Never hardcode an API base URL or a port.',
      '- Use the tokens in `DESIGN.md` rather than ad-hoc colors, spacing, or type scales.',
    ],
  },
  backend: {
    label: 'backend',
    firstReads: [],
    rules: [
      '- Module-scope state belongs in the handler entry file — that is the file which re-evaluates on reload.',
      '- Env vars come from Doppler via `ik env-load`; never commit a secret.',
      "- The route prefix this service answers is declared in the consuming UI's `dev.proxy`, so changing a path is a two-package change.",
    ],
  },
  lib: {
    label: 'lib',
    firstReads: [],
    rules: [
      '- The public surface is the `exports` map in `package.json`.',
      '- Changing that map is a breaking change for every dependent package.',
      '- Run `pnpm run build` before a dependent package can see a change.',
      '- No app-specific logic belongs here.',
    ],
  },
  e2e: {
    label: 'e2e',
    firstReads: [],
    rules: [
      '- Specs run on Playwright.',
      '- Every spec cleans up what it creates, in teardown.',
      '- Selectors live in Page Objects, never inline in specs.',
      '- Never point a run at a production environment.',
    ],
  },
  mobile: {
    label: 'mobile',
    firstReads: [DESIGN_BULLET],
    rules: [
      '- The native shell is Capacitor; its settings live in `capacitor.config.*`.',
      '- The web build feeds the native shell, so a device run needs a rebuild first.',
      '- Use the tokens in `DESIGN.md` rather than ad-hoc colors, spacing, or type scales.',
    ],
  },
}
