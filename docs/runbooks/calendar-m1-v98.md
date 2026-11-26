# Calendar M-1 (v98)

The migration makes `calendar.events.manage` and `calendar.settings.manage` effective in their own scopes. Existing native club admins keep event and Settings access. Existing native team coaches keep event access. Platform support, private coaching and athlete self actions keep their previous rules. View workspaces stay read-only. The migration seeds the basic roles and their live versions and customs through the permission audit.

## Before the migration

1. Run `calendar-m1-v98-preflight.sql` against the approved target in a quiet moment. Verify the prerequisite records and four function MD5s. Confirm the migration file checksum against the reviewed release.
2. Run the rehearsal on isolated PostgreSQL. Set `DATABASE_URL` to a loopback maintenance server, then use `backend/scripts/calendar-m1-v98-rehearsal.sh` or the PowerShell equivalent. The PowerShell wrapper can prompt securely for a local server. The runner creates and drops only disposable databases.
3. Keep the previous deployment available until the candidate is healthy. The migration leaves activation false. Existing calendar writers and v93 deletes can finish under their existing authority before activation. New writers already use the checked entry points.

## After migration

Run `calendar-m1-v98-postcheck.sql`. Verify the migration row and its checksum, the seed counts, the four replaced and eight added body MD5s and the closed activation state. Test signed-in native reads and the distinct Event and Settings grants in a disposable rehearsal. A checked real write sets the first-use timestamp and makes SQL rollback forward-fix only.

## Activation

After the previous build is confirmed drained, run `calendar-m1-v98-activation.sql` under the separate recorded owner authorization. The transaction takes an exclusive advisory lock and waits for older Calendar writes, while no resource rows are locked by activation. Re-run the postcheck and confirm activation true. Checked replay continues for an authorized writer. Legacy event writers and v93 delete, including direct invocation of the legacy procedure, are refused.

The runtime keeps the existing request-key lock after prepare in both binaries. The authorization guard takes the shared cutover and ceiling locks before owner or rights rows. Native writes lock and recheck the permission rows, then lock the target, then inspect receipts or write. The v93 receipt insert guard independently rechecks the operation. Database-owner access can modify the schema and is reserved for operation of the database. The browser uses application routes.

## Rollback

Before activation the previous application build remains compatible. SQL rollback requires its own authorization, a quiet moment and that the new writer is drained. Run `calendar-m1-v98-rollback.sql` only when its checks permit it. It refuses after live use, activation, a later migration, modified functions, altered seeded revisions, or changed Calendar permission grants. It restores only the seeded rows and original function bodies, with all named audit triggers restored in the same transaction. After activation use a forward fix.
