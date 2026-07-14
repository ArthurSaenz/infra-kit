# vendor/ — mirrored from the source repo

**DO NOT EDIT files in this folder here.**

Everything under `vendor/` is the single source of truth maintained in the source
repo and copied into this repo by `infra-kit vendor sync`. Local edits are
overwritten on the next sync and will fail `infra-kit vendor check` in CI.

To change a vendored package, edit it in the source repo and re-run the sync.

See `.sync-manifest.json` for the source commit and per-file checksums.
