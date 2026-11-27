# Exercises Manage applicability checkpoint

Reviewed deployed bridge e19f9a5e688f80522369fe7eecf3cd5d31ee016f against the Builder, Programs and Exercises Manage contract at 528a45e402deb3d091b8aea3f6a4ad72cdb0fdc6. The reviewed exercise routes have no native canonical writer that can be restricted while preserving personal writes, the existing platform rules, and the current access model. The local checkpoint below applies the agreed native-workspace rule for user-owned writes. Both words remain unexposed.

| Route | Current write and authority |
| --- | --- |
| POST /api/exercises and POST /api/exercises/:id/copy | The shared upsert inserts a user-owned exercise for the session user. Copy also checks source visibility and has separate private copy and media rules. |
| PATCH /api/exercises/:id | A system exercise requires active platform administration, rechecked in the write transaction. The ordinary branch can update the caller's own user-owned exercise. The path also writes exercise content, lookup/junction rows and media attachments in one transaction. |
| PUT /api/exercises/:id/classification | Upserts overrides keyed by the caller's user ID and exercise ID after the existing read scope. The shared exercise's classification is unchanged. |
| POST /api/exercises/:id/archive, POST /api/exercises/:id/restore, DELETE /api/exercises/:id | Existing library visibility plus actual personal ownership or active platform administration checked under the collection lock and a row lock. |
| DELETE /api/exercises/:id/permanent | Existing private owner/platform recovery and usage requirements. Outside this stage. |
| POST and DELETE /api/exercises/:id/tags | Caller-owned personal tags and deletion of the caller's legacy private tag links. |
| POST /api/builder/nodes/:nodeId/custom-exercise | Creates a user-owned exercise and adds it to an editable program item, with possible media. The program item and the exercise are separate effects even though they are written atomically. |

The native Exercises module entry already requires exercises.use at the active scope. The catalogue's shared system authorization does not delegate shared writes to a club or team. A permission seed alone therefore has no eligible canonical write to protect at this boundary.

## Agreed workspace effect and local implementation

When an active native club or team workspace performs a user-owned POST/create, POST/copy or full content PATCH, require exercises.add. The active native lifecycle routes (archive, restore and DELETE as archive) require exercises.remove. These are additive to the existing Exercises use/licence and resource ownership/visibility rules. The saved owner stays the user. Genuine private or platform behavior and personal classification, hidden, favorites and tags stay outside these two words.

The writer reads the selected workspace and takes the existing exercise-collections advisory lock. For a native target it then takes the shared club ceiling, the R4 actor holding locks, and the session/preference locks before reloading the active workspace and checking both words on the same client. Source or owned-row lookup, media sidecars embedded in the existing full content writer and writes follow under the existing transaction. The full PATCH can carry embedded media but still runs the existing complete exercise replacement. This slice does not modify upload, claim, media authority, Blocks, presets or permanent deletion. An absent or invalid workspace preference uses the normal fallback with a compare-and-set write. A competing first explicit selection is preserved.

The local fixture stages both words only in its scratch PostgreSQL database. No official migration slot or live permission exposure is part of this checkpoint. Builder custom exercise now checks Exercise Add in the same transaction as the exercise, plan item and media binding. It keeps current Builder and media rules, and requires Program Edit or Exercise Media Upload when the corresponding word is honoured and that effect applies. The dedicated media contract and audited Exercise word staging still precede release.
## Evidence and remaining checks

Use the repository runner on a temporary PG17 cluster for exercises-upsert.test.mjs, exercise-copy-source-integrity.test.mjs, exercise-english-content.test.mjs and builder-exercise-access.test.mjs, plus the browser files roles-v7-view-programs-exercises.test.mjs and exercise-favorite-not-saved.test.mjs. Add native/mixed-workspace positive and negative controls only after selecting the affected write. Pin authority changing while the write waits and prove denial leaves the exercise and all dependent rows unchanged. The focused test checks unstaged/native refusal, independent Add and Remove, source ownership, closed licence, a queued workspace switch and personal overrides. The old mechanics fixture supplies only the synthetic routines needed for unrelated behavior tests. No production database or deployment was used.
