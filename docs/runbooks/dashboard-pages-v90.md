# Dashboard Pages A — compatible Home schema

## Safety and evidence

This is an owner-operated runbook, not approval to execute production SQL. PostgreSQL 17 and Node 22 are required for the local rehearsal. Never disable a trigger or set session_replication_role. Every boolean returned by preflight/postcheck must be true; retain outputs privately. Compare per-dashboard ids, counts and digests before and after at a quiet moment; a changed digest is a stop, even if the total count matches. Digests include revisions and timestamps.

The supplied owner evidence is a historical snapshot, not a substitute for the immediate preflight. The owner confirmed v90/v91 reserved and supplied the exact optional v87/v88/v89 filenames/checksums (migration-registry.json). v86 is unused. Optional files may be absent or recorded in either order, including production v89 before v88. Refresh main and obtain final registry confirmation before freezing. Do not infer a schema dependency from their version labels.

Local rehearsal (no production connection):

```powershell
./backend/scripts/dashboard-pages-rehearsal.ps1 -Port 55439 -PgBin 'C:/Program Files/PostgreSQL/17/bin'
```

The shell equivalent is backend/scripts/dashboard-pages-rehearsal.sh --port 55439 --pg-bin /path/to/pg17/bin. Each test owns and drops a disposable database. Success is the final RESULT: PASS. Run without concurrent database gates on that PostgreSQL instance: the runner audits newly created databases. The old binary is an unchanged git archive of aa6e765c86525f23d4ff970c9fa550b4183bae01, overridden only by a full owner-confirmed SHA.

## Owner order and deploy boundary

A and B are separate production orders even though one PR contains both. A must be recorded and postchecked while the old build is serving, before an artifact containing both files is started. Do not run npm start from the combined artifact against a database without A: the runner would apply both in one startup. Run `node backend/scripts/dashboard-pages-stage-a.mjs --apply 202611231000_training_load_v90_dashboard_pages_home.sql` from the reviewed artifact. It creates an A-only migration directory and uses the repository migrator, normal advisory lock and checksum recording. Do not apply bare SQL and invent a migration record. The artifact SHA and this exact command are part of the owner order; no production execution has been performed here.

1. Keep DASHBOARD_PAGES_ENABLED=false. Read the deployed SHA and refresh the old-server rehearsal if it differs. Confirm migration slots and freeze checksums.
2. Choose a quiet moment; run dashboard-pages-v90-preflight.sql read-only. Check no open transaction, all trigger names/bodies and all required prior migrations. Save per-dashboard digests. A itself repeats exact trigger/body gates and uses lock_timeout 5s, statement_timeout 30s.
3. Owner explicitly orders A by its full filename. A holds ACCESS EXCLUSIVE on dashboard_widgets until COMMIT; the rehearsal reports migration timing. No trigger is disabled.
4. Run dashboard-pages-v90-postcheck.sql read-only and compare digests to preflight. Every dashboard has one Home, every widget remains on it, and every series is unchanged. Continue serving the previous binary until B is separately ordered.

## Rollback

Use dashboard-pages-v90-rollback.sql only with A as the last migration, feature off, activation closed, Home-only legacy-compatible state. It refuses later migrations, modified owned functions and changed Page state. It restores old bodies with md5 checks and removes only its own record. Never remove refusals. Restart only an artifact without A/B, otherwise the startup runner will reapply them. The disposable rehearsal proves apply → rollback → identical catalog → reapply and byte-identical legacy rows.

## One-file order safety

The A-only helper includes A and checksum-verified already-recorded files. Missing optional v87/v88/v89 files are deliberately omitted; another missing prerequisite aborts. It never applies an unrecorded independent migration under the A order.

Before normal application startup for B, compare every migration in the deployed artifact with the database registry: B must be the only unrecorded file. Optional absence is valid for the P1 schema contract, but is not permission for npm start to install unrelated files. If any other file is pending, stop the B deployment until it has its own owner order and postcheck.
