# Server facts for the coach Imports screen: plan note

Status: **Proposed.** Plan only; no code until the *Rukovodilac* confirms. Asked for by the *Rukovodilac* on 2026-11-13,
from the design executor, for the coach prototype. Checked against `main` `cbede24b`.

There are three additive facts. Facts 1 and 3 can ship as **one small backend PR with no migration**. Fact 2 needs storage,
and this note asks first whether it is worth it.

## 1. `candidateSummary.athleteStates`

`athleteStates: { fine, needsYou, noGps, leftOut } | null`. These are counts only, with no id or name. It is `null` exactly
where `athleteCount` is `null` (the snapshot is gone, or the mapper's gates refused the session).

**From the stored preview the list already reads** (`candidateSummary`, `backend/src/gpexeImportService.js`). Each entry
of `preview.athletes` goes into exactly one of the four counts. The counts add up to `athleteCount + noGps`.

| Count | Entries |
|---|---|
| `fine` | no `notImported` (written, or would be written), and `session_blocked` (see the decision below) |
| `needsYou` | `notImported.code` in `athlete_not_linked`, `athlete_not_in_team`, `multiple_tracks`, `whole_session_row_count`, `stats_invalid` (not valid by the source) |
| `leftOut` | `left_out_by_coach`; after MT-B, `no_track_by_choice` too. For an **imported** candidate: the approval's J20-B `excluded_athlete_ids` (the stored preview is the full one: a subset approval never stores its preview) |
| `noGps` | `preview.teamAthletesWithoutGpexeRecord.length` (a count beside the others, not one of the entries) |

**Decision for the *Rukovodilac*: an athlete whose only reason is `session_blocked`.**
- (a) Count the athlete in `fine` (recommended). The athlete's own data is fine. The session's block is the session's
  state, which the row already shows through `previewStatus` and `blockedCode`.
- (b) Count the athlete in `needsYou`. The whole team would then read as "needs you" while the cause is a single block.

**Any new code an entry may carry** falls into `needsYou`. That is the safe default. A test pins the list of known codes,
so a new code is a deliberate choice.

**No extra SQL per candidate.**
- The J20-B count is one correlated scalar subquery in `CANDIDATE_COLUMNS`:
  `(select cardinality(a.excluded_athlete_ids) from training_load.gpexe_import_approvals a where a.candidate_id = …)`.
  `candidate_id` is unique (v23).
- It is part of the same statement, so the list's contract test (`gpexe-in-app-import.test.mjs`: the same number of
  statements for 1 and for 7 candidates) stays as it is and is extended to the new field.
- For a coach the counts are allowed. They carry no code, id or name, and nothing about another team.

## 3. `status.lastSucceededCheck`

`lastSucceededCheck: { id, window: { from, to }, finishedAt } | null` sits beside `lastCheck`. It has no error fields and
no counts.
- **The query:** `select id, window_from, window_to, finished_at from training_load.gpexe_import_checks where
  owner_team_id = $1 and status = 'succeeded' order by started_at desc limit 1`, served by the index
  `gpexe_import_checks_team_idx (owner_team_id, started_at desc)`.
- **The route:** one more read in the status route's `Promise.all`.
- **The audience:** everyone who sees the team's status. The window and the time are the same facts `lastCheck` already
  gives a coach.

### Facts 1 and 3 together

| | |
|---|---|
| **Files** | `backend/src/gpexeImportService.js` (`candidateSummary`, `CANDIDATE_COLUMNS`, a `lastSucceededCheck()` next to `latestCheck`), `backend/src/routes/gpexeImport.js` (status) |
| **Tests** | <ul><li>the counts per bucket on a world with linked, unlinked, a not-in-team athlete, a multi-track athlete, an invalid one and one without GPS;</li><li>`null` where `athleteCount` is null;</li><li>a J20-B subset import's `leftOut`;</li><li>the statement-count contract;</li><li>the coach's and the admins' summaries carry the same counts;</li><li>`lastSucceededCheck` after a failed later check, and `null` with no succeeded check;</li><li>the pinned list of known codes;</li><li>mutations of the code map and of the subquery's candidate binding</li></ul> |
| **Triggers** | none of the five: an additive read projection of facts the list already holds, with no write, lock or access change. `code-reviewer` only (backend). If you count a new coach-visible field as an audience change, add `security-reviewer`; I don't think it is one. |

