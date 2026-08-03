#!/usr/bin/env bash
# PreToolUse (Bash): require an ADR/spec trailer and prevent verification bypasses.
set -euo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
[ -z "$CMD" ] && exit 0

deny() { printf '%s\n' "$1" >&2; exit 2; }

if printf '%s' "$CMD" | grep -qE '(^|[^[:alnum:]_])git[[:space:]]+(add|commit)'; then
  if printf '%s' "$CMD" | grep -oE '\.env[A-Za-z0-9_.-]*' \
    | grep -vE '^\.env\.(example|sample|template)$' | grep -q .; then
    deny "BLOCKED: refusing to stage or commit .env* files."
  fi
fi

printf '%s' "$CMD" | grep -qE '(^|[^[:alnum:]_])git[[:space:]]+commit' || exit 0

printf '%s' "$CMD" | grep -qE '(--no-verify|(^|[[:space:]])-n([[:space:]]|$))' \
  && deny "BLOCKED: commit verification cannot be bypassed."

printf '%s' "$CMD" | grep -qE '(--amend.*--no-edit|--no-edit.*--amend|(^|[[:space:]])-C[[:space:]])' \
  && exit 0

printf '%s' "$CMD" | grep -qE '(feat|fix|docs|refactor|test|build|ci|chore|perf|revert)(\([^)]*\))?!?:[[:space:]]' \
  || deny "BLOCKED: commit message must use Conventional Commits, e.g. feat(comments): add domain validation."

printf '%s' "$CMD" | grep -qE '(Spec:[[:space:]]*[0-9]{3}|ADR:[[:space:]]*[0-9]{4})' \
  || deny "BLOCKED: commit needs a Spec: NNN or ADR: NNNN trailer. If no approved spec covers the work, draft one first."
exit 0
