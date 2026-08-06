#!/usr/bin/env bash
# SessionStart: make the governance gate visible to the agent.
set -euo pipefail
cat <<'EOF'
Blotato comments governance is active:
- Read the relevant docs before changing implementation or contracts.
- Do not change business logic, API/database/provider contracts, dependencies, or architecture without an approved spec.
- Draft proposed specs with approved: no; only the human maintainer may approve them.
- Record architectural decisions in docs/decisions/.
- Commits require a Spec: NNN or ADR: NNNN trailer.
EOF
exit 0
