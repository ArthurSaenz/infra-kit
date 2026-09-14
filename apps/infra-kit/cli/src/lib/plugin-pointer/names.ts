/**
 * The three names every plugin-pointer module agrees on, in a file that imports NOTHING.
 *
 * Split out of `plugin-pointer.ts` because that module constructs the pino logger at import time,
 * and the detached update worker (`dist/update-check.js`) needs `PLUGIN_KEY` to spawn
 * `claude plugin update` — a worker that logs to an ignored stderr has no business paying for pino.
 */

/** The marketplace name, as it appears in `extraKnownMarketplaces` and in `<plugin>@<marketplace>`. */
export const MARKETPLACE_NAME = 'infra-kit'

/** The `enabledPlugins` key: `<plugin>@<marketplace>`, both `infra-kit`. */
export const PLUGIN_KEY = 'infra-kit@infra-kit'

/** The GitHub repo the marketplace is served from. */
export const MARKETPLACE_REPO = 'ArthurSaenz/infra-kit'
