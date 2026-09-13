/**
 * Newline framing for a JSON-RPC stdio stream.
 *
 * Deliberately not `node:readline`. That module is fenced off outside
 * `src/lib/prompts/` because it is the shape a future interactive stdin reader would
 * take, and the prompts module owns the stdin refcount. This is a transport, not a
 * prompt — but the fence has no exemptions and is worth more intact than this is worth
 * saving, and hand framing is a dozen lines with no buffering semantics to inherit.
 */
export const onEachLine = (stream: NodeJS.ReadableStream, visit: (line: string) => void): void => {
  let buffer = ''

  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk

    let boundary = buffer.indexOf('\n')

    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary)

      buffer = buffer.slice(boundary + 1)

      // A peer that writes CRLF must not hand us a trailing CR inside the JSON.
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

      if (line.trim().length > 0) visit(line)

      boundary = buffer.indexOf('\n')
    }
  })
}
