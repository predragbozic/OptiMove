# Exercise Library ownership and restricted blocks

Status: implemented locally for review on base `60aadb9`; not merged or deployed. No persistent database has been inspected or migrated. Owner decisions confirmed 2026-10-15.

## Ownership

For the current saved-program versus new-reuse contract and isolated migration
validation boundary, see `exercise-library-final-access-semantics.md`.

- A system exercise belongs to the application, managed by its platform administrator. A legacy display label such as “general admin” grants no rights by itself; real `platform_admin` authorization is required.
- A coach-created exercise is `owner_scope='user'`, owned and created by the authenticated coach. Client ownership and provenance fields are ignored.
- Only platform administrators may PATCH a system original. Coaches use explicit Copy, which POSTs to `/api/exercises/:id/copy` only on Save; opening or cancelling the form never writes. A variation records `source_exercise_id` and remains unique per owner/source. Copy returns 409 if that owner already has a variation; edit the existing private exercise instead, without overwriting it from the original.
- A new personal variation starts with a NULL exercise code and a UUID-based private slug. System media never prefill the copy form. The copy endpoint rejects either media field matching either source media URL, after trimming; absent media remain NULL, and distinct user-supplied media are retained. Existing private media are not rewritten. Different coaches may use the same variation name without conflicting with the unchanged global code/slug indexes.
- Tags, favorites and marks are personal organization, not copy operations. See `exercise-personal-tags-copy-media.md` for the additive tag storage, compatibility and release checks.
- Personal exercises and variations are visible only to their owner; a block grant does not share a variation with other grantees or the administrator.

## Restricted blocks

- Only the application administrator manages blocks and their user grants, through `GET/POST /api/exercise-collections`, `PATCH /:collectionId` and the searchable `GET /options` choices.
- One system exercise belongs to at most one block. Private exercises cannot be selected for a system block. Ungrouped system exercises remain available to every coach.
- A grouped system exercise requires a current user grant, except for the application administrator. A personal variation requires both ownership and the grant attached to its source. Revocation hides the original and the variation; granting access again restores visibility to that variation's owner only.
- Removing a system exercise from a block makes its original public again. The administrator confirmation states this consequence. Removing a user does not remove the exercise from the block.
- Library searches, details, edits, favorites, tags and Builder add use the shared visibility predicate. The ordinary system-tag action opens the personal-copy editor; direct system tag writes are refused. Marked objects are revalidated against the server before rendering. A block change notifies connected sessions to clear Library caches, details and editors and reload results; reconnect does the same, and opening a cached Library detail checks access again. These in-process realtime events are best effort; the server remains authoritative on reads and writes and cannot erase bytes already delivered to a browser. Previously saved program prescriptions are historical snapshots and are not rewritten or removed by Library revocation.
- Block updates are transactional, revision-checked, serialized and audited. Exercise saves take the shared side of the block transaction advisory lock before reading access and editing rows; block changes take its exclusive side. This prevents revocation from committing halfway through a copy save. Both use bounded lock waits. An unconfirmed save is not reported as success. Reopen the block after a lost response before retrying.

## Schema and rollout boundary

New additive migration: `migrations_v2/202610151200_exercise_library_ownership_and_collections.sql`. It adds block/grant/audit objects and variation provenance. It does not reclassify existing exercises, assign any block, copy personal data or change Training Load.

The actual ownership of existing production exercises must be audited separately with read-only SQL before considering any reclassification. Being imported does not mean being system-owned: the Pankov and multi-athlete legacy seed files explicitly create user-owned exercises. No bulk conversion to system is part of this change.

The new application code requires the new schema. Applying the migration to a persistent database, deploying the code, moving existing exercises into restricted blocks or granting real users access each remains a separately authorized operation. The normal ordinary editor deliberately does not provide an in-place system-master edit operation.

The empty-state rollback is in `docs/runbooks/exercise-library-collections-rollback.sql`; it refuses once block or variation data exists. Do not discard provenance or grants to make a rollback proceed: that would change visibility. A data-preserving rollback after real use needs a separate owner-reviewed plan.

## Review gates

Authorization, provenance, copying, transactions and the migration require external review under `CLAUDE.md`. Passing local tests or internal reviewers is not merge or deployment approval.
