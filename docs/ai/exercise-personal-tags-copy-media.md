# Exercise Library: personal organization, Copy/Edit and media

## Contract

Tags on accessible system or owned exercises are per-user metadata, never an implicit exercise copy. Search and tag filters read only the request user's personal labels plus visible legacy/system tags. EXISTS predicates preserve one card per exercise. Favorites and local marks retain their existing per-user behavior and access checks.

The library exposes Tags on both exercise kinds. Coaches get Copy, not Edit, on system exercises; platform administrators additionally get Edit on the original. Owned private exercises get Edit. Backend PATCH enforces administrator rights on system originals and owner-only access on private exercises, including against platform administrators accessing another owner's private exercise.

Explicit POST `/api/exercises/:id/copy` accepts only an accessible system source. It locks the source inside the existing collection-guard transaction, sets user ownership and canonical provenance, ignores the source code and uses a UUID private slug. Existing owner/source uniqueness is unchanged: another Copy Save returns 409 with guidance to edit the existing copy, never silently overwrites it. Private Edit Save keeps the same ID and slug.

Copy forms start with empty video/image/code fields. Saving without new media leaves NULL media. Both media inputs are compared against both current source media URLs after trimming, under the source lock; matching source media return 400 before writes. Distinct user media are accepted. This is source-URL equality enforcement, not DRM, content fingerprinting or protection against every alternate URL for the same remote content. Existing private media are not changed retroactively.

## Minimal additive migration

`202610161100_exercise_personal_tags.sql` creates only `library.exercise_personal_tags` and its per-user/exercise/case-insensitive-name unique index. Existing `exercise_tags` has no assignment user ID and cannot privately attach a shared tag to a system exercise. Existing tag names also have global collision semantics, so reusing that table alone would not support two owners choosing the same private label. The small new association stores the personal name directly rather than adding another dictionary table or changing existing constraints.

Existing tags and tag links remain intact and readable. Only explicit user removal can remove that user's legacy tag link; system/other-user links cannot be removed through personal tagging. New tag API writes and legacy editor tag payloads use the new user-scoped association. The current editor leaves organization to Tags and omits tag fields during content saves, preserving labels while editing content. System tags remain read-only in the personal tag dialog.

The migration enables RLS with no client policies and revokes PUBLIC/anon/authenticated table privileges. The existing trusted backend database owner remains responsible for authorized API reads/writes. No existing exercise, program, media, ownership or provenance row is rewritten. The production code/slug/source unique indexes and source guard are not modified. Old tag-created copies remain present; no cleanup, merge or deletion is performed.

## Deployment and recovery

The existing Render startup runs migrations before starting the app; no Render change is required. This migration adds a new initially empty table, without scanning/rewriting exercise or program data. Migration rehearsal uses the real file through applyNewMigration in disposable loopback databases. The normal startup remains fail-closed on migration errors. Old loaded browser clients cannot edit originals: ordinary non-admin PATCH returns 403, with no copy created. Refresh those clients for the new Copy UI.

If an application rollback is necessary, retain the additive table and all personal labels; the older app will not display the new labels, but existing data remain intact. Do not drop tables, reverse migrations or roll back the database automatically. Merge/deploy still requires the owner's separate approval.

## Verification boundary

Regression coverage includes personal tag/favorite isolation and unchanged original/count, same-name labels across owners, search/filter without duplicate cards, Copy/Cancel UI, empty/custom/rejected inherited media, repeated private edits, administrator original edits, foreign private access denial, preserved legacy media, collection revoke/regrant, source integrity, program reuse, and migration idempotence/RLS. The runtime fixture includes the real new tag migration and global partial UNIQUE indexes for exercise_code/slug. Existing unrelated known frontend failures must be reported separately from feature regressions.

No production database, Render settings, backup or restore is touched by this change or its tests. Final execution counts and build/review evidence belong in the PR description.
