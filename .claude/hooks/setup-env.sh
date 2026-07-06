#!/bin/bash
if [ -n "$CLAUDE_ENV_FILE" ]; then
  : # no-op — add 'export ...' lines here to inject env vars
  # echo 'export NODE_ENV=development' >> "$CLAUDE_ENV_FILE"
  # echo 'export PATH="$PATH:./node_modules/.bin"' >> "$CLAUDE_ENV_FILE"
fi

exit 0
