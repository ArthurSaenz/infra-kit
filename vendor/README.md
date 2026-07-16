# vendor/ — mirrored from starter-workspace

**DO NOT EDIT files in this folder here.**

Everything under `vendor/` is the single source of truth maintained in
`starter-workspace` and copied into this repo by
`starter-workspace/scripts/copy-shared-repos-data.mjs`. Local edits are
overwritten on the next sync and will fail `pnpm vendor:check` in CI.

To change a vendored package, edit it in `starter-workspace` and re-run the sync.

See `.sync-manifest.json` for the source commit and per-file checksums.
