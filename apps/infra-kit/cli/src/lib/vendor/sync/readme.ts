/** Written to `<target>/vendor/README.md` on every sync that has a vendored entry. */
export const vendorReadme = (source: string): string => {
  return `# vendor/ — mirrored from ${source}

**DO NOT EDIT files in this folder here.**

Everything under \`vendor/\` is maintained in \`${source}\` and copied into this repo by
\`ik vendor sync\`, run from \`${source}\`. Local edits are overwritten on the next sync and
fail \`ik vendor check\` in CI.

To change a vendored package, edit it in \`${source}\` and re-run the sync there.

See \`.sync-manifest.json\` for the source commit and per-file checksums.
`
}
