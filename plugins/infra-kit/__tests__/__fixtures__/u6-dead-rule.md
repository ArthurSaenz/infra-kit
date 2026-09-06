---
name: u6-dead-rule
description: Red fixture for clause 3. Every fenced command line is covered, but one extra rule grants a python3 invocation the body never makes.
allowed-tools: Read, Edit, Bash(node "${CLAUDE_PLUGIN_ROOT}"/skills/comment-verifier/scripts/lint-comments.mjs *), Bash(python3 "${CLAUDE_PLUGIN_ROOT}"/skills/e2e-architect/scripts/scaffold_feature.py *), Bash(git diff:*), Bash(pnpm --filter * run ts-check), Bash(pnpm run test:claude)
---

# Dead rule

```
node "${CLAUDE_PLUGIN_ROOT}"/skills/comment-verifier/scripts/lint-comments.mjs <files...>
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
