/**
 * zx with the child's own output captured instead of relayed to this process's terminal.
 *
 * zx pipes a child's stdout but forwards its STDERR to the parent's, so every probe of a
 * possibly-absent binary printed `/bin/bash: <name>: command not found` into the terminal of every
 * `setup` and `doctor` run — in the shell's voice, looking like a crash, from a read-only check. This is
 * the one shell those probes may use. `quiet` suppresses the relay only: `.stdout` and `.stderr` still
 * come back on the result, and a non-zero exit still rejects.
 */
import { $ } from 'zx'

/**
 * A configured zx shell, built per call rather than once at module scope.
 *
 * `$({ … })` is a real invocation of zx, and at module scope it fires on IMPORT — inside every test that
 * mocks `zx` anywhere in the graph, before that test's own fixtures exist. Deferring it means only a
 * test that actually shells out has to model the factory call shape.
 */
export const quietShell = () => {
  return $({ quiet: true })
}
