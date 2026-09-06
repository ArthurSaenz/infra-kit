---
name: u6-green
description: Reference fixture. Its allowed-tools rules and its fenced command corpus agree, so it satisfies all four clauses of plan §8.1a.
allowed-tools: Read, Edit, Bash(node "${CLAUDE_PLUGIN_ROOT}"/skills/comment-verifier/scripts/lint-comments.mjs *), Bash(git diff:*), Bash(pnpm --filter * run ts-check), Bash(pnpm run test:claude)
---

# Green fixture

Scope the review, then lint it.

```
node "${CLAUDE_PLUGIN_ROOT}"/skills/comment-verifier/scripts/lint-comments.mjs <files...>
```

The rung-2 scope comes from the working tree.

```
git diff --name-only --diff-filter=d HEAD
```

Type-check the package you touched, then run the suite.

```
pnpm --filter <package> run ts-check
```

```
pnpm run test:claude
```
