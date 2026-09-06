// Vitest setup file for node environment
import path from 'node:path'
import process from 'node:process'

// Tripwire — applies to EVERY test file (wired at vitest.config.ts `setupFiles`).
//
// The entry-boundary bootstrap `ensureUserProjectConfig()` (src/lib/config-bootstrap) writes to
// ~/.infra-kit/projects/<repo>/, and it runs on the CLI preAction hook and the MCP tool-call
// boundary. No test may ever touch the developer's REAL $HOME, so the kill switch is armed globally
// here.
//
// Layering, deliberately: the switch guards the GATED wrapper only. The ungated primitive
// `seedUserProjectConfig()` ignores it by design (otherwise `config edit` could not seed, and the
// bootstrap's own negative tests would pass vacuously). So any test that calls the primitive
// directly — or `configEdit`, which uses it — MUST stub `os.homedir()` to a temp dir itself.
process.env.INFRA_KIT_NO_SEED = '1'

// Second tripwire, same purpose, different mechanism.
//
// `infra-kit init` DRIVES `claude plugin install` (src/lib/plugin-pointer/install-plugin), and three
// suites call the real `init()`. Unguarded, every run of those suites would install this plugin into
// the developer's own Claude Code — recorded against a temp directory deleted seconds later — and
// each install would take tens of seconds against the network.
//
// A PATH SHIM, not an env kill switch. There is deliberately no product-facing way to turn the
// install off, so the guard must live entirely in the test environment: `src/__fixtures__/bin/claude`
// answers `--version`, exits 0 for the two plugin subcommands, and writes nothing. PREPENDED, so it
// wins over a real `claude` when the developer has one. Global, so a NEW test that calls `init()`
// cannot reintroduce the side effect by omission.
//
// The shim writes no `installed_plugins.json` record on purpose: the installer verifies against that
// file, so `init` correctly reports `unverified` and warns. Forging the record would hollow out the
// one check that exists to catch a silent install failure.
process.env.PATH = `${path.join(import.meta.dirname, 'src', '__fixtures__', 'bin')}${path.delimiter}${process.env.PATH ?? ''}`
