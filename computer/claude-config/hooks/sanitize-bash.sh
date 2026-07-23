#!/bin/bash
# PreToolUse hook for Bash — strips sensitive environment variables from commands.
#
# Input: JSON on stdin with { tool_name, tool_input: { command } }
# Output: JSON on stdout with updatedInput if modified

set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

if [ -z "$command" ]; then
  echo '{}'
  exit 0
fi

# Prepend unset of sensitive vars to every bash command
UNSET_PREFIX='unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN SHELLTEAM_AI_TOKEN SHELLTEAM_USER_ID 2>/dev/null; '

jq -n --arg cmd "${UNSET_PREFIX}${command}" '{
  "hookSpecificOutput": {
    "updatedInput": {
      "command": $cmd
    }
  }
}'
