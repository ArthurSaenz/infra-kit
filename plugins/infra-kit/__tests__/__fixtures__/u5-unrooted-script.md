---
name: u5-unrooted-script
description: Red fixture for U5. One fenced invocation reaches a bundled script through a repo-relative path, which resolves to nothing once the skill ships inside a plugin cache directory.
---

# Unrooted script invocation

Rooted correctly, so this line is clean.

```
node "${CLAUDE_PLUGIN_ROOT}"/skills/fe-architect/scripts/validate_feature.mjs <features-path>
```

Rooted at the consumer repo instead, so this line is the offender.

```
node plugins/infra-kit/skills/fe-architect/scripts/scaffold_feature.mjs <features-dir> <feature>
```

A prose mention of `scripts/scaffold_feature.mjs` is documentation and stays out of the corpus.
