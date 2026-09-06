// Vitest setup file for node environment
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

// Second tripwire, same shape, different blast radius.
//
// `infra-kit init` now DRIVES `claude plugin install` (src/lib/plugin-pointer/install-plugin). Three
// suites call the real `init()`, and without this every one of them would install this plugin into
// the developer's own Claude Code — recorded against a temp directory that is deleted seconds later.
// Armed globally so a NEW test that calls `init()` cannot reintroduce that side effect by omission.
//
// A test that wants to prove the install path injects a `run` seam instead
// (`installPluginForProject({ run })`); the switch guards the DEFAULT runner only, so an injected
// fake still drives every step. That is what keeps the installer's own suite runnable under it.
process.env.INFRA_KIT_NO_PLUGIN_INSTALL = '1'
