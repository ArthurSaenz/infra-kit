# Guidance resources

The prose `infra-kit` writes into `CLAUDE.md` and `DESIGN.md` files lives here as
markdown, not as string arrays in TypeScript. To change what a consumer repo reads,
edit the `.md` file — no TypeScript change is needed.

```
root/body.md         the repo-root CLAUDE.md block
package/<type>.md    the COMPLETE per-package block, one file per PackageType
design/skeleton.md   the DESIGN.md scaffold
```

`resources.ts` imports these and `template.ts` substitutes variables into them. This
file is excluded from the reconciliation walk by path, so it needs no special-casing.

## Placeholders

| File                 | Placeholders                                                          |
| -------------------- | --------------------------------------------------------------------- |
| `package/*.md`       | `{{packageName}}`, `{{relDir}}`, `{{type}}`, and `- {{readmeBullet}}` |
| `design/skeleton.md` | `{{packageName}}` — in the H1 only                                    |
| `root/body.md`       | none                                                                  |

Positions are not free. Each one below is measured against this repo's prettier, and
the failure mode in every case is silent: prettier leaves the token in place and
changes the text around it.

- **`- {{readmeBullet}}` keeps its `- ` marker in the file.** The variable carries
  only the bullet text. Written as a bare `{{readmeBullet}}` line it is a markdown
  _paragraph_ sitting next to a _list_, and prettier separates block elements with a
  blank line — so it rewrites all five files, every rendered body gains a line, and a
  package with no `README.md` renders a doubled blank line.
- **Never put `{{ }}` in YAML front matter.** Prettier reformats
  `name: {{packageName}}` into `name: { { packageName } }`, which is still valid YAML
  carrying the expected key. `design/skeleton.md` therefore keeps a static
  `name: TODO` line that `buildDesignSkeleton` replaces by exact string match.
- **A multi-line value may only sit at column 0.** `renderTemplate` throws otherwise
  rather than emitting mis-indented markdown.

## Rules

- **`resources.ts` must stay a flat list of static `?raw` imports.** No dynamic
  `import()`, no glob, no computed path. Esbuild bundles the CLI into a single file
  and inlines only what it can see statically; anything else leaves the specifier in
  `dist` and node throws `ERR_UNKNOWN_FILE_EXTENSION` on a consumer's machine. Every
  test here runs from `src/`, where the broken form still works —
  `resource-bundle.test.ts` is the only thing that would catch it.
- **A shared-prose edit is a five-file diff.** Eighteen of the ~22 lines in a type
  file are identical across all five. The drift assertions in `resources.test.ts`
  fail until every copy matches, so the suite will not go green on four of five.
- **Watch the line budget.** A rendered block may be 25 lines and three types
  already render 24. Adding one line to the shared region puts them at the ceiling;
  `bodies.test.ts` asserts exact counts and will say so.
- **Adding a package type** needs a `PackageType` entry, a `package/<type>.md`, and
  an import plus two record entries in `resources.ts`. The reconciliation test fails
  until all of them exist.

## Releasing a text change

Consumers run a globally-installed CLI, so the text reaches them through a publish —
there is no runtime read of this directory. Bump the version, publish, then each
developer runs `pnpm add -g infra-kit@latest` and re-runs `infra-kit audit --fix --root`
(`--fix --all` for the per-package blocks).
