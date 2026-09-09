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

# Strip the metered coding-agent credentials from every bash command, so a
# child agent CLI spawned from Bash (claude -p, codex exec, ...) can never
# silently run on the owner's API key instead of their subscription (the $575
# lesson: see docs/decisions/20260710-ai-employees-product.md, "never silently
# spend the owner's keys").
#
# SHELLTEAM_AI_TOKEN and SHELLTEAM_USER_ID are deliberately NOT stripped: they
# are the intended auth for the box's own /internal/ai and ports APIs, and the
# layer's own content (the stt skill, the persona's ports section) teaches curl
# calls that pass them. Unsetting them here made those documented workflows run
# with empty credentials and fail with 400/401.
UNSET_PREFIX='unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null; '

jq -n --arg cmd "${UNSET_PREFIX}${command}" '{
  "hookSpecificOutput": {
    "updatedInput": {
      "command": $cmd
    }
  }
}'
