---
name: u6-infra-kit-unruled
description: Red fixture — a fenced infra-kit command with no allowed-tools rule covering it.
allowed-tools: Read, Bash(node "${CLAUDE_PLUGIN_ROOT}"/skills/doctor/scripts/session-probe.mjs *)
---

# Red fixture for the `infra-kit` command head

Without `infra-kit` in `COMMAND_HEADS` the fenced line below enters no corpus and this fixture is
green — which is precisely the fail-open the widening closes. It must fail clause 2.

```
infra-kit doctor
```

The probe line is present and correctly ruled, so the only violation is the unruled one above.

```
node "${CLAUDE_PLUGIN_ROOT}"/skills/doctor/scripts/session-probe.mjs <plugin-root>
```
