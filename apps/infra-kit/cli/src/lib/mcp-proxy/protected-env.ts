/**
 * Never removed from an MCP child's environment, whatever the env file or a spec's `unset` names.
 *
 * These are process plumbing, not secrets. `PATH` is the sharpest: the proxy sets it immediately
 * before its redaction loop, so a Doppler config that happened to define `PATH` would delete it
 * again and the spawn would ENOENT. The proxy and TLS entries decide whether the child can reach
 * its service at all, so stripping them would change connectivity silently.
 */
export const PROTECTED_CHILD_ENV_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
])
