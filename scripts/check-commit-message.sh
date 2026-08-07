#!/usr/bin/env bash
# Validates one commit message against the repository's commit rules.
#
# The rules themselves are not new — CLAUDE.md has required Conventional
# Commits and a `Spec: NNN` / `ADR: NNNN` trailer throughout. What was new is
# that anything enforced them outside a Claude Code session: `guard-commit.sh`
# is wired only as a PreToolUse Bash hook, `.git/hooks/` was empty,
# `core.hooksPath` was unset, and CI inspected no messages. A commit typed
# directly into a terminal met no gate at all, which is exactly how a commit
# with no trailer reached `main`.
#
# Kept as one script so the git hook and the CI job cannot drift into
# disagreeing about what a valid message is. Reads the message from the file
# named by $1, or from stdin.
set -euo pipefail

message=$(if [ "${1:-}" = '' ] || [ "${1:-}" = '-' ]; then cat; else cat "$1"; fi)

# Strip comment lines git adds to the editor buffer, so its instructions are
# never mistaken for the message.
subject=$(printf '%s\n' "$message" | grep -v '^#' | grep -vE '^[[:space:]]*$' | head -n 1)

fail() {
  printf 'Rejected commit message: %s\n\n' "$1" >&2
  printf '  subject: %s\n\n' "${subject:-(empty)}" >&2
  printf 'Required: a Conventional Commits subject, and a Spec: NNN or ADR: NNNN trailer.\n' >&2
  printf 'Example:\n\n  fix(api): reject a cursor issued for another tenant\n\n  Spec: 024\n\n' >&2
  printf 'If no approved spec covers the work, draft one first (specs/README.md).\n' >&2
  exit 1
}

# A merge or revert commit git generates itself carries no spec of its own.
case "$subject" in
  'Merge '* | 'Revert '*) exit 0 ;;
esac

printf '%s' "$subject" \
  | grep -qE '^(feat|fix|docs|refactor|test|build|ci|chore|perf|revert)(\([^)]*\))?!?: .+' \
  || fail 'the subject is not a Conventional Commit'

printf '%s\n' "$message" \
  | grep -qE '^(Spec:[[:space:]]*[0-9]{3}|ADR:[[:space:]]*[0-9]{4})[[:space:]]*$' \
  || fail 'no Spec: NNN or ADR: NNNN trailer'
