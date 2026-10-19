# BE-1: media storage foundation

Backend only. No upload/playback endpoint or R2 credential is enabled by this PR.
No frontend, Builder authorization, Training Load import, or legacy URL is changed.

## Activation and API

`MEDIA_STORAGE_ENABLED=false` is the default. New media routes return 503
`media_storage_disabled` without accessing media tables. Existing app routes run
unchanged. Turning the flag on enables **quota administration only**; BE-2 adds
R2 capabilities, verification and playback. Do not advertise upload as available.

All requests use the existing session and `req.authz`. Only actual platform
administrators can use `/api/admin/media`. `role_hint` and workspace preference
never grant permissions. Responses have `Cache-Control: no-store`.

- `GET /api/media/storage`: own user storage plus clubs actually administered by
  the actor; coach workspace capability required. Creates missing zero-usage
  storage rows only for those authorized owners. Athletes do not allocate storage.
- `GET /api/admin/media/storage-policy` -> `{policy, revision}`.
- `PATCH /api/admin/media/storage-policy` -> request
  `{changes, expectedRevision, reason}`; policy fields: `defaultLimitBytes`,
  `maxVideoBytes`, `maxImageBytes`, `maxParallelUploads`, `allowedMimeTypes`.
- `POST /api/admin/media/storage-accounts` with `{owner:{type:"user"|"club",id}}`
  provisions/returns an existing owner's usage row idempotently. This small
  addition lets an admin assign a limit before the owner's first usage request.
- `GET /api/admin/media/storage-accounts?limit=50&cursor=...&sort=used_desc`
  -> `{accounts,nextCursor}`. Only existing storage accounts, not all users.
- `GET /api/admin/media/storage-accounts/:id` -> usage.
- `PATCH /api/admin/media/storage-accounts/:id/limit` with
  `{limitBytes,expectedRevision,reason}` -> updated usage. Null clears override;
  string `"0"` disables new allocations. Reason is required (1-1000 characters).
- `GET /api/admin/media/storage-limit-audit?storageAccountId=...&limit=50&cursor=...`
  -> `{entries,nextCursor}`. Omit storageAccountId to include global policy changes.

Bytes are decimal strings; revisions/counts are numbers. Cursor is opaque.
Usage: `storageAccountId`, `owner:{type,id}`, `usedBytes`, `reservedBytes`,
`limitBytes`, `availableBytes`, `limitSource` (`default`/`override`), `overLimit`,
`activeUploads`, `maxParallelUploads`, `maxVideoBytes`, `maxImageBytes`,
`allowedMimeTypes`, `overrideLimitBytes`, `revision`.

Errors: `{error,code,retryable,details}`. 400 invalid_request; 401 session;
403 operation_not_allowed; 404 resource_not_found; 409 revision_conflict;
413 file_too_large; 415 unsupported_media; 422 media_verification_failed;
429 storage_quota_exceeded / parallel_upload_limit; 503 disabled or busy.
Busy responses are retryable. No media signing URL or storage key is returned.

## Defaults and future integration

Default quota is **zero**, until a platform administrator allocates space.
Initial per-file ceilings: 200 MiB video, 10 MiB image; parallel cap: 2.
These policy values are editable in the API. This allowlist describes permitted
containers, not codec validation; BE-2 must inspect bytes before activation.

`createMediaStorageService(pool)` accepts an existing backend pool. Reservation
and settlement are internal functions, NOT HTTP endpoints. BE-2 must first
resolve content ownership and authorize upload via existing exercise rules:
private content is charged to its individual owner, club content to its club.
No team quota account or workspace-preference authorization is introduced.

Lock order: idempotency advisory lock (reservation only), shared policy row,
account row. Admin default updates take an exclusive policy lock. Individual
updates and reservations lock policy then account. Settlement/cleanup lock
account then upload. No database transaction is held during R2 I/O.

`reserveUpload` reserves exact declared bytes and one concurrent slot. Reusing
actor+idempotency key with another payload/account is rejected. Expired but
uncleaned uploads retain their reservation and slot. `commitVerifiedUpload`
settles once only after BE-2 has verified bytes/MIME/codecs and copied an immutable
object; this hook does NOT verify R2 itself. Existing reservations may complete
after a limit reduction. `releaseAfterCleanup` requires trusted cleanup evidence;
it cannot release a completed asset. BE-2 must prove all write capabilities have
expired/stopped and pending/final data are cleaned before invoking it. Never
wire these internal hooks directly to an untrusted completion/cancel request.

Images/thumbnails use the same service and quota. Referenced assets cannot be
removed due to restrictive FKs. No physical deletion worker ships in BE-1.
Subscription entitlements may later supply the default limit beneath overrides;
there are no billing tables or package names.

## Deployment / migration gate (before merge and activation)

New migration: `202610191100_media_storage_foundation.sql`, applied by the existing
checksum-protected startup runner, within the runner's transaction. Never edit
previous migrations. Migration failure prevents server start even when the
feature flag is off; the flag is not a DDL bypass.

Local tests apply this exact migration as a **non-superuser database owner**
against an isolated minimal legacy schema, run the runner transaction-control
lexer, and verify preserved legacy URLs/program overrides. This proves the new
DDL/privilege model locally; it does not prove production privileges or full
historical-migration replay. No production query has been run.

Before merge, an authorized operator must confirm on the actual deployment role:

1. Same DATABASE_URL role is used by runner and server (as current startup does).
2. Role can CREATE a schema in the database, create tables/functions in it,
   reference public.users/public.clubs, and ALTER library.exercises and
   plans.plan_items (ownership/inherited owner role, not just UPDATE grants).
3. No unrelated `media` schema already exists. Collision intentionally aborts.
4. Runtime role owns media tables (RLS owner bypass); no browser/Data API roles
   have schema/table/function access. `media` must not be added to exposed schemas.
5. Short ALTER-table locks/index creation fit startup runner timeouts on real
   table sizes. No URL backfill or video migration occurs, but index scans and
   ALTER locks still need an appropriate deployment window.

Read-only privilege preflight (before applying; run only with operator approval):

```sql
select current_user,
       has_database_privilege(current_user,current_database(),'CREATE') as can_create_schema,
       has_table_privilege(current_user,'public.users','REFERENCES') as references_users,
       has_table_privilege(current_user,'public.clubs','REFERENCES') as references_clubs,
       to_regnamespace('media') as existing_media_schema;
select n.nspname,c.relname,pg_has_role(current_user,c.relowner,'USAGE') as inherits_owner
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where (n.nspname,c.relname) in (('library','exercises'),('plans','plan_items'));
```

The private schema revokes PUBLIC and existing Supabase API-role grants, enables
RLS with no API policies, and uses no SECURITY DEFINER functions. Backend table
owner retains access. Audit update/delete/truncate is rejected by a trigger.
If deploy uses a different runtime role, stop and explicitly agree its grants
and RLS policy; do not broaden access to authenticated/anon as a workaround.

Rollback: disable flag / roll back backend application; retain additive schema
and references. Do not drop media tables/assets or rewrite legacy URLs.

## Targeted tests

From backend/, set `MEDIA_TEST_DATABASE_URL` to a local PostgreSQL connection able
to create a disposable database and temporary roles, then run:

`node --test --test-concurrency=1 tests/media-storage-be1.test.mjs`

The harness refuses remote hosts or URL connection options, never reads app .env,
creates `optimove_media_be1_test_<random>`, and drops that DB/role afterward. It
never runs migrations or writes against the original configured app database.
No full test suite, build, migration deployment, merge or deploy is part of BE-1.
