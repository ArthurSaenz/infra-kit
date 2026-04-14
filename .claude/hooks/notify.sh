#!/bin/bash
INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | jq -r '.message // "Claude needs your attention"')

# macOS
# osascript -e "display notification \"$MESSAGE\" with title \"Claude Code\"" 2>/dev/null

exit 0
