#!/usr/bin/env bash
# PreToolUse (Edit|Write|MultiEdit): require an approved spec that claims this path.
#
# This hook used to ask a question it could not fail. `APPROVED` was the result
# of searching the whole specs/ directory for any file containing
# `approved: yes` — and all 25 contained it, so `APPROVED` was non-empty for
# every edit to every path, `exit 0` ran unconditionally, and the `ask` branch
# below had been unreachable since 2026-08-02. The repository described the
# gate as machine-enforced while the machine part was a constant.
#
# The predicate the rule actually states is "an approved specification *covers
# the change*", so that is what is evaluated now: each spec declares the paths
# it claims in a `paths:` front-matter list, and a change is gated on some
# approved spec claiming the path being written (Spec-032).
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
  src/*|tests/*|migrations/*|docs/*.md|docs/openapi.json|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|tsconfig*.json|eslint.config.*|vitest.config.*|.github/*|.githooks/*|scripts/*|.claude/*|.codex/*|Dockerfile|docker-compose.yml|fly.toml)
    ;;
  *) exit 0 ;;
esac

# Does an approved spec claim this path?
#
# A spec claims a path when one of its `paths:` entries matches, where `**`
# matches any number of segments. The comparison is done in the shell's own
# pattern matching, so no glob library is needed.
covered() {
  local target="$1" spec pattern in_paths approved

  for spec in "$PROJECT_DIR"/specs/*.md; do
    [ -e "$spec" ] || continue
    approved=$(sed -n '/^---$/,/^---$/p' "$spec" | grep -cE '^approved:[[:space:]]*yes[[:space:]]*$' || true)
    [ "$approved" -eq 0 ] && continue

    in_paths=0
    while IFS= read -r line; do
      case "$line" in
        'paths:'*) in_paths=1; continue ;;
        '  - '*)
          [ "$in_paths" -eq 1 ] || continue
          pattern="${line#  - }"
          # shellcheck disable=SC2254
          case "$target" in
            $pattern) return 0 ;;
          esac
          # `a/**` must also match `a/b/c`, which the shell's case does handle,
          # but `a/**` should not need to match `a` itself — and does not.
          ;;
        '') continue ;;
        *) in_paths=0 ;;
      esac
    done < "$spec"
  done
  return 1
}

if covered "$REL_PATH"; then
  exit 0
fi

jq -n --arg p "$REL_PATH" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: ("No approved specification claims this path:\n  → " + $p + "\nEither add it to the `paths:` list of the approved spec that covers this work, or draft specs/NNN-*.md with approved: no and stop until a human approves it. Architectural decisions additionally require an ADR under docs/decisions/")
  }
}'
exit 0
