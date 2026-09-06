#!/usr/bin/env bash
# Apply the full schema to a fresh PostgreSQL 16 database.
#   DATABASE_URL=postgres://user:pass@host:5432/pathshala ./db/apply.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${DATABASE_URL:?set DATABASE_URL}"
for f in schema/*.sql; do
  echo ">> $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "schema applied"
