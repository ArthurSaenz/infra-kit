#!/usr/bin/env python3

import json, re, sys

SUGGESTIONS = [
    (r"^grep\b(?!.*\|)", "Use 'rg' (ripgrep) instead of 'grep' for better performance"),
    (r"^find\s+\S+\s+-name\b", "Use 'rg --files | rg pattern' instead of 'find -name'"),
    (r"^npm\s+(install|run|test)", "Use 'pnpm' instead of 'npm' in this project"),
    (r"^yarn\s+(add|run|test)", "Use 'pnpm' instead of 'yarn' in this project"),
]

input_data = json.load(sys.stdin)
if input_data.get("tool_name") != "Bash":
    sys.exit(0)

command = input_data.get("tool_input", {}).get("command", "")
issues = []
for pattern, message in SUGGESTIONS:
    if re.search(pattern, command):
        issues.append(f"* {message}")

if issues:
    for issue in issues:
        print(issue, file=sys.stderr)
    sys.exit(2)

sys.exit(0)
