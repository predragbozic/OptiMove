# Verified backup before a GPEXE import

A backup counts only if it has been restored once and the restored copy has
been compared with the source. A `pg_dump` that exited 0 is not enough (owner
decision 2026-09-18).

Script: `backend/scripts/gpexe-backup-verify.mjs`.
Proof: `backend/tests/gpexe-backup-verify.test.mjs`, on disposable databases.

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

## Restoring for real

This procedure proves the dump can be restored. Restoring it over the real
database after a bad import is a separate operation that needs its own explicit
decision, and it is not scripted here. Undoing a single imported session is
done with `docs/runbooks/gpexe-undo-imported-session.md`, not with a restore.
