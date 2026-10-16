# Exercise Library: personal classification, source media and lifecycle

Historical #169 contract. The subsequent
[workspace/filter/delete update](exercise-library-workspace-ux-delete.md)
supersedes its workspace-independent admin scope and hard-delete limitation.

This contract supersedes the private-administrator and copy/media rules in the
PR #165/#166 documents. It does not authorize merge or production deployment.

## Architecture inspected and reused

Repository migrations, routes, UI and read-only production schema metadata were
inspected before implementation. Existing classification dictionaries/junctions
describe the exercise, not a user's override. No per-user classification table or
override JSON column existed. Existing `filter_hidden` supported taxonomy kinds,
but not exercises. Existing `is_active` already supports reversible archiving.

The implementation reuses those dictionaries, nine existing classification
fields, editor controls, personal tags, favorites, local marks, ownership,
collection grants, the collection concurrency lock and saved program snapshots.
It never rewrites, merges or removes historical private copies or their media.

The reported system Edit issue was the detail overlay's unconditional button,
not a backend privilege escalation: non-admin PATCH already returned 403. The
detail now fetches current capabilities, uses the actual exercise ID instead of
a program-item ID, and renders Edit/Copy separately. Backend enforcement remains.

## New behavior

- My classification stores only the actor's overrides. Missing keys inherit;
  empty strings/arrays deliberately clear personal values. Reset removes keys.
  Search, filter options and list filters use effective values, with one row per
  exercise. The content editor continues to use original values, not overrides.
- Hide/Unhide uses the existing user-scoped hidden registry. Default lists omit
  hidden exercises; Hidden/all filters include them deliberately. Direct reads,
  saved programs and reuse permissions are not revoked by Hide. Marked visibility
  is revalidated server-side, including combined Hidden/Archived filters.
- Platform admins can manage all system/private exercises. Other users can read,
  copy, edit or archive only accessible system originals (read/copy only) and
  their own private exercises. Admin owner/type filters do not expose foreign
  private data or personal labels to ordinary users.
- Copy opens without writing; Save creates a UUID-identified private exercise.
  Existing system-source uniqueness is retained: a second system Copy for the
  same owner returns 409 and directs them to their existing copy. Private Copy
  creates a separate child; Edit keeps the current ID and ownership.
- Copy's own media fields remain empty. Authorized display reads resolve the
  nearest non-null ancestor media independently for video and image. Own media
  win; clearing them restores fallback, and source updates are read live. Raw
  editor media fields never receive resolved fallback URLs. Copy rejects current
  source media URLs submitted as own media, including cross-field matches.
  This is URL equality enforcement, not DRM or remote-content fingerprinting.
- Every private-copy ancestor must remain accessible for ordinary users. Source
  collection revocation blocks descendants and fallback; a removed admin role
  cannot leave a foreign private ancestor accessible. No streaming proxy is added.
- Archive/Restore toggle `is_active`; DELETE is a soft-archive alias. They use
  ownership/admin checks and serialize against exercise reuse and grant changes.
  UI confirmation is required. Saved rows, media and references remain intact;
  archived exercises cannot be newly added/reused. No physical delete endpoint
  or cascading program/result deletion is introduced.

Admin saves and lifecycle operations emit structured server logs with actor,
exercise and action. The only existing persistent exercise audit is collection-
specific and has a required collection FK; it is not misused as an exercise audit
table. No new persistent audit infrastructure is claimed.

## Necessary database changes

One forward migration: `202610161400_exercise_personal_classification.sql`.

1. `exercise_classifications(user_id, exercise_id, overrides, updated_at)` is the
   smallest user/exercise association for sparse classification values. It has
   a composite PK, FKs, object CHECK, RLS and no direct client grants/policies.
2. Extend the existing `filter_hidden` kind CHECK with `exercise`; no new hidden
   status table/column is created.
3. Add nullable `exercises.copy_parent_id`, a restrictive FK, partial index,
   ownership/exclusivity CHECK and immutable/cycle-checking provenance trigger.
   The old `source_exercise_id` is deliberately a canonical SYSTEM source with
   immutable guard and owner/source uniqueness. Reusing it for private parents
   would break that invariant. Existing system copies keep their original link;
   new private-parent copies use the new link, with no backfill.

Global partial UNIQUE indexes on exercise_code/slug and the original canonical
source unique index/guard are unchanged. No existing migration checksum changes.
No exercise/program row is updated by the migration. Constraint validation and
DDL still acquire database locks; the existing migration runner supplies bounded
timeouts and a transaction, so failure aborts startup rather than starting a
partially migrated application.

## Verification and release boundary

- 116 disposable-database backend tests passed across exercise writes, Builder
  access/reuse, source integrity, real-file migration rehearsal and copy performance.
- 16 additional backend unit/static tests passed (13 Builder unit tests and 3
  pagination/source static tests).
- Full frontend: 1660 passed, 9 unchanged known failures/cancellations, zero new
  failures across 110 files. Targeted final feature run: 39/39 passed, including
  Tile/Big/List/Details actions from the concurrently merged PR #168. Its old
  private-Copy-negative assertion was updated to the explicitly requested policy.
- Production build passed; the existing large-chunk warning remains.
- Fixtures include production code/slug UNIQUE indexes. Real-file rehearsal uses
  `applyNewMigration` and verifies existing rows, canonical uniqueness, RLS,
  hidden kinds, immutable private ancestry and restrictive parent deletion.
- A saved program API is compared before/after archiving, including exact stored
  snapshots/references; restore permits adding the exercise again.

Tests use disposable loopback PostgreSQL databases, not production or the prior
backup/restore environment. Schema inspection was read-only. No Render setting,
production data, merge or deploy was changed.

Review focused on user isolation, forged provenance, admin-policy expansion,
effective-value filtering, explicit empty values, media field separation,
source revocation, archive/reuse serialization and preservation of old records.
Runtime list queries now include JSONB and recursive source resolution; local
regressions pass, but production load/latency still needs ordinary deploy
monitoring. Source hierarchy depth is cycle-guarded, not arbitrarily truncated.

The existing Render startup applies this migration before serving the app; no
infrastructure changes are needed. After approval, monitor migration success,
health, errors and library latency, then verify coach/admin actions and an
existing saved program. If migration/startup fails, stop and report; do not roll
back the database automatically. An approved application-only rollback must retain
the additive metadata and copy-parent links; the older app cannot fully resolve
new private-parent ancestry and must not be used as an ACL-preserving rollback
without review. No claim of a freely reversible database migration is made.
