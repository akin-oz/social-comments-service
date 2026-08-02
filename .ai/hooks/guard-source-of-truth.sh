#!/usr/bin/env bash
# PreToolUse (Edit|Write|MultiEdit): call out contract and governance files.
set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null || true)
[ -z "$FILE_PATH" ] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
REL_PATH="${FILE_PATH#"$PROJECT_DIR"/}"

case "$REL_PATH" in
  docs/architecture.md|docs/assumptions.md|docs/api-design.md|docs/database.md|.ai/manifest.yaml|package.json|pnpm-workspace.yaml|tsconfig*.json|eslint.config.*|vitest.config.*)
    ;;
  *) exit 0 ;;
esac

jq -n --arg p "$REL_PATH" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: ("This is a source-of-truth or contract-adjacent file:\n  → " + $p + "\nConfirm the change is covered by an approved spec and, when it changes an architectural decision, an ADR under docs/decisions/.")
  }
}'
exit 0
