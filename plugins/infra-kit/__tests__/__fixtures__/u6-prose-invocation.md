---
name: u6-prose-invocation
description: Red fixture for clause 1. The lint invocation was moved out of its fence into prose, so it leaves the corpus entirely and its rule is left granting nothing.
allowed-tools: Read, Edit, Bash(node "${CLAUDE_PLUGIN_ROOT}"/skills/comment-verifier/scripts/lint-comments.mjs *), Bash(git diff:*), Bash(pnpm --filter * run ts-check), Bash(pnpm run test:claude)
---

# Prose invocation

Run `node "${CLAUDE_PLUGIN_ROOT}"/skills/comment-verifier/scripts/lint-comments.mjs <files...>` to
scope the review. A reader can follow that sentence; the extractor cannot, and must not.

```
git diff --name-only --diff-filter=d HEAD
```

```
pnpm --filter <package> run ts-check
```

```
pnpm run test:claude
```
