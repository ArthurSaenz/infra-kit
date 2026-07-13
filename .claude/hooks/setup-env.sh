#!/bin/bash
if [ -n "$CLAUDE_ENV_FILE" ]; then
  # echo 'export NODE_ENV=development' >> "$CLAUDE_ENV_FILE"
  # echo 'export PATH="$PATH:./node_modules/.bin"' >> "$CLAUDE_ENV_FILE"
  : # no-op: bash requires a command here; uncomment a line above to set env vars
fi

exit 0
