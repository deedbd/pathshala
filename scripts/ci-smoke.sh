#!/usr/bin/env bash
# Runs the smoke suite and, on failure, makes the reason readable without opening the (login-only)
# logs: every failing test becomes a `::error::` annotation, which the checks API returns, and the
# failing TAP blocks go into the job summary on the public run page.
#   scripts/ci-smoke.sh <label>      (TEST_DB_URL selects the engine; unset = SQLite)
set -o pipefail
label="${1:-smoke}"
log="smoke-${label}.log"
if pnpm smoke 2>&1 | tee "$log"; then
  echo "✅ smoke (${label}) passed" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 0
fi

# one annotation per failing test: its name and the first lines of its error
awk -v label="$label" '
  /not ok [0-9]+ - / { name = $0; sub(/.*not ok [0-9]+ - /, "", name); grab = 0; msg = ""; seen = 1; next }
  seen && /error:/ { grab = 1; line = $0; sub(/.*error:[[:space:]]*/, "", line); if (line != "|-" && line != "") msg = line; next }
  seen && grab && /^[[:space:]]*(code|stack|expected|actual|operator):/ {
    if (msg != "") { gsub(/%/, "%%", msg); printf "::error title=smoke %s::%s — %s\n", label, name, msg }
    grab = 0; seen = 0; next
  }
  seen && grab {
    line = $0; gsub(/^[[:space:]]+|[[:space:]]+$/, "", line);
    if (line != "" && length(msg) < 300) msg = (msg == "" ? line : msg " " line);
    next
  }
' "$log"

{
  echo "### ❌ smoke (${label}) failed"
  echo '```'
  grep -n -B2 -A30 -E "^\s*not ok|\[error\]|Error:" "$log" | head -250
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit 1
