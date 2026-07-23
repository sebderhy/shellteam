#!/bin/bash
# PreCompact hook — archives the conversation transcript to ~/conversations/
# before Claude Code compacts the context.
#
# Input: JSON on stdin with { transcript_path, session_id, ... }
# Output: JSON on stdout (empty = success)

set -euo pipefail

input=$(cat)
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty')

if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
  exit 0
fi

CONVERSATIONS_DIR="$HOME/conversations"
mkdir -p "$CONVERSATIONS_DIR"

DATE=$(date +%Y-%m-%d)
TIME=$(date +%H%M)

# Extract first user message for naming
FIRST_MSG=$(grep -m1 '"type":"user"' "$transcript_path" 2>/dev/null | \
  jq -r '.message.content // empty' 2>/dev/null | \
  head -c 50 | tr -cs 'a-zA-Z0-9' '-' | sed 's/^-//;s/-$//' | tr 'A-Z' 'a-z')
[ -z "$FIRST_MSG" ] && FIRST_MSG="conversation"

FILENAME="${DATE}-${FIRST_MSG}-${TIME}.md"
FILEPATH="${CONVERSATIONS_DIR}/${FILENAME}"

# Count messages
USER_COUNT=$(grep -c '"type":"user"' "$transcript_path" 2>/dev/null || echo 0)
ASST_COUNT=$(grep -c '"type":"assistant"' "$transcript_path" 2>/dev/null || echo 0)

# Build markdown archive
{
  echo "# Conversation Archive"
  echo ""
  echo "Archived: $(date '+%b %d, %Y %I:%M %p')"
  echo "Messages: ${USER_COUNT} user, ${ASST_COUNT} assistant"
  echo ""
  echo "---"
  echo ""

  # Extract user and assistant messages
  while IFS= read -r line; do
    type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
    case "$type" in
      user)
        content=$(echo "$line" | jq -r '
          if .message.content | type == "string" then .message.content
          elif .message.content | type == "array" then
            [.message.content[] | select(.type == "text") | .text] | join("")
          else "" end' 2>/dev/null)
        [ -n "$content" ] && echo "**User**: ${content:0:2000}" && echo ""
        ;;
      assistant)
        content=$(echo "$line" | jq -r '
          [.message.content[]? | select(.type == "text") | .text] | join("")' 2>/dev/null)
        [ -n "$content" ] && echo "**Assistant**: ${content:0:2000}" && echo ""
        ;;
    esac
  done < "$transcript_path"
} > "$FILEPATH"

echo '{}' # success
