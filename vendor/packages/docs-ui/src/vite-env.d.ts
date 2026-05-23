/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Injected by vite.config.ts `define` — the docs app's content dir relative to the repo root.
  // Read by src/lib/source.ts to build the path->slug mapper without importing node:fs code.
  readonly VITE_DOCS_CONTENT_REL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
