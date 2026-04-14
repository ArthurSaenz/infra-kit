#!/bin/bash
COMMAND=$(jq -r '.tool_input.command')

# Block rm -rf, force push, database drops
if echo "$COMMAND" | grep -qE 'rm\s+-rf|git push.*--force|drop table|drop database|truncate\s'; then
  echo "Blocked: destructive command not allowed" >&2
  exit 2
fi

exit 0
