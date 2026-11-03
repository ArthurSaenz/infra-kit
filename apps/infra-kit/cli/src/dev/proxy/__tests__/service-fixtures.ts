/**
 * portless's own writers, ported verbatim (`dist/cli.js`: `xmlEscape`, `systemdEscape`), so every
 * fixture here is byte-for-byte what `service install` would put on disk for the same argv — the reader
 * is proven against the writer it has to agree with, not against hand-typed XML.
 */
export const xmlEscape = (value: string): string => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const systemdEscape = (value: string): string => {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export const launchdPlist = (programArguments: string[]): string => {
  const args = programArguments
    .map((arg) => {
      return `    <string>${xmlEscape(arg)}</string>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.portless.proxy</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORTLESS_STATE_DIR</key>
    <string>/Users/x/.portless</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`
}

export const systemdUnit = (execStart: string[]): string => {
  return `[Unit]
Description=Portless HTTPS proxy

[Service]
Type=simple
Environment=PORTLESS_STATE_DIR="/home/x/.portless"
ExecStart=${execStart.map(systemdEscape).join(' ')}
Restart=on-failure

[Install]
WantedBy=multi-user.target
`
}
