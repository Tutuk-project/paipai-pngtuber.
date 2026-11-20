from pathlib import Path
from pglast import parse_sql

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))

if not MIGRATIONS:
    raise SystemExit("No Supabase migrations found.")

failed = []
for migration in MIGRATIONS:
    try:
        statements = parse_sql(migration.read_text(encoding="utf-8"))
        print(f"PASS {migration.name}: {len(statements)} SQL statement(s)")
    except Exception as error:
        failed.append((migration.name, str(error)))
        print(f"FAIL {migration.name}: {error}")

if failed:
    raise SystemExit(f"{len(failed)} migration file(s) failed PostgreSQL parsing.")
print(f"Validated {len(MIGRATIONS)} migration file(s).")
