# Exercise Library: workspace-scoped administration and compact filters

This updates #169 after the owner's mobile review. It does not authorize release.

## Diagnosis and existing architecture

The original exercise reported in the Proba search has the user's personal tag
`Proba`; broad search matched the tag as well as the renamed copy's title. The
original was not renamed. Existing personal tags are deliberately preserved.
Visibility filters were outside the established disclosure, owner names were
eagerly listed, and admin checks followed the global role in every workspace.

The implementation reuses existing workspace preferences, roles, ownership,
collection grants, source/private ancestry, personal metadata, Archive/Restore,
filter controls and all four card layouts. **No database migration is needed.**

## Behavior

- Exercise administration requires BOTH the real active platform_admin role and
  selected `platform` workspace. Missing preferences use the existing platform
  fallback. Non-platform preferences restrict admin features; they never grant
  roles. The global role and the ability to select Platform administration remain.
  This exercise-specific ceiling updates the older workspace navigation contract;
  unrelated modules' authorization is not rewritten. Exercise/collection routes,
  owner options and SQL access/reuse enforce the rule. Mutations recheck after
  their transaction guard. Workspace changes clear stale filters, rows and editors.
- Type, Archive, Hidden, Owner and Search in use normal controls inside More
  filters. Quick Purpose/Tag/Favorite/Marked remain, without duplicate toggles.
- UI defaults to System + my exercises and Name or code search. Broader tag and
  effective-classification search remains explicit; direct API calls omitting
  `searchIn` preserve broad-search compatibility. Original tags are not removed.
- System/My choices come first. Admin owner lookup is on demand, pins the actor,
  requires two characters for other owners, caps output at 21 and signals when
  refinement is needed. Email distinguishes identical names. Owner selection
  synchronizes the type filter, and active advanced filters have result badges.
- Staff mobile header uses a fixed first row, ellipsized workspace label and
  a separate Online row. Full labels remain in the chooser/tooltip. Athlete
  layouts are excluded. Synthetic local browser checks at 393px and 320px found
  no horizontal overflow; all five first-row buttons shared the same top value.

## Explicit permanent Delete

Archive/Restore remain the safe default; legacy DELETE `/:id` remains soft archive.
DELETE `/:id/permanent` is separate, validates UUIDs, allows only owned private
exercises (or an active platform-workspace admin managing private exercises) and
never physically deletes system originals. The UI asks for irreversible-action
confirmation and labels it Delete permanently. No automatic cleanup is added.

The transaction takes the existing exclusive exercise-reuse advisory guard and
locks the exercise FOR UPDATE. Inbound FKs are discovered from PostgreSQL metadata.
Any program, activity, collection or dependent-copy reference blocks deletion,
including ON DELETE SET NULL/CASCADE references: the production plan-items FK
uses SET NULL, so relying on FK errors alone would silently break references.
Real two-connection tests cover a concurrent reference insertion.

Only allowlisted exercise-local taxonomy links, favorites, personal tags,
classification metadata and hidden-registry rows are removed with an eligible
exercise. Shared dictionaries, programs/results and other copies are not cascaded
away. Composite/non-ID dependency shapes fail closed. Reference/busy errors return
409 and recommend Archive. Structured server logs retain actor/action auditing.
Deletion is genuinely irreversible through the app; no automatic DB rollback or
new backup/restore workflow is introduced.

## Verification and release boundary

Tests cover actual multi-role workspace switches, retained own-copy Edit/Delete,
blocked foreign/system writes, bounded owner lookup, Proba name-vs-tag searches,
SET NULL/CASCADE protection, concurrent references, filter integration, mobile
header and all four card layouts. Existing Builder, saved-program, source and
migration regressions are retained. Final counts/build/baseline are in the PR.

Production diagnosis used SELECT only. Destructive tests used disposable loopback
databases. No existing data, UNIQUE index, schema, Render setting, backup/restore,
merge or deployment is changed. Application rollback needs no schema rollback,
but would restore the previous broader admin-workspace behavior.
