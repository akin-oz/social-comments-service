#!/usr/bin/env bash
# PreToolUse (Edit|Write|MultiEdit): require an approved spec before implementation.
set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null || true)
[ -z "$FILE_PATH" ] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
REL_PATH="${FILE_PATH#"$PROJECT_DIR"/}"

# Proposals, ADRs, and documentation may be drafted without an implementation spec.
case "$REL_PATH" in
  specs/*|docs/decisions/*|README.md|.ai/agents/*|.ai/rules/*|.ai/hooks/*|.ai/templates/*)
    exit 0
    ;;
esac

# Implementation and contract-adjacent changes require an approved spec.
case "$REL_PATH" in
  src/*|tests/*|docs/*.md|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|tsconfig*.json|eslint.config.*|vitest.config.*|.github/*|.claude/*|.codex/*)
    ;;
  *) exit 0 ;;
esac

APPROVED=$(find "$PROJECT_DIR/specs" -maxdepth 1 -type f -name '*.md' -print0 2>/dev/null \
  | xargs -0 rg -l '^approved:[[:space:]]*yes[[:space:]]*$' 2>/dev/null || true)

[ -n "$APPROVED" ] && exit 0

jq -n --arg p "$REL_PATH" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: ("No approved implementation spec covers this change:\n  → " + $p + "\nDraft or update specs/NNN-*.md, leave approved: no until human review, and stop implementation until a human approves it. Architectural decisions additionally require an ADR under docs/decisions/")
  }
}'
exit 0
