import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { onEachLine } from '../line-stream'

const collect = (chunks: readonly string[]): Promise<string[]> => {
  const stream = new PassThrough()
  const lines: string[] = []

  onEachLine(stream, (line) => {
    lines.push(line)
  })

  for (const chunk of chunks) stream.write(chunk)
  stream.end()

  return new Promise((resolve) => {
    stream.on('end', () => {
      resolve(lines)
    })
    stream.resume()
  })
}

describe('onEachLine', () => {
  it('splits several messages arriving in one chunk', async () => {
    await expect(collect(['{"a":1}\n{"b":2}\n'])).resolves.toEqual(['{"a":1}', '{"b":2}'])
  })

  it('reassembles a message split across chunks — the case a naive per-chunk parse drops', async () => {
    await expect(collect(['{"a":', '1}', '\n'])).resolves.toEqual(['{"a":1}'])
  })

  it('holds an unterminated tail rather than emitting a half message', async () => {
    await expect(collect(['{"a":1}\n{"b":'])).resolves.toEqual(['{"a":1}'])
  })

  it('strips a CRLF carriage return so it never lands inside the JSON', async () => {
    await expect(collect(['{"a":1}\r\n'])).resolves.toEqual(['{"a":1}'])
  })

  it('skips blank and whitespace-only lines', async () => {
    await expect(collect(['\n   \n{"a":1}\n'])).resolves.toEqual(['{"a":1}'])
  })
})
