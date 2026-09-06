---
name: u6-body-path-changed
description: Red fixture for clause 2. The frontmatter is the green fixture's, but the body's script path was edited without the rule, so the invocation the skill actually runs is not the one it is allowed to run.
allowed-tools: Read, Edit, Bash(node "${CLAUDE_PLUGIN_ROOT}"/skills/comment-verifier/scripts/lint-comments.mjs *), Bash(git diff:*), Bash(pnpm --filter * run ts-check), Bash(pnpm run test:claude)
---

# Body path changed

```
node "${CLAUDE_PLUGIN_ROOT}"/skills/comment-verifier/scripts/lint-comment.mjs <files...>
```

```
git diff --name-only --diff-filter=d HEAD
```

```
pnpm --filter <package> run ts-check
```

```
pnpm run test:claude
```
