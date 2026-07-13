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