## 2. A remembered "Later"

`PUT …/teams/:teamId/candidates/:candidateId/later { requestKey, later }` answers `{ candidate }`, and the summary gains
`candidateSummary.laterAt`.

### Is it worth it, against hiding the session on the device only?

**Device-local** (the browser remembers candidate ids):
- no server change and no migration;
- per person and per device;
- lost on another phone or after a cleared browser;
- invisible to a second coach of the team.

**Server-side:**
- the same for every reviewer of the team and every device;
- a migration with ★★ trigger 1, a write route and its tests.

**Recommendation.** Start device-local and drop the server version unless the owner wants "Later" to be shared by the
team's reviewers. A new candidate id after a content change is already "not later". An imported or replaced candidate
leaves the list anyway, so the device-local version needs no expiry logic beyond pruning the ids that are no longer listed.

### If it is server-side

**Storage: a small table**, not a column on the candidate. The candidate's columns are guarded by the v22, v23 and v33
triggers, which control which status changes and which writer may change what. Adding a writable column means amending
those guards (★★, trigger 4 close to the approval). A separate table touches none of them.

```
training_load.gpexe_candidate_later (
  candidate_id uuid primary key references training_load.gpexe_import_candidates(id) on delete restrict,
  owner_team_id uuid not null references public.teams(id) on delete restrict,
  later_by_user_id uuid not null references public.users(id) on delete restrict,
  later_at timestamptz not null default clock_timestamp(),
  request_key uuid not null, request_hash text not null
)
```

**Rows:**
- `later: true` inserts the row; `later: false` deletes it.
- An earlier request with the same key replays the answer (a small request record in the same table, or the v36 pattern;
  to be decided).

**The rules come from the candidate key itself:**
- "New content starts not-later" because new content is a new candidate id.
- "An import clears it" without any write in the approval: the summary reports `laterAt` only while the candidate is
  `pending` or `blocked` and not undone. The approval transaction stays exactly as it is.

**Lock order:**
1. the per-user request advisory lock;
2. the candidate `FOR SHARE`, only while it is `pending` or `blocked`;
3. the `later` row.

- It does not take the team import lock, because nothing in the import reads the row.
- An approval that holds the candidate `FOR UPDATE` makes the PUT wait under `lock_timeout`, and the PUT answers
  `try_again`. Once the candidate is imported, the PUT answers `409 candidate_not_open`.
- The PUT holds one candidate row and takes no team lock, so it cannot close a cycle with the approval, the check
  finalization or the undo.

**Audience:** whoever may review the team's sessions (the readers of the candidate list: `teamAccess`). Everyone else gets
the identical 404.

**A database guard** (the v35 pattern): the acting user is the row's author and is a reader of the team. Whether that is
needed for a cosmetic flag is your decision. Without it, the service alone guards the write.

**Files:**
- a migration v68 (or the next free number), with its runbook, preflight, post-check and rollback;
- a small service, the route, `candidateSummary`, and `CANDIDATE_COLUMNS` (one more scalar subquery, so the statement
  count is unchanged).

**Tests:**
- the PUT outcomes (201 / replay / 409 / 404);
- new content not-later;
- an imported candidate shows no `laterAt`;
- the lock wait answers `try_again`;
- the recorded SQL order;
- the migration round trip.

**Triggers:** 1 (migration) and the persistent write. That means `db-reviewer`, `code-reviewer` and `security-reviewer`
(a new write route with an audience), then both GOs and the owner's order naming the migration.

## Order

1. Facts 1 and 3: one small backend PR, no migration, after your confirmation and the `session_blocked` decision.
2. Fact 2: only if you or the owner choose the server-side version. Otherwise the design executor does it device-local in
   the frontend.
