#!/usr/bin/env bash
# Stop: run the repository's lightweight quality gate before handoff.
set -euo pipefail

INPUT=$(cat)
STOP_ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)
[ "$STOP_ACTIVE" = "true" ] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR"

pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
exit 0
