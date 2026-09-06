#!/usr/bin/env bash
# Runs the smoke test and, on failure, copies the failing TAP blocks into the GitHub job summary
# so the reason is readable on the public run page without opening the (login-only) logs.
#   scripts/ci-smoke.sh <label>      (TEST_DB_URL selects the engine; unset = SQLite)
set -o pipefail
label="${1:-smoke}"
log="smoke-${label}.log"
if pnpm smoke 2>&1 | tee "$log"; then
  echo "✅ smoke (${label}) passed" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 0
fi
{
  echo "### ❌ smoke (${label}) failed"
  echo '```'
  grep -n -B2 -A30 -E "^\s*not ok|\[error\]|Error:" "$log" | head -250
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit 1
