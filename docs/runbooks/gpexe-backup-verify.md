# Verified backup before a GPEXE import

A backup counts only if it has been restored once and the restored copy has
been compared with the source. A `pg_dump` that exited 0 is not enough (owner
decision 2026-09-18).

Script: `backend/scripts/gpexe-backup-verify.mjs`.
Proof: `backend/tests/gpexe-backup-verify.test.mjs`, on disposable databases.

Two modes:
- **the local database** (below, "How to run it"): source and trial restore on this machine;
- **the deployed database (Supabase), from the owner's own Windows computer** — the owner's decision of 2026-11-01
  for J17's O2 („O2: backup ručnim pg_dump-om sa mog računara i proverom vraćanja u lokalni Postgres. Pripremi postupak
  u 9-R.”): see "The deployed database (Supabase), from the owner's computer" further down. Only the owner runs it.

## How to run it

```
node --env-file=backend/.env backend/scripts/gpexe-backup-verify.mjs \
  --dump C:/Users/<you>/backups/optimove-before-gpexe-<date>.dump \
  --pg-bin "C:/Program Files/PostgreSQL/17/bin"
```

- The source is `DATABASE_URL`, or `--database-url`. It must be on this machine
  (`localhost`). The script refuses anything else, so it is not a tool for the
  deployed database. A URL with a query string is refused too, because
  `?host=...` would redirect the connection past that check. After
  connecting, the script also verifies that the server's own address is local
  and that the database name matches.
- `pg_dump` and `pg_restore` inherit **no libpq variable** from the shell they
  are started from. The script removes `PGHOST`, `PGHOSTADDR`, `PGPORT`,
  `PGUSER`, `PGDATABASE`, `PGSERVICE`, `PGSERVICEFILE`, `PGPASSFILE`,
  `PGOPTIONS`, `PGSSLMODE` and every other `PG*` variable. Host, port, user and
  database are passed as explicit arguments, with `--no-password`. The password
  is the only thing passed through the environment, never on the command line.
  A leftover `PGHOSTADDR` would otherwise send the tool to a different server
  than the one that was checked. A database name that libpq would read as a
  connection string (containing `=` or starting with `postgres:`) is refused.
- The source is **only read**. The trial restore goes into a new database,
  `optimove_tests_gpexe_restore_<random>`, on the same server. The script drops
  that database at the end in every case and checks that it is gone.
- `--dump` must be a new file. An existing file is never overwritten. A path
  inside any git work tree is refused, because the dump holds personal data
  (athletes, users, password hashes) and must never end up in a repository.
- `pg_dump` must be at least the server's major version. Check the output of
  `pg_dump --version`.

It prints `VERIFIED` and exits 0, or prints the differences and exits 1.

## What is compared

The dump and the source fingerprint are taken from **one snapshot**. The script
opens a read-only `REPEATABLE READ` transaction and exports its snapshot. It
then runs `pg_dump --snapshot=<that snapshot>` and reads the source fingerprint
inside the same transaction. A write to the source while the backup runs is in
neither, so the dump and the fingerprint always describe the same state. The
test proves this with a write made right after the snapshot.

For every schema other than the system ones:

| What | How |
|---|---|
| Every table | Row count, plus an order-independent digest of every row's full text (md5 of the sorted per-row md5s). One changed number with the same row count is caught. |
| Columns | Name, type, not null, default |
| Constraints | Full definition, character by character, with one exception. Postgres re-prints an `IN (...)` list whose elements are cast as a whole (`(ARRAY['a'::character varying])::text[]`) with each element cast on its own after a restore (`ARRAY[('a'::character varying)::text]`). Only that exact shape is rewritten to one form on both sides. Casts, parentheses and AND/OR grouping are otherwise compared as they are, and a narrowed `CHECK` is caught. |
| Indexes | Full definition. A partial index's `WHERE` gets the same single rewrite as a `CHECK`. |
| Views, functions | Full definition, as a digest |
| Triggers | Definition **and whether each one is enabled**. A copy whose protective triggers came back disabled is not the same database. |
| Sequences | Last value |
| Extensions, schemas | Name and version |

`schema_migrations` is a table, so it is compared row by row, checksums
included.

**Not compared** (the report lists them under `notCompared`):
- ownership and privileges (the restore uses `--no-owner --no-privileges`);
- database-level settings and roles;
- domain constraints, comments and rules;
- row-level security policies and flags;
- storage options, enum labels, materialized view contents and large objects.

None of these exists in `migrations_v2` today. If one is introduced, add it to
the fingerprint first.

A sequence advanced by a
concurrent writer while the backup runs shows up as a difference. Sequences are
not transactional, so that is a false alarm on the safe side: run it again.

## What the result means

- **Verified:** the dump file is kept next to `<dump>.verify.json`. That report
  holds the source (host, port and database name, never the password), the
  dump's size and sha256, the server and `pg_dump` versions, and the number of
  tables, rows and catalog objects compared. Keep both together with the
  import's run report.
- **Not verified:** the dump is **deleted**, the differences are printed, and
  the script exits 1. Do not import.

A dump counts as verified **only when its `.verify.json` sits next to it**,
and the sha256 recorded there matches the file. The report is written last, and
only after a successful comparison. While a run is in progress, or after one was
killed outright, a dump file can exist without its report. Treat such a file as
unverified and delete it.

## The deployed database (Supabase), from the owner's computer

**Who:** the owner only, on his own Windows computer. Nobody else runs it: not the executor, not the *Rukovodilac*.
It only **reads** the deployed database; the trial restore goes into a new, throwaway database on the owner's local
Postgres, which the script drops at the end.

### Once: what the computer needs

