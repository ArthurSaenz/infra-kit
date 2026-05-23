# @wl/docs-ui

Self-contained monorepo documentation app (white-label, source package) built with
[Fumadocs](https://fumadocs.dev) on [TanStack Start](https://tanstack.com/start). It aggregates
Markdown/MDX docs **in place** from across the monorepo (no copying) and prerenders a fully
static site for S3 hosting.

This is the COMPLETE docs app: routes, vite/source config, the relocation-safe aggregation, the
pure path→slug logic, the fumadocs source factory, and the MDX/search/not-found components all
live here. It is synced into each consumer at `vendor/packages/docs-ui` and builds from there.

## Content lives outside the package (per-repo)

The only thing that is NOT part of this package is the docs landing content. Each repo keeps its
own `spec/docs/` directory at the **repo root** (outside `vendor/`). The app reads it via the
repo-root `spec/docs/` convention — `createDocsAggregation` derives the repo root by walking up to
`pnpm-workspace.yaml` and looks for `spec/docs/**` there. `spec/docs/` is per-repo and is NOT
synced from the template.

## How aggregation works

`src/lib/docs-aggregation.ts` is the single source of truth (node-only; build/server config) for:

- **What is published** — any `.md`/`.mdx` under a `docs/` directory in an app or package, plus
  the repo-root `content/`.
- **URLs** — file paths are mapped to clean, package-grouped slugs
  (e.g. `apps/ai/agent/docs/draft.md` → `/docs/ai-agent/draft`).
- **Prerendering** — every doc URL is enumerated and seeded into the static build.

Pure path→slug logic lives in `src/lib/slugs.ts` (no `node:fs`), so it can be bundled into the
client via the fumadocs loader without leaking node built-ins into the browser bundle.

### Adding docs

1. Create a `docs/` directory in your app or package (e.g. `packages/my-pkg/docs/`).
2. Add a `.md`/`.mdx` file. `title`/`description` frontmatter is optional.
3. Rebuild — the page appears under its package group in the sidebar.

## Commands

```bash
# dev server (http://localhost:3030)
pnpm --filter @wl/docs-ui dev

# static production build
pnpm --filter @wl/docs-ui build

# preview the production build locally
pnpm --filter @wl/docs-ui preview

# type check (regenerates .source first)
pnpm --filter @wl/docs-ui ts-check
```

## Deploying to S3 (static)

The build runs in SPA mode with prerendering enabled, so the output is fully static — no Node
server is required at runtime. The static assets (SPA shell + prerendered pages) are emitted to
`.output/public`.

```bash
pnpm --filter @wl/docs-ui build
aws s3 sync vendor/packages/docs-ui/.output/public s3://<your-docs-bucket> --delete
```

Configure the bucket/CloudFront for SPA fallback: serve existing static files as-is and rewrite
remaining 404s to `/_shell.html` so client-side routes resolve.
