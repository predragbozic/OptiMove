# Tests Schedule Manage bridge design

The local boundary is `ed848e9720311a1e91abd370ac8abb29d994cafe`.
The scope comes from Stage T of `docs/ai/tests-messages-manage-contract.md` at
`5d837ff6e3a1d639e4e12d911a6364fa9450bd11` and the later compatibility
decisions for existing destination ownership, links, and reminders.
Reserve a migration after the Builder, Programs and Exercises releases in
the agreed R4 order. Pin the full SHA of the build actually serving when
this bridge is cut, its migration registry and permission-body digest.

## What counts as first use

Use one durable first-use timestamp. Set it inside the same transaction as
the first successful native write protected by `tests.view` and
`tests.schedule.manage` at the destination. Set it once and only when an
effect commits. A standalone team has no club ceiling and still requires
its actor and scoped permission checks.

| HTTP operation under /api/tests | Effect that counts as use |
| --- | --- |
| POST `/schedules`, POST `/schedules/bulk` | At least one schedule is inserted. Include targets and optional notification rules in the same transaction. |
| PATCH `/schedules/:scheduleId` | A persisted status, schedule, target or notification-rule change. A side-effect-free no-op does not count. |
| DELETE `/schedules/:scheduleId` | Physical deletion or cancellation with history, including any link revocation in that transaction. A repeated cancellation without a new effect does not count. |
| POST `/schedules/:scheduleId/link`, POST `/links/:linkId/revoke` | A token is inserted or an active link is revoked. Re-revoking an already ended link does not count. |
| POST `/schedules/:scheduleId/remind` | At least one notification is inserted. Cooldown, ineligible assignments and an empty send do not count. Emit realtime only after COMMIT. |

Denials, rolled-back writes, previews, existing platform and private paths,
athlete check-in and self submission, Calendar's automatic schedule writes
and background processing leave the timestamp unchanged. Record database
changes, rather than HTTP statuses, to distinguish a no-op from a write.
No generic receipt or new retry guarantees are proposed.

## Destination and targets

New native schedules use the locked active workspace as their owner. Edits use
the locked schedule owner, including when the actor has valid rights at that
destination and another workspace is active. Club schedules can target that
club, its active teams or its current athletes. Team schedules can target only
that team or its current athletes. The existing target entitlement still
applies. Private and platform target handling remains on its existing path.

Pause, delete and other non-target operations preserve historical targets.
Resume and full edits validate the resulting target set even if the request
omits it. An explicit in-scope replacement can correct a historical schedule.
A manual reminder for an assignment beyond the native owner returns the same
outcome as a missing assignment and sends no notification. Calendar's parent
command retains its separate authority and does not use these Tests gates.

## Seed, preflight and rollback

Stage the existing role word in the database before exposing it through
Settings or the native permission projection. Seed only the native
Club admin and Team coach roles and their applicable live club versions
and held custom roles that need to preserve predecessor authority.
Audit the exact changed layers, items, and revisions. Preserve unrelated
grants, pending default-change acknowledgements, historical and expired
holdings, and managed scopes. Use normal role guards, sorted club ceiling
locks and the approved R4 audit pattern.

Preflight compares required migration files by name and checksum, the
permission body by digest, the seed candidates, and the migration registry.
Postcheck verifies the new checksum, body, audit and seed counts, and a
null first-use timestamp before serving bridge writes. Verify the old
server against that migrated database and keep Settings exposure closed
until the exact previous writers are retired. Then rehearse the bridge
alongside the exposure candidate before granting the word in production.

Drain writers before rollback. Refuse after first checked use, a later
migration, changed prerequisite or permission body, unexpected audit/seed
changes or a seeded row that no longer matches. Restore only the staged
word, its audited layers and the prior permission body. Keep unrelated
role assignments, their receipts, and schedule/check-in history intact.
Rehearse apply → rollback → identical relevant catalogue and seed state →
reapply on private PostgreSQL 17. Also prove rollback refusal after real
use, plus successful rollback after a denied, no-op or rolled-back action.

## Exact predecessor overlap and final gate

Run both binaries against the same migrated disposable database and
record the previous build's full SHA. Create and bulk-create in the
active native workspace. Edit, delete, issue/rotate/revoke and remind
through the actual destination. Cover same-club team delegation, a direct
coach with another active team, and an administrator with multiple club
holdings. Pin existing foreign/missing responses, the staff-only
Calendar-owned edit/delete refusal and ordinary athlete/check-in and
worker behavior. Test that a queued request rechecks the actor, both
permission words, destination ownership and licence before any write.
Exercise the schedule → link lock order against predecessor rotation and
the schedule → occurrence → assignment order against submission and
reminders. Denials do not mint or disclose a token, change rows, enqueue a
notification or emit realtime.

In the mixed-version rehearsal, hold a schedule or link while both builds
try to rotate and revoke it. Check the previous writer's schedule foreign
key wait against the bridge's schedule row lock, and verify a single active
link and no deadlock. For platform and private owners, hold a schedule or
link past the bridge's five-second transaction-local lock wait and confirm
the request rolls back. Exercise normal retry after the blocker releases.
Check that missing and unauthorized requests still use their route's
existing response without waiting on a foreign row.

Native View schedule detail still includes an issued token. The V-4
view workspace still omits it and refuses staff writes. Narrowing native
token reads is a separate undecided product change. Link denials keep
404. Manual reminders keep 404 for a missing schedule and 403 for an
existing unmanaged schedule. The overlap must reproduce these responses
and preserve token access mode, cooldown, dedupe and post-commit realtime.

The local route checkpoint passed 50 schedule-management and 16
manual-reminder tests with Node 22 on private PostgreSQL 17. Browser V-4
passed three view-only cases. These runs used a disposable-only role
fixture. The release still needs exact predecessor and exposure overlap,
full backend disposable, frontend-fast, build, relevant browser Tests and
Calendar regressions, and independent review on the frozen release head.
