#!/usr/bin/env bash
# ============================================================
#  CineHall — drop, recreate and reseed the database.
#
#  Usage:
#    ./database/reset.sh              # use DATABASE_URL from .env
#    ./database/reset.sh --keep-data  # recreate schema only, no seed
#
#  WARNING: this DELETES ALL DATA. It is meant for local development.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Load DATABASE_URL from .env if it is there.
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL is not set and no .env was found." >&2
  echo "       Expected something like:" >&2
  echo "       DATABASE_URL=postgresql://cinehall:cinehall@127.0.0.1:55432/cinehall" >&2
  exit 1
fi

echo "Target: $DATABASE_URL"
read -r -p "This will DROP and recreate the public schema. Continue? [y/N] " reply
case "$reply" in
  [yY]|[yY][eE][sS]) ;;
  *) echo "aborted."; exit 0 ;;
esac

echo "--- dropping public schema ---"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO public;
SQL

echo "--- applying schema.sql ---"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$SCRIPT_DIR/schema.sql"

if [[ "${1:-}" == "--keep-data" ]]; then
  echo "--- schema only (--keep-data), skipping seed ---"
  exit 0
fi

echo "--- applying seed.sql ---"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/seed.sql"

echo "--- done ---"
