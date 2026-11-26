# Training Load M-2 bridge (v99)

This migration stages the existing Schedule Manage word for native club admins and team coaches, including their live versions and customs. The bridge enforces the staged word and the existing View word in SQL on the seven staff writes. It keeps the ordinary native `/me` projection and role editor unchanged. The second M-2 release exposes the word after the older writers have been retired.

## Preflight and rehearsal

1. On isolated loopback PostgreSQL 17, run the rehearsal using Node 20 or newer. The PowerShell wrapper accepts `DATABASE_URL` or `PGPASSWORD`, or prompts for the password without displaying it. Both wrappers reject a remote test target. Use `backend/scripts/training-load-m2-v99-rehearsal.sh` or `backend/scripts/training-load-m2-v99-rehearsal.ps1`.
2. Verify the actual previous application build on a migrated disposable database. Prove that all seven staff writes and full-list/copy/version/default/custom/end role operations keep their legacy behavior and preserve the staged word. Repeat on the exact bridge build and confirm native writer refusal on missing authority. A gap in preserving the staged word blocks the release.
3. With a production order, run the read-only `training-load-m2-v99-preflight.sql` during a quiet period. Verify the v98 migration checksum and permission body, an unused v99 prefix and the exact v99 file checksum. Keep the previous app build ready until the bridge build is healthy. The v99 migration does not change Calendar v98's activation state.

## Postcheck and retirement

Run the read-only `training-load-m2-v99-postcheck.sql`. Verify one correct migration row, the new word and permission body, seed counts and the expected Calendar v98 activation state. The first checked write timestamp may become non-null as staff use the bridge. Confirm the new build and record the rollout.

Release 2 requires authoritative evidence that older writers have stopped serving. Verify the rollout/instance retirement for the Render service and any other process that serves these endpoints. A successful health response on one replica is insufficient. Render's [zero-downtime deployment sequence](https://render.com/docs/deploys#zero-downtime-deploys) includes a drain and shutdown interval per instance. Keep the word uneditable if the rollout cannot be proven complete. The mobile Calendar PR and Calendar v98 activation are separate releases.

## Rollback

Before exposure and the first checked write, drain the bridge and earlier writers. Run `training-load-m2-v99-rollback.sql` only with a separate order, during a quiet moment. It refuses after checked use, a later migration, a changed function body, modified or additional grants and changed seeded revisions. When it succeeds, it restores v98's function body, the exact seed layers and their audited revisions. All audited guards are restored in the same transaction. After checked use, migrate forward. After exposure, do not restart an older writer which ignores changed permissions.
