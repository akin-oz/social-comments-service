#!/usr/bin/env bash
# Stop: remind the agent to keep documentation aligned with implementation changes.
set -euo pipefail

INPUT=$(cat)
STOP_ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)
[ "$STOP_ACTIVE" = "true" ] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0
CHANGED=$(git status --porcelain 2>/dev/null | sed 's/^...//' | grep -vE 'node_modules/|\.pnpm-store/|\.claude/|\.codex/' || true)
[ -z "$CHANGED" ] && exit 0

TRIGGERS=$(printf '%s\n' "$CHANGED" | grep -E '^(src|tests|scripts)/|(^|/)package\.json$|^pnpm-' || true)
[ -z "$TRIGGERS" ] && exit 0

printf '%s\n' "$CHANGED" | grep -qE '(^|/)README\.md$|^docs/|^specs/' && exit 0

echo "Docs check: implementation/config changes are present without a README, docs, or spec update:" >&2
printf '%s\n' "$TRIGGERS" | sed 's/^/  - /' | head -20 >&2
echo "Review the relevant docs and update them, or explicitly explain why no documentation change is needed." >&2
exit 2
