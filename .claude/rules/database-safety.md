# Database safety

Applies to every database-touching action — SQL tools, migration runs, seed scripts,
ad-hoc queries — regardless of which database.

## The one thing that's automatic

Creating, changing, or dropping a **disposable, uniquely-named test database** — created
and destroyed within the same session, never referenced anywhere else — needs no
confirmation.

Everything else below needs explicit, current-session confirmation before any operation
that changes data or schema. No exceptions, no matter how safe the change looks.

## Databases that always need confirmation first

- The local persistent **OPTIMOVE** dev database.
- Any shared dev database.
- Staging.
- Production.
- **monitoring2** — this is the reference database used for porting modules into
  OptiMove; treat it as **read-only** unless a task explicitly, specifically asks for a
  write to it. Reading from it to compare/port schema or logic needs no special
  confirmation; writing to it does.

## Before any confirmed write

- Print and verify the actual **host, port, and database name** from the real connection
  that will be used — never assume from an env var's name alone.
- Never trust `DATABASE_URL` blindly — parse and display host/port/dbname from the
  string before running anything against it.
- Confirmation for one operation does not carry over to the next. Production especially:
  a prior "yes, run migrations" does not cover a new, different production migration —
  each one gets its own explicit confirmation.

## Migrations specifically

See `migrations.md` for the migration-file contract itself. The database-safety rule
that applies on top of it: never apply a migration to a persistent database
automatically, regardless of how the migration file itself looks (see `migrations.md`
for the runner's own checksum/immutability protections, which are a different layer from
this confirmation requirement).

## Known, deliberate compromises — don't copy them to new connections unnecessarily

- `backend/src/db.js`'s `ssl: { rejectUnauthorized: false }` is a known, deliberate compromise for
  the Supabase pooler connection (its certificate isn't in Node's default trust store),
  not a general pattern. Before copying it to a new DB connection or service, check
  whether the same reason actually applies there.
