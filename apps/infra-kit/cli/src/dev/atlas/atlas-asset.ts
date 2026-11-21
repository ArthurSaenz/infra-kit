import type { Buffer } from 'node:buffer'
import * as fs from 'node:fs'

export type AtlasAssetName = 'index.html' | 'app.js' | 'app.css'

/** `null` when the page was not built, which the server answers with a plain "not built" page. */
export type AtlasAssetReader = (name: AtlasAssetName) => Buffer | null

/**
 * Relative to the running module: the CLI bundle and its chunks sit flat in `dist/`, and the page build
 * writes `dist/atlas/`. From source (vitest) the folder does not exist, so a test injects its own reader.
 */
export const readAtlasAsset: AtlasAssetReader = (name) => {
  try {
    return fs.readFileSync(new URL(`./atlas/${name}`, import.meta.url))
  } catch {
    return null
  }
}
