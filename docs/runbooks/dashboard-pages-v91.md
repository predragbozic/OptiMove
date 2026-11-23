# Dashboard Pages B — Page writers and receipts

## Safety and evidence

This is an owner-operated runbook, not approval to execute production SQL. PostgreSQL 17 and Node 22 are required for the local rehearsal. Never disable a trigger or set session_replication_role. Every boolean returned by preflight/postcheck must be true; retain outputs privately. Compare per-dashboard ids, counts and digests before and after at a quiet moment; a changed digest is a stop, even if the total count matches. Digests include revisions and timestamps.

The supplied owner evidence is a historical snapshot, not a substitute for the immediate preflight. The owner confirmed v90/v91 reserved and supplied the exact optional v87/v88/v89 filenames/checksums (migration-registry.json). v86 is unused. Optional files may be absent or recorded in either order, including production v89 before v88. Refresh main and obtain final registry confirmation before freezing. Do not infer a schema dependency from their version labels.

Local rehearsal (no production connection):

```powershell
./backend/scripts/dashboard-pages-rehearsal.ps1 -Port 55439 -PgBin 'C:/Program Files/PostgreSQL/17/bin'
```

The shell equivalent is backend/scripts/dashboard-pages-rehearsal.sh --port 55439 --pg-bin /path/to/pg17/bin. Each test owns and drops a disposable database. Success is the final RESULT: PASS. Run without concurrent database gates on that PostgreSQL instance: the runner audits newly created databases. The old binary is an unchanged git archive of aa6e765c86525f23d4ff970c9fa550b4183bae01, overridden only by a full owner-confirmed SHA.

## Preflight and separate deployment

A must already be applied and postchecked under its own owner order. Keep DASHBOARD_PAGES_ENABLED=false and the database activation row false. Run the A postcheck, then dashboard-pages-v91-preflight.sql read-only. B validates the exact A checksum and all fourteen A function bodies. It creates new functions and ledger only; no A body is replaced.

After a separate owner order naming B, deploy the reviewed artifact through the normal migration runner; it must skip A with matching checksum and apply B once. Run dashboard-pages-v91-postcheck.sql, compare all dashboard/widget/series digests, and verify both switches remain closed. Old code still cannot create a second Page.

## Activation boundary

Only after all old instances are drained and the new build is healthy, the owner may separately order the database activation row enabled and DASHBOARD_PAGES_ENABLED=true. Until both are true the UI offers no Pages and Page routes cannot write. Pages inherit dashboard rights; they introduce no new audience. A successful copy creates new widget and series identities. Request ids and issued-at timestamps must be retained on unknown-result retry. The existing retention schedule purges only expired receipts, in bounded batches.

## Rollback

Switch the server feature off first. Closing activation stops Page use but does not undo data. The B rollback refuses any non-Home Page, Page receipt, Page-aware Simple receipt, later migration or changed owned function. Do not delete receipts or Pages to bypass it. If any refusal fires, retain the data and seek a forward fix. If rollback is permitted, run dashboard-pages-v91-rollback.sql, verify the A catalog and postcheck, then separately consider A rollback. The local rehearsal proves B apply → rollback → identical A catalog → reapply.

## One-file order safety

The A-only helper includes A and checksum-verified already-recorded files. Missing optional v87/v88/v89 files are deliberately omitted; another missing prerequisite aborts. It never applies an unrecorded independent migration under the A order.

Before normal application startup for B, compare every migration in the deployed artifact with the database registry: B must be the only unrecorded file. Optional absence is valid for the P1 schema contract, but is not permission for npm start to install unrelated files. If any other file is pending, stop the B deployment until it has its own owner order and postcheck.

## Explicit activation and switch-off commands

After B postcheck, confirm the exact deployed build and drain every old instance. On the owner's separate activation order, first set DASHBOARD_PAGES_ENABLED=true while the database switch remains false; restart/verify the new build. The capability must still be absent. The owner then executes:

```sql
begin;
set local lock_timeout='5s';
update training_load.dashboard_pages_activation set enabled=true where singleton;
select singleton,enabled from training_load.dashboard_pages_activation;
commit;
```

Expect exactly one row, true/true. Reload the dashboard and smoke-test Home, a new Page and copy with the intended viewer roles. To stop new Page use, set DASHBOARD_PAGES_ENABLED=false, drain in-flight requests, then set the database row enabled=false. This preserves data and receipts; it does not authorize a rollback past its refusal gates. None of these production commands has been executed by this PR.