1. **PostgreSQL 17 for Windows** (the EDB installer from postgresql.org, version 17.x): the "PostgreSQL Server" and
   "Command Line Tools" components. The deployed server is PostgreSQL 17.6, and `pg_dump` / `pg_restore` must be at
   least the server's major version. Check in PowerShell:
   `& "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" --version` → `pg_dump (PostgreSQL) 17.x`.
   The installer's local server is the restore target (usually `localhost:5432`, user `postgres`, the password chosen
   at installation).
2. **Node.js** and the repository checkout with its backend packages installed (`npm --prefix backend install`), as
   for running the app locally, and **git** on the PATH (the script uses git to refuse a dump path inside a
   repository).
3. **A folder for the backups**, created once, for example `C:\OptiMove-backups`:
   - **outside** every git checkout, and **outside** OneDrive, Dropbox or any other synced folder (Windows often syncs
     Documents and Desktop to OneDrive);
   - on a disk protected by BitLocker (Windows device encryption);
   - the dump holds personal data (athletes, users, password hashes, GPEXE identities): it is **never** attached,
     uploaded, sent or copied anywhere.

### Each time: the connection string, without the password

In the Supabase dashboard: the project → **Connect** → **Session pooler** (port **5432**). Never the transaction
pooler (port 6543): the script holds one database snapshot open while `pg_dump` reads it, which needs one session.
Copy the URL **without** the password, so it reads
`postgresql://postgres.<project-ref>@<pooler-host>:5432/postgres`. A URL that carries a password is refused: both
passwords are typed when asked and are never on a command line, in a file or in the shell's history.

TLS is always on: `sslmode=require` by default (the traffic is encrypted). For full certificate verification,
download the project's CA certificate (Supabase dashboard → Database settings → SSL configuration) and add
`--ssl-root-cert <path to the .crt>`; the script then uses `verify-full`.

### Run (PowerShell, from the repository folder)

```
node backend/scripts/gpexe-backup-verify.mjs --remote-source `
  --source-url "postgresql://postgres.<project-ref>@<pooler-host>:5432/postgres" `
  --restore-url "postgresql://postgres@localhost:5432/postgres" `
  --dump C:/OptiMove-backups/optimove-production-<YYYY-MM-DD>.dump `
  --pg-bin "C:/Program Files/PostgreSQL/17/bin"
```

It asks, without echo, for the deployed database's password (Supabase dashboard → Database settings) and then for
the local Postgres password (Enter if there is none).

What it does — the local mode's procedure, with these differences:
- it dumps and compares **only the application's schemas**: `calendar`, `library`, `media`, `plans`, `public`,
  `tests`, `training`, `training_load` (`pg_dump --schema … --strict-names`). Supabase's own schemas (`auth`,
  `storage`, `extensions`, `realtime`, `vault`, …) are left out: they are not the application's, and a plain Postgres
  could not restore them;
- **any other schema** the deployed database has that is neither listed nor known as Supabase's stops the run
  before anything is dumped. Stop and report the schema's **name** (no data). Only when it is certainly not the
  application's may it be named with `--skip-schema <name>` on a new run; the report lists it under
  `schemasSkippedByOwner`;
- extensions installed into one of those schemas are listed (`extensionsInDumpedSchemas`), not dumped; their objects
  are left out of the comparison on both sides;
- the trial restore runs on the local Postgres (`--restore-url` must be this machine) into a new database
  `optimove_tests_gpexe_restore_<random>`, dropped at the end.

A CHECK constraint that only comes back printed with a different grouping (Postgres flattens nested ANDs when it
parses the dump again) is compared after Postgres itself re-parses the source's definition in the throwaway
database; the report names it under `reprintedChecks`. A narrowed CHECK is still a difference. The same applies to the
local mode.

### The result

- **`VERIFIED`**: next to the dump sits `<dump>.verify.json`. Check in it, without copying any data anywhere:
  `verified: true`; `schemas` (the eight above); `schemasLeftOut` (only Supabase's own); `schemasSkippedByOwner`
  (empty, unless you decided otherwise); `tablesCompared` and `rowsCompared`; `restoreDropped: true`.
- **`VERIFICATION FAILED`** or any `refusing:` / `SAFETY:` / `pg_restore: error` line: the dump is deleted (or was
  never written). Do not turn the import switch on. Report only the first error line and, for a difference, the table
  or catalog **names** the script printed — never row data.

### The record row

Before the import switch is turned on, the row of the table in `docs/runbooks/gpexe-in-app-import.md` ("Turning the
import switch on") is filled in for this backup, **without** the host, the project reference or any password:

| Environment | Backup path or identifier | `.verify.json` (path, sha256) | Verified at | Confirmed by | Switch on at | Switch off at |
|---|---|---|---|---|---|---|
| production (Supabase) | `optimove-production-<YYYY-MM-DD>.dump` (on the owner's computer) | `….dump.verify.json`, the dump's sha256 from the report | `<UTC time of VERIFIED>` | owner | — | — |

### Keeping and deleting

Keep the verified dump and its report together until the import it protects has passed its post-check and the owner
decides it is no longer needed; then delete both. A dump without its report next to it is unverified: delete it.

### What it does not do

- It never writes to the deployed database, and it does not restore over it. Restoring over the deployed database
  after a bad import is a separate decision (J17, O3), not scripted here.
- It does not back up Supabase's own schemas (logins of the Supabase dashboard, storage objects) or the media files in
  object storage (R2): only the application's database schemas.

## Restoring for real

This procedure proves the dump can be restored. Restoring it over the real
database after a bad import is a separate operation that needs its own explicit
decision, and it is not scripted here. Undoing a single imported session is
done with `docs/runbooks/gpexe-undo-imported-session.md`, not with a restore.
