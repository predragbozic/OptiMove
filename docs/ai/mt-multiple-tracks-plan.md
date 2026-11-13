# MT: an athlete with more than one track in a session, and scaling a short recording (plan)

Status: **proposed plan, docs only.** Nothing here is built. It was written on the *Rukovodilac*'s order of 2026-11-12, which
relays the owner's task "MT", and follows its conditions. Code, migrations and GPEXE requests come only after the plan is
accepted.

Last verified against commit: `cc20f63` (main after #502).

## 1. Today

- **The mapper.** `buildGpexeImportPlan` groups an athlete's rows by `track` (`backend/src/gpexeImportMapper.js:275-280`).
  More than one track gives the anomaly `multiple_tracks` ("tracks …, not imported, needs review"), and the athlete is left
  out. The rest of the session imports.
- **The review.** The session review shows the athlete as *Needs review*, with one sentence and no action
  (`docs/ai/j20-session-review-contract.md:65`).
- **GPEXE cannot merge tracks.**
- **Earlier decisions this plan revisits:**
  - discovery section I (`docs/ai/gpexe-metric-variable-mapping-discovery.md:2285-2295`): "no automatic merge"; a future M5
    may offer a manual choice of one track;
  - phase 10 §2 (`docs/ai/phase10-estimates-decisions.md:104-160`): `track_choose_one` and `track_sum_disjoint`, both written
    as **estimates** (D1, a recommendation that was never decided), with a sum only on the coach's confirmation that the tracks
    do not overlap, because "the system cannot check the overlap".

  The owner's MT task and the *Rukovodilac*'s conditions go another way: the mapper computes the result from the stored
  tracks, with idempotent source identities. **Decision O1 (section 9) confirms this.** It supersedes phase 10's D1 and its
  §2.2 confirmation box for MT.

## 2. Proof of need

**From the repository (fixtures and code only; no production access):**
- One multi-track shape exists: the synthetic fixture athlete 103 (`backend/tests/_gpexe-fixtures.mjs:92-97`).
  - It has 2 tracks, `[9003, 9004]`, one whole-session row each (600 s and 900 s), and no drill rows.
  - Both tracks get the same start instant (`_gpexe-fixtures.mjs:47-49`: every track starts 10 minutes before the session).
  - By the start-plus-duration rule of section 3 it is therefore **overlapping**. That is a fixture artefact, not a real shape.
- No stored real snapshot is in the repository; the owner keeps the real responses outside it.

**Recorded facts:**
- `docs/ai/CURRENT_STATE.md:1893` (2026-10-11, the First team, 05.10–06.10.2026): one session was *Needs attention* for "more
  than one track for one athlete".
- Whether those tracks were sequential, overlapping or more than two is not recorded.

**What is missing, and how to get it without a GPEXE request.** A read-only count over the deployed database's stored
snapshots. The raw bundle is kept for `pending`, `blocked` and `superseded` candidates
(`backend/src/gpexeImportService.js:605`). Proposed for the *Rukovodilac*'s read-only connector; it is not run by the executor:

```sql
-- Read-only. For each stored snapshot: athletes with more than one track, classified by the start + whole-session TIME rule.
with c as (
  select id, raw_bundle b from training_load.gpexe_import_candidates where raw_bundle is not null
), rows as (
  select c.id, r ->> 'athlete' athlete, r ->> 'track' track, r -> 'drill' drill, (r ->> 'total_time')::numeric total_time
    from c, jsonb_array_elements(c.b -> 'athleteSessions') r
), multi as (
  select id, athlete from rows group by id, athlete having count(distinct track) > 1
), spans as (
  select r.id, r.athlete, r.track,
         (c.b -> 'tracks' -> r.track ->> 'utc_timestamp')::numeric as start_s,
         max(r.total_time) filter (where r.drill is null or r.drill = 'null'::jsonb) as whole_s,
         count(*) filter (where r.drill is null or r.drill = 'null'::jsonb) as whole_rows
    from rows r join multi m using (id, athlete) join c on c.id = r.id
   group by r.id, r.athlete, r.track, c.b
), shaped as (
  select id, athlete, count(*) tracks,
         bool_and(whole_rows = 1 and start_s is not null and whole_s is not null) as readable,
         bool_or(exists (select 1 from spans o where o.id = s.id and o.athlete = s.athlete and o.track <> s.track
                          and o.start_s < s.start_s + s.whole_s and s.start_s < o.start_s + o.whole_s)) as overlapping
    from spans s group by id, athlete
)
select case when tracks > 2 then 'more_than_two' when not readable then 'unreadable'
            when overlapping then 'two_overlapping' else 'two_sequential' end as shape,
       count(*) as athletes, count(distinct id) as candidates
  from shaped group by 1 order by 1;
```

Checked by the executor on a throwaway local database with three variants of the fixture bundle (2026-11-12). The unchanged
fixture is `two_overlapping`; with track 9004 one hour later it is `two_sequential`; with a third track it is `more_than_two`. It
was not run against any persistent database.

**The production count (the *Rukovodilac*, 2026-11-12, read-only, no names)** changes the plan:
- 5 athletes in 4 stored candidates have more than one track (05.10, 29.10 with two athletes, 03.11, 05.11).
- **All five are `two_overlapping`, and in every case the two tracks are identical:**
  - the same start (offset 0 s);
  - the same `total_time`: 4236, 968, 3366, 3366, 4381 s;
  - the same `total_distance`: 5686, 1823, 4021, 4309, 5722 m;
  - no drill row on either track.
- No sequential case exists, and no case of more than two tracks.

So the real case today is a **duplicate**, not two parts of one training. "Add them up" would double every value. Hence MT-0
(section 11) comes first, and "Add them up" becomes a later slice (section 8). If nothing is sequential, MT-B ships "Use one track" and "None"
first.

## 3. The overlap guard (for "Add them up", a later slice)

**The stored fields** (the snapshot keeps only these; `backend/src/gpexeRestV1Adapter.js:88-97`, `BUNDLE_FIELDS`):
- **The start:** `track.utc_timestamp` (epoch seconds) and `track.timestamp` (`gpexeRestV1Adapter.js:95`). The mapper
  already requires them to be the same instant (`validateTrackTimestamps`, `gpexeImportMapper.js:106-113`).
- **No end is stored.** The only length is the athlete-session row's `total_time` in seconds (`gpexeRestV1Adapter.js:90`).
  Its unit is confirmed by C97 (`docs/ai/gpexe-c97-unit-evidence.md`), and it is the value mapped to `duration`.
- **A track's span** is therefore `[utc_timestamp, utc_timestamp + total_time of that track's whole-session row]`.

**The guard (computed by the mapper, fail-closed).** "Add them up" is offered only when:
1. every track has exactly one whole-session row with a finite `total_time > 0`, and a start;
2. the spans are pairwise disjoint (`end_i <= start_j` for consecutive spans);
3. no drill index appears on more than one track. A shared drill index means the two tracks recorded the same drill, so they
   overlap.

Anything else gives `overlap_or_unknown`, and only options 2 and 3 are offered.

**The evidence gap (O2).** Whether `total_time` is the track's wall-clock length or its active time (pauses left out) is not
proven.
- If it is active time, the computed end is too early, and a real overlap can look disjoint.
- Recommendation: before "Add them up" is released, one owner-run C97-style check (no GPEXE request by the executor). For two
  or three real tracks, compare the start + `total_time` with the GPEXE screen's end time.
- Until that check is done, MT-B ships options 2 and 3 only, or "Add them up" stays behind a server flag.

## 4. The three choices

Made per athlete in the session review, **by whoever may approve the import** (`lock_gpexe_import_approver`: a platform admin
or a coach with an approver grant). Nothing is chosen automatically.

| Choice | What the mapper writes | Label |
|---|---|---|
| **Add them up** (only when the guard of section 3 holds) | see "Add them up" below | "Combined from N tracks" |
| **Use one track** (the reviewer picks which) | That track's rows exactly as a single-track athlete today; the other tracks are ignored | "One of N tracks (track started HH:MM)" |
| **None** | Nothing from GPEXE. The athlete follows the existing no-data path: *Participated · no device data*, then an estimate (6b) or a manual entry | none needed: no GPEXE value exists |

**Add them up:**
- **Whole session:**
  - `sum` variables (duration, distance, counts, zone distances): the sum;
  - `max` variables: the largest;
  - `avg`: **refused in v1**, left out with the reason `not_combinable` (O3);
  - `last`, `none`: left out, `not_combinable`.
- **Drills:** each drill row as it is (a drill comes from one track; the guard refuses a shared index).

**Until a choice is made:** the athlete stays left out exactly as today (`multiple_tracks`), and the rest of the session
imports.

**Sum or largest per variable:** decided from the variable's daily aggregation (`metric_definition_versions`, the same column
6b uses), not from a list.

## 5. Where the choice lives

**Its own table, with a migration (★★).** Neither J20-C's import states (v61) nor J20-B's left-out ids (v59) can hold it:
- v61 states are roster attendance, written **after** an approval and bound to it (`origin_approval_id`);
- v59's left-out ids live on the approval row, so they exist only once an approval is sent and do not survive a new search
  before it.

**Decided (the *Rukovodilac*, 2026-11-12): `training_load.gpexe_track_choices`,** MT's track choice only. Section 10's scale
choice gets its own migration in MT-D, which widens the `choice` CHECK and adds `scale_target_minutes`. One row per decision,
append-only:

| Column | Meaning |
|---|---|
| owner team | the team the choice belongs to |
| GPEXE session id | the session (`team_session`) |
| GPEXE athlete id | the athlete |
| `track_set_fingerprint` | the sorted track ids and their athlete-session row ids, computed by the server |
| `choice` | MT-A: `track` (use one track), `none`, or `cleared` (the way back: the athlete is `multiple_tracks` again). `sum` comes with MT-E, the scale choice with MT-D |
| `chosen_track_id` | for `track` only, one of the athlete's tracks in the candidate's bundle |
| `chosen_by_user_id`, `chosen_basis` | who chose, on which right |
| `chosen_at` | when |
| `supersedes_choice_id` | the earlier choice this one replaces |
| request key and hash | the same pattern as the other admin writes (v64) |

- The current choice is the newest row not superseded. "Clear the choice" is a superseding row, never a delete.
- The table holds ids, the fingerprint, who and when only: no GPEXE name and no value.
- A DB actor guard (the v35 / v63 pattern) and append-only triggers.

**It survives a new search.** The choice is keyed by (team, GPEXE session, athlete), not by candidate. A new candidate of the
same session finds it.

**It is in the preview hash:**
- `previewLocked` reads the current choices of the session's multi-track athletes **under the team lock** and hands them to the
  mapper;
- the preview carries, per athlete, `trackChoice: { choiceId, kind, trackIds }`;
- the hash covers the preview, so a changed choice changes the preview;
- the approval recomputes under its locks, so a choice changed between the review and the approval gives `preview_changed`
  (the existing rule; nothing new).

**A stale choice.** If GPEXE's tracks for that athlete change (another track, other rows), the fingerprint differs:
- the choice no longer applies, and the athlete is `multiple_tracks` again, with the reason "the tracks changed since the
  choice";
- the choice is never silently re-applied to other tracks.

**The routes (MT-A):**
- `GET …/gpexe/teams/:teamId/candidates/:candidateId/track-choices`: the session's multi-track athletes, each with:
  - its tracks: start, whole-session time and distance, the drill indexes;
  - the guard's verdict;
  - the current choice.
- `PUT …/track-choices/:gpexeAthleteId` `{ requestKey, choice, trackId?, expectedChoiceId }`.
- **The audience** is whoever may approve the import for that team, through the function the approval uses
  (`lock_gpexe_import_approver`, team mode of v56 included). Everyone else gets the identical 404. A team coach without the right
  does not use these routes, but the review (MT-B) shows everyone who may open it that a choice exists and what it is ("Track 2
  of 2 used", "Left out by choice"), without the chooser's name for a coach.
- **Refusals** (409, nothing written): `not_multiple_tracks` (one track, or tracks MT-0 takes as one recording),
  `track_not_in_session` (a `trackId` that is not one of the athlete's tracks), `choice_changed` (a stale `expectedChoiceId`),
  `choice_final_after_import` (the candidate is imported: changing it needs the U5 undo first).
- **Lock order** (decided, 2026-11-12), the approval's: an unlocked rights read (the fast 404) → the candidate FOR SHARE,
  only while it is pending or blocked (the undo locks imported candidates FOR UPDATE after the team lock, so an imported one is
  never locked here; one an approval imports meanwhile no longer matches when the lock is granted), its snapshot available → the team import lock (blocking, with the approval's `lock_timeout` mapped to
  `try_again`) → the team and its club FOR SHARE (`lockApprovalTeam`) → the approver's rights FOR SHARE
  (`lock_gpexe_import_approver`), last as in the approval's step 6b → the current choice row FOR UPDATE → the insert → a bounded
  COMMIT. The request key's advisory lock on (author, key) comes first, as in v64. Written under the team lock, a choice is
  serialised with every `previewLocked` (the check's preview, the J20-A1 recompute, the approval). A recorded-SQL-order test
  covers the PUT against the approval, the check finalization, the J20-A1 recompute and the U5 undo.

## 6. Raw data and identities

**The stored snapshot is never rewritten.** The mapper computes the combination from the stored rows on every preview and
import. The same rows and the same choice give the same values and the same content hash, so a re-import is idempotent.

**Source identities** (`metric_source_identities.source_external_id`):

| Choice | Whole-session result | Drill results |
|---|---|---|
| **Use one track** | `athlete_session:<row>:full` (native) | `athlete_session:<row>:drill:<i>` (native) |
| **Add them up** | **`athlete_session:<rowA>+<rowB>[+…]:full`**, the whole-session row ids in ascending order | their native identities, `athlete_session:<row>:drill:<i>` |

- **Use one track:** the native identities of the chosen track's rows, exactly as a single-track athlete.
- **Add them up:** a single identity names every row it is made of, so it is stable while the rows are, and a different set
  is a different identity.

**T6 provenance** of a combined value:
- the combined source value (the sum, or the largest);
- the activation and revision as usual.

Whether T6 needs a marker column for "combined" is open, as T1 (section 9). The proposal is no new column: the identity shape
and the choice row say it.

**The label in Activities and the review:**
- "Combined from N tracks" is read from the identity shape (`+`);
- "One of N tracks" is read from the current choice row.

## 7. Interactions

- **Short recording (6a, `frontend/gpexe-import-view.js:2373-2385`).** The flag compares a result's written whole-session
  duration with the session's longest.
  - A combined result is checked with its summed duration.
  - A picked track is checked with its own; a device restart usually gives a short one, and the flag is the right hint there.
  - No change to 6a.
- **Drills.** Section 3, point 3 and section 4: drill rows keep their native identities; a shared drill index refuses the sum.
- **Supersede when GPEXE changes the tracks:**
  - before any import, a stale choice (section 5) puts the athlete back to `multiple_tracks`;
  - after an import, the imported identities are missing from the new plan, so the session is blocked by the existing
    `identities_missing_from_source` rule.
  - A new resolution cause `track_choice_stale` tells the reviewer to choose again or to undo the earlier import.
  - **Changing an imported choice** (for example from "Use one track" to "Add them up") is the same case: the old identities
    go missing. v1: a choice is final once imported, and changing it needs the session undo (U5) first.
- **Undo (v57 / v60 / v63).**
  - The undo removes the combined and picked results like any import; nothing new in its scope.
  - The choice rows are not import data and stay, so after an undo the session is offered again with the same choice, which
    the reviewer may change.
- **Estimates (6b).**
  - "None" leaves the athlete without a GPEXE value, so an estimate is allowed (rule 4).
  - "Add them up" or "Use one track" writes real `api_import` values: an estimate is then refused (`estimate_measured_exists`),
    and an earlier estimate is superseded (M3) and listed in the preview's `supersededEstimates` (6b-B).
- **The dashboards' source filter.** Combined and picked values are `api_import` values of the source connection, so they
  appear under the existing policies like every import. No new policy word; the label is enough.

## 8. Slices

| Slice | Content | Mark | Reviewers |
|---|---|---|---|
| **MT-0** | This plan (docs) | ★ | the *Rukovodilac* |
| **MT-0** | Section 11: identical tracks are one recording. Mapper and preview only, no migration, no choice. **Merged** as PR #510 (`aa0794a`) | ★★ (trigger 3: the mapper's identity) | `code-reviewer`, `db-reviewer`; the *Nezavisni revizor*; the owner's yes (it is automatic) |
| **MT-A** | Migration (the next free number at PR time): `gpexe_track_choices` (`track`, `none`, `cleared`), append-only, its actor guard, preflight, post-check, rollback; the GET / PUT routes; tests (audience, identical 404, replay, a stale fingerprint, the lock order) | ★★ (triggers 1, 2, 4) | `db-reviewer`, `security-reviewer`, `code-reviewer`; the *Nezavisni revizor* |
| **MT-B** | Mapper, preview, writer: apply the current choice ("Use one track", "None"); the combined identity (only with MT-E); avg / last / none left out; `trackChoice` in the preview and its hash; `track_choice_stale` in the blocking resolution; a characterisation test that a single-track session is byte-for-byte unchanged | ★★ (triggers 3, 4) | `code-reviewer`, `db-reviewer`; the *Nezavisni revizor* |
| **MT-D** | Section 10: the `scale_recording` method in the 6b save (backend; its own migration: the method, its basis shape, the choice CHECK widened and `scale_target_minutes`), the mapper's "max only" result for a scaled athlete, the preview's `scaleRecording` entry | ★★ (triggers 1, 3, 4) | `code-reviewer`, `db-reviewer`; the *Nezavisni revizor* |
| **MT-E (later)** | "Add them up": the overlap guard of section 3 and the combined identity. Built only if a real sequential case appears, and after O2's evidence | ★★ | as MT-B |
| **MT-C** | Frontend: the choice row for a `multiple_tracks` athlete in the session review (the tracks side by side, the three options, the guard's reason when "Add them up" is not offered); the labels in the review and Activities | ★ | `code-reviewer`, `ux-design-reviewer`, `mobile-qa`; browser QA at 360 / 375 / 390 / 1280 |

Order: MT-0, then MT-A, then MT-B, then MT-D, then MT-C. MT-E only on a real sequential case and O2's evidence. **Two
migrations** (decided, 2026-11-12): MT-A's choice table, and MT-D's own for `scale_recording`, each under the next free number
at PR time.

## 9. Decisions and open questions

- **O1 (owner).** A combined or picked result is a measured `api_import` value, computed by the mapper with a source identity.
  It is not an estimate (this supersedes phase 10 D1 and §2.2's confirmation box for MT). Recommended: yes, as the
  *Rukovodilac*'s conditions say.
- **O2 (owner).** The overlap evidence for `total_time` (section 3). Recommended: one owner-run comparison before "Add them up"
  ships; until then, options 2 and 3 only.
- **O3 (owner).** `avg` variables in a sum. Recommended: refused in v1 (`not_combinable`). A time-weighted mean needs the same
  evidence as O2.
- **O4.** More than two tracks. Recommended: "Use one track" and "None" always; "Add them up" for any number of disjoint
  tracks, if the count of section 2 shows such sessions.
- **O5.** Who chooses: whoever may approve (recommended), or also the team's coach without an approver grant.
- **T1.** Whether T6 marks a combined value (section 6). Recommended: no new column.
- **MT-0 (owner): decided, yes** (2026-11-12). Identical tracks are taken as one recording automatically (section 11).
- **E1: decided** (2026-11-12). A deduplicated athlete's burst and brake are imported as the details give them (section 11).
- **O6 (owner).** `scale_recording`: max variables stay measured (recommended, as the owner asked), and avg variables are left
  out of a scaled athlete in v1 (section 10, Q-avg).

## 10. A fourth method: scale the recorded part (`scale_recording`)

**The owner's request (2026-11-12, relayed by the *Rukovodilac*):**
- **For whom:** an athlete with the short-recording flag (6a), for example 25 of 56 minutes.
- **What it does:** the measured values of the recorded part are multiplied by target minutes / recorded minutes. The target
  defaults to the session's longest recorded time, and the coach may change it.
- **Sum variables** are scaled: distance, counts, zone distances, and duration (which becomes the target).
- **Max variables** are not scaled; they stay as measured.
- **The label:** always an estimate, with the basis "25 → 56 min", the author and the time.

**Q1. Storage against M2 (no estimate while a real value exists).** Recommended: **(a), per variable.**
- M2 is per variable (v63's `estimate_measured_exists`), so an athlete may carry a measured value of one variable and an
  estimate of another. It never carries both for the same variable.
- **The choice** ("Scale the recorded part", with its target minutes) is recorded before the import, in the choice table of
  section 5, as `scale_target_minutes` (added by MT-D's migration). The athlete's track choice (single, a picked track, or the sum) says what the recorded
  part is.
- **The import** writes, for that athlete, only the variables that are not scaled: the `max` variables, as measured with their
  source identity. Its sum variables are left out of the import, with the reason `scaled_by_choice`, never as zero.
- **After the import,** the session review offers "Save the scaled values". This is the 6b save with the method
  `scale_recording`, run by the J20-C audience. It is never part of the approval's transaction (6b rule 4).
- **The scaled values.** The save recomputes the athlete's measured sum values from the imported candidate's stored snapshot,
  through the same mapper, extractors and conversion. The snapshot is kept for 90 days after an import
  (`gpexeImportService.js:605`).
  - Each value is measured × target / recorded.
  - Duration becomes the target.
- **The basis keeps the measured numbers,** so nothing is lost when the snapshot is purged:
  `{ recordedMinutes, targetMinutes, measured }`.
- **The rule for max variables:**
  - imported as measured, unscaled, with the athlete's source identity, and shown with the scaled values' label beside them
    ("max of the recorded part");
  - never estimated; v63 already refuses an estimate of a `max` variable.
- **Q-avg (O6):** an average over the recorded part is a measured value of another time base. Recommended: left out of a
  scaled athlete in v1 (`not_scaled`), neither measured nor estimated. The alternative, keeping it measured, is the owner's
  choice.

**Q2. The migration.**
- The estimate side needs:
  - the method `scale_recording` in `metric_value_estimates.method`'s CHECK;
  - its basis shape in `estimate_basis_ok` (exactly `recordedMinutes`, `targetMinutes` and `measured`: numbers,
    `0 < recordedMinutes < targetMinutes <= 600`);
  - `validate_metric_value_estimate` allowing it for `sum` variables only.
- These are two body replacements under md5 gates (v64's bodies) and one CHECK.
- **Decided (2026-11-12): MT-D's own migration**, under the next free number at PR time, not MT-A's. It also widens the choice
  table's `choice` CHECK and adds `scale_target_minutes`.

**Q3. With MT: a combined-tracks athlete who is still short.**
- The scale applies to whatever recorded part the track choice gives: one track, the picked track, or the sum.
- With "Add them up", the recorded minutes are the summed duration, and the 6a flag is computed on that sum.
- "None" cannot be scaled: nothing is recorded.

**Q4. The undo, a later full recording, and the dashboards.**
- **The undo** removes the scaled estimates with the session (v63: `estimates_removed`). The choice stays, as in section 7.
- **A full recording arriving later:**
  - GPEXE's rows for the athlete change, so the choice's fingerprint no longer matches and the choice is void (section 5);
  - the athlete is then imported normally, with all variables measured;
  - those real sum values supersede the scaled estimates (M3), and the preview lists them in `supersededEstimates` (6b-B);
  - the max value follows the existing correction rules.
- **The dashboards:** estimates are left out by default (6b-D), so a scaled athlete's sum variables show only under the
  `estimate` policy. The max shows like any import.

**When it is offered:** only for a row with the 6a flag (whole-session duration below 75 % of the session's longest), and never
for "None".

**The label:** "Estimate · scaled 25 → 56 min" (recorded → target), with the author and the time from the provenance row.

## 11. MT-0: identical tracks are one recording

**Built and merged** (2026-11-12): PR #510, merge commit `aa0794a`, exactly from head `e3490ee`, after both GOs (the *Rukovodilac*; the *Nezavisni revizor*, no findings). It waits for the owner's deploy.

**Why first.** Section 2's production count: every multi-track athlete today has two identical tracks (a duplicate).

**Is the duplicate ours? No, from the code and the stored bundle shape:**
- **Rows and tracks come as GPEXE sends them.** `fetchSessionBundle` takes each athlete row, and its `track`, as GPEXE's athlete
  list returns it, through the projection only (`backend/src/gpexeRestV1Adapter.js:1696-1715`).
- **The list+canary path of PR #212 keeps the track.** It replaces only `max_v` in a list row; the `track` field is untouched
  (`gpexeRestV1Adapter.js:1778`).
- **Each track object is GPEXE's own record,** read once per distinct track id named by the rows (`:1713-1714`).
- **Our paging cannot repeat a row.** `wholeList` refuses a row id that comes twice (`source_list_changed`,
  `gpexeRestV1Adapter.js:1113`). Even if it did, a repeated row carries the same track id: one track with two whole-session rows
  (`whole_session_row_count`), not `multiple_tracks`.
- **So two track ids mean two track records in GPEXE.** The fix belongs in the mapper. (The production count shows different
  track ids. That the two rows' own ids differ follows, since a row names one track.)

**The rule (mapper, fail-closed).** An athlete with more than one track is treated as **one recording** when all of these hold:
1. **The tracks themselves** (`gpexeRestV1Adapter.js:95`): every track has the same `utc_timestamp` and `timestamp`, and the same
   `timezone`.
2. **The athlete-session rows** (`gpexeRestV1Adapter.js:90`):
   - each track has the same set of levels: one whole-session row and the same drill indexes;
   - the rows of each level are equal in every consumed field: `is_stats_valid`, `total_time`, `total_distance`, `max_v`, `drill`.
3. **The `/more/` of those rows** (`gpexeRestV1Adapter.js:91-94`) is equal:
   - the six `events` fields (acceleration and deceleration counts, thresholds and durations);
   - every `complementary_data` zone of `power` and `speed`: `extremes`, `distance`, `is_ready`.

Anything different in any of these fields leaves the athlete as today (`multiple_tracks`).

**The details** (`tot_burst_events`, `tot_brake_events`) are one entry per athlete, not per track
(`backend/src/gpexeImportMapper.js:317`), so they cannot be compared between the tracks. The question was whether GPEXE counts a
duplicate track twice there (E1).

**E1 is decided (2026-11-12): imported normally.** For a deduplicated athlete, burst and brake are imported exactly as the details
give them, like any other athlete's. They are not left out and not divided.
- **The evidence** (the *Rukovodilac*'s read of the five production athletes with two identical tracks, 2026-11-12):
  - burst 17, 10, 4, 21 and 19; brake 12, 12, 4, 22 and 9;
  - four of the ten values are odd, so they cannot be twice a whole count (doubled values would all be even);
  - every value lies inside the range of the session's other athletes, per hour.
- So GPEXE counts the recording once. The reason `duplicate_track_details_unverified` and its switch are not built.

**Which track is used.** The lowest track id, with its rows. **The identity** is the one a single-track import of that track
has: `athlete_session:<its whole row id>:full` and `athlete_session:<its drill row id>:drill:<i>`.
- A later GPEXE cleanup that removes the other track keeps the same identities and the same values: the results are
  `unchanged`, never a new result and never a block (MT-0's route test 2).
- A cleanup that removes the lowest track leaves a row with another id, so a new identity. That is today's
  `identities_missing_from_source` block, resolved by the undo, as for any changed row.
- Choosing by the lowest id is deterministic. It cannot know which track GPEXE will keep.

**The label.** In the preview, the athlete entry carries `duplicateTracks: { count, usedTrackId, ignoredTrackIds }`. The session
review reads "Duplicate track ignored (2 identical tracks)".

**Stored candidates and the hash:**
- The rule changes the plan only for an athlete it applies to. Every other preview is byte-for-byte the same, and
  `PREVIEW_VERSION` stays.
- **A pending or blocked candidate with such an athlete:**
  - its bundle is the same, so the next search sees it as unchanged;
  - its finalization recomputes the preview, now importing that athlete, and so a new hash;
  - an approval sent with the old hash answers `preview_changed` and the session is reviewed again. This is the existing rule
    (9-B's refresh), and nothing is imported twice.
- **An imported session** whose duplicate athlete was left out (as `multiple_tracks`, before MT-0) **is not reopened.**
  - While GPEXE's content is unchanged, a new search only records a sighting of the imported candidate
    (`gpexeImportService.js` `finalizeCheck`, step 1); no new candidate and no new preview are made. So the athlete stays out.
  - The remedy is the U5 undo of that session: it writes a fresh pending candidate whose preview, computed by MT-0, now
    imports the athlete. O1 applies to roster work.
  - The sessions concerned are the section 2 query limited to `status = 'imported'`; the *Rukovodilac* tells the owner which.
  - Proof: MT-0's route test 4 (an imported session with the athlete left out, the same bundle searched again: still one
    imported candidate, no identity for the athlete).

**No choice, no migration, no route.** It is automatic, so it needed the owner's yes, given on 2026-11-12.

**Tests (MT-0):**
- the fixture with two identical tracks gives one participant from the lowest track, with the native identities and the label;
- one differing field in any compared group (track, row, `/more/`) gives `multiple_tracks`, with a case per field group;
- a deduplicated athlete's burst and brake imported exactly as the details give them, once, with nothing left out (E1);
- a session without duplicates gives a byte-for-byte unchanged plan and preview;
- the stored candidate's refresh (`preview_changed`, then the import; route test 3);
- a later cleanup in both directions (unchanged, or blocked).

## 12. MT-B: applying a choice (plan check, 2026-11-13)

A plan note for the *Rukovodilac*, written before any code and checked against main `8aeefa4f` plus MT-A (#513, `5d97cb8c`).
MT-B changes the mapper, the preview and the writer, and no route or table. ★★ (triggers 3 and 4).

### 12.1 Where the choice is read, and where it is applied

- **One read, under the team lock.** `previewLocked` (`backend/src/gpexeImportPreview.js:379`) reads the current choices of
  the session's athletes from `gpexe_track_choices` with a plain read, keyed by (team, session). Every caller already holds
  the team lock:
  - the check's preview (`buildCandidatePreview`, :349);
  - the approval (`gpexeImportService.js` :2500, :2547);
  - the J20-A1 recompute (:2802, :2822);
  - the J20-B subset preview (:2978, :2998).
  The MT-A PUT writes under the same lock. So a preview and its approval see one choice, and a choice changed between them
  changes the recomputed preview, which the approval answers with `preview_changed` (the existing rule; nothing new).
- **One application.** `buildGpexeImportPlan(bundle, { metricSpecs, teamTimezone, trackChoices })` gets a new option, a Map
  from GPEXE athlete id to `{ choiceId, kind, trackId, fingerprint }`. `previewLocked` builds the plan with it, and the import
  itself writes that plan (`importGpexePlanLocked`, :21). The preview and the approval's import therefore never disagree.
  - The gate plans (`metricSpecs: []`, at :338, :388, and service :2513, :2809, :2985) read only the event's identity and the
    session's facts. No athlete matters there, so they need no choice.
  - The CLI / test path `importGpexeBundleLocked` (`gpexeImportWriter.js:683`) builds its own plan. It gets the same read
    under its own team lock, or it refuses a session whose multi-track athlete has a current choice
    (`track_choice_not_supported`). The second is smaller; recommended.
  - The 7e aggregate preview (`gpexeLevelValues`, `gpexeImportMapper.js:554`) keeps leaving a multi-track athlete out. It
    shows a mapping's values over single recordings, and a reviewer's choice is no measurement fact. Recommended: unchanged.
- **The shared fingerprint.** The mapper exports `trackSetFingerprint(athleteRows)`, and the MT-A service imports it in place
  of its own copy. One function, so the stored fingerprint and the mapper's comparison cannot drift (the code review's LOW on
  MT-A).

### 12.2 What the mapper does with each choice

Only an athlete with two or more tracks that MT-0 does not take as one recording is affected. Today such an athlete is the
`multiple_tracks` anomaly.

| Current choice | Fingerprint | The mapper |
|---|---|---|
| none, or `cleared` | - | as today: `multiple_tracks` |
| `track` | equal | the chosen track's rows only, as a single-track athlete: **native identities** `athlete_session:<row>:full` / `…:drill:<i>` of that track; the participant carries `trackChoice: { choiceId, kind: "track", trackId, trackCount }` |
| `none` | equal | no participant; an anomaly `no_track_by_choice` (not `multiple_tracks`) with `trackChoice: { choiceId, kind: "none", trackCount }` |
| any | different | `multiple_tracks` as today (today's detail text), with `trackChoice.stale: true` and the stale `choiceId`; a blocked session's resolution names `track_choice_stale` (also once GPEXE leaves the athlete a single track). Never applied to other tracks |

- **A chosen track's values are the athlete's measured values.** They count everywhere that measured values count: the 6a
  short-recording flag, M2 (no estimate over a measured value), the dashboards' `api_import` policy.
- **Choosing the lowest track is never automatic.** Only MT-0's identical copies merge without a choice.

### 12.3 The preview, its hash and the batch

- **Per athlete entry:**
  - `trackChoice: { choiceId, kind, trackId?, trackCount, stale }`, present only when a current choice exists. So a session
    without a choice gives a **byte-for-byte unchanged** preview and hash, and `PREVIEW_VERSION` stays 3, as with MT-0's
    `duplicateTracks`.
  - `kind: "track"`: `gps.status` is `measured`, and the results come from the chosen track.
  - `kind: "none"`: `gps.status` is a new value `not_used_by_choice`, and
    `notImported: { code: "no_track_by_choice", message: "Left out by choice: GPEXE recorded this athlete on more than one track, and no track is used." }`.
  - Stale: as today (`needs_manual_review`, `multiple_tracks`), plus `trackChoice.stale: true`.
- **The hash** covers the preview, so it changes when a choice is made, changed or cleared, and when GPEXE's tracks change
  the fingerprint.
  - **After a PUT, the stored preview is out of date.** The review must call the J20-A1 recompute
    (`POST …/candidates/:id/preview`) to show the choice. That is MT-C's flow; an approval sent with the old hash answers
    `preview_changed` and stores the recomputed preview (the existing rule).
  - The PUT does not recompute, so it stays small and its lock order unchanged.
- **The batch:**
  - `athleteReason` (`gpexeImportReasons.js:91`) gives no reason for `not_used_by_choice` or a used track.
  - A session whose only blocker was a chosen athlete becomes batch-approvable.
  - A stale choice is still `athletes_need_manual_review`.
- **The roster** (`gpexeRosterObservations`, `gpexeImportService.js:2083`):
  - `not_used_by_choice` is not in `GPEXE_UNUSABLE_REASON`, so a "none" athlete gets **no** `record_unusable` observation. The
    roster then shows the athlete as needing a state, and the coach decides (*Participated · no device data*, then an
    estimate, 6b), as the plan's "None" says.
  - A used track counts as imported and resolves an open observation.
  - A stale choice stays `needs_manual_review`, with the observation as today.

### 12.4 Stale fingerprints and an import

- **Before an import:** a stale choice is shown with `trackChoice.stale` and the athlete stays `multiple_tracks`. The reviewer
  chooses again (`expectedChoiceId` = the stale choice's id).
- **After an import:** MT-A makes the choice final (`choice_final_after_import`, session-wide).
  - If GPEXE later changes that athlete's tracks, the imported identities go missing, and the session is blocked by the
    existing `identities_missing_from_source` rule (`gpexeImportPreview.js:611`).
  - MT-B adds the resolution cause `track_choice_stale` (action `undo_and_choose_again`) for an athlete whose current choice
    is stale. Its step: "GPEXE changed this athlete's tracks after the import. A platform admin undoes the import of this
    session (U5), then the track is chosen again."

### 12.5 What a coach without the approver right sees

- **The review** (the preview, for everyone who may open it):
  - "Track 2 of 2 used" for `track`, with the position by the track's start;
  - "Left out by choice" for `none`;
  - "Track choice out of date: GPEXE changed the tracks" for a stale choice.
  - **No chooser** and no choice id in the coach projection: `gpexeImportAudience.js` drops `trackChoice.choiceId` for the
    `other` audience. The two administrators get it.
- **The approver-only GET** (MT-A): the *Rukovodilac*'s LOW 2 on #513. `chosenByUserId` is replaced by `chosenBy: { name }`,
  the display name, in MT-B. The id is not shown to anyone.
- **The PUT's order** (the *Rukovodilac*'s LOW 1 on #513): the audience check comes before the body validation, so a team
  member without the right gets the identical 404 for a malformed body too.

### 12.6 The T6 / provenance label

- **A used track** writes native identities, so T6 and the source identity look exactly like a single-track import. No column
  is needed (T1 stays answered "no new column").
- **The label** "One of N tracks (track started HH:MM)" in Activities and the review is read from the current choice row.
  It is stable after an import, because MT-A makes the choice final while the session is imported. After an undo it follows
  the new choice.
- Reading it in Activities is a small backend field on the activity read plus the frontend label. Recommended in MT-C
  together with the review's row, not in MT-B.
- **"None"** writes nothing from GPEXE, so there is nothing to label in T6. The roster state and its reason say it.

### 12.7 Existing tests that change, and the new ones

- **Unchanged by construction** (no choice row exists in them). They act as the characterisation that a session without a
  choice is byte-for-byte the same:
  - `gpexe-import.test.mjs` and `gpexe-in-app-import.test.mjs` (athlete 103, `multiple_tracks`);
  - `activity-roster-5a1.test.mjs` (`record_unusable` for two tracks);
  - `gpexe-import-reasons.test.mjs`;
  - `gpexe-duplicate-tracks-mt0*.test.mjs`;
  - `source-metric-preview-math-7e.test.mjs` and `source-metric-preview-7e.test.mjs` (the 7e path stays as it is).
  MT-B's first test is a stored-preview comparison over the fixture sessions, before and after, with no choice.
- **Changing:**
  - `gpexe-track-choices-mt-a.test.mjs`: the GET's `chosenBy`, and the 400/404 order;
  - the 9b architecture test, if it lists the tables `previewLocked` reads (to be checked when the code exists).
- **New** (`gpexe-track-choices-mt-b*.test.mjs`):
  - the mapper with `track` (native identities, values equal to that track's single-track import), `none`, `cleared`, stale;
  - the preview's `trackChoice` and hash changes;
  - the coach projection without `choiceId` or chooser;
  - the batch with a chosen athlete;
  - the roster: no `record_unusable` for `none`, resolved for a used track;
  - `preview_changed` after a choice changed between review and approval;
  - an import with a used track, then the PUT refused (`choice_final_after_import`);
  - a stale choice after the import blocked with `track_choice_stale`;
  - the CLI path refusing a session with a choice (`track_choice_not_supported`);
  - mutations on the application, the stale check and the projection.

### 12.8 Open for the *Rukovodilac*

1. The CLI / test writer path: refuse with `track_choice_not_supported` (recommended) or apply the choice too.
2. The 7e aggregate preview stays without choices (recommended).
3. The Activities label goes into MT-C with the review row (recommended), not MT-B.

### 12.9 Decided (the *Rukovodilac*, 2026-11-13)

**Decisions:**
1. The CLI / test writer path (`importGpexeBundleLocked`) refuses a session that has a current choice, with
   `track_choice_not_supported`.
2. The 7e aggregate preview stays without choices.
3. The Activities label goes into MT-C.

**Addition: `none` lifts no other blocker.** A `none` choice only replaces that athlete's own `multiple_tracks` reason. The
session stays as blocked or as not ready as its other facts make it:
- a whole-session block;
- another athlete's manual review, missing link or membership;
- changes to imported results that need acceptance.

Test: a session with a `none` athlete and an unlinked athlete stays not ready in the batch.

**Addition: consistency with 6b.** A `none` athlete has no GPEXE value, so:
- the coach may set an activity-level state (*Participated · no device data*) and, from it, an estimate (6b rule 4, M2);
- nothing in MT-B writes over that state or that estimate.

The cases follow the existing rules:
- The choice is final while the session is imported (MT-A).
- If the import is undone (U5 removes its estimates and roster work, v60 / v63) and the athlete is then given `track`, the
  next import writes real values. M3 supersedes an estimate still effective at that point, and it is listed in the
  preview's `supersededEstimates` (6b-B).
- An estimate never makes the athlete importable or blocks the session.

Test: a `none` athlete imported as left out, then an estimate saved for that athlete, is still its only value. The next
search of the unchanged session changes neither the estimate nor the state.

**Order:**
- No MT-B code before v67 (MT-A, #513) is deployed and post-checked.
- This section goes to a docs pull request after #513 is merged, so it merges without a conflict.

### 12.10 LOWs carried from MT-A's GO (#513, 2026-11-13) into MT-B's pull request

- **L1 (the *Nezavisni revizor*).** A test: two first choices of one athlete, inserted from two connections with the guard
  satisfied, get 23505. Otherwise the partial unique index `gpexe_track_choices_one_root` is not killed by any test.
- **L2 (the *Nezavisni revizor*).** A test that switches the team to pilot mode at the PUT's `beforeTeamLock` hook, so the
  mapping of 55000 `team_import_pilot_mode` to the identical 404 is killed.
- **L3 (the *Rukovodilac*).** The PUT checks the audience before it validates the body: someone outside the audience gets the
  identical 404 for a malformed body too.
- **L4 (the *Rukovodilac*).** `chosenByUserId` leaves `choiceView`. The approver-only GET shows `chosenBy: { name }`.

## 13. MT-D: `scale_recording` (plan check, 2026-11-13)

Section 10 checked against `main` `bcadaec2` (MT-B merged). The findings below change or complete section 10. **Decided**
by the *Rukovodilac* on 2026-11-13: every item of 13.7 as recommended, with 13.8 and 13.9. The migration is **v68**, with a
prefix after `202611131200` (J18's v66 is not merged; whoever merges later re-issues its preflight block).

### 13.1 The 6a flag is a hint in the browser only

`SHORT_SHARE = 0.75` and `markShortRecordings` live in `frontend/gpexe-import-view.js`. The server has no notion of a short
recording. Section 10 says "only offered for a row with the 6a flag".

**Recommendation:**
- The screen offers the scale only on a flagged row.
- The server checks the basis only: `0 < recordedMinutes < targetMinutes <= 600`. It does not check the 75 % share.
- The owner called the flag "a hint only, never a decision", so the server does not turn it into a rule.

### 13.2 Most short athletes have one track, and the choice table refuses them

v67's `track_set_fingerprint` CHECK needs **at least two tracks**. The MT-A service answers `not_multiple_tracks` for a
single-track athlete. A substituted player (the 6a case) usually has one track, so section 10's "the choice table, as
`scale_target_minutes`" cannot hold their choice as v67 stands.

**Recommendation:** MT-D's migration widens the table rather than adding a second one:
- the fingerprint CHECK accepts one track;
- `scale_target_minutes` is added (`numeric`, null, or `0 < x <= 600`);
- the guard (v67's `validate_gpexe_track_choice`, replaced under its md5 gate `909c3c79…`) refuses:
  - a one-track row that is not `choice = 'track'` with a scale (a one-track athlete without a scale needs no row);
  - `none` with a scale;
  - `cleared` with a scale.
- A scale on a multi-track athlete rides on its `track` row (section 10 Q3). MT-E's `sum` does the same later.
- `cleared` removes both the track and the scale, so the athlete is imported as before.

**The PUT (MT-A's route) for a scale:**
- it takes `{ choice: 'track', trackId, scaleTargetMinutes }`;
- for a one-track athlete only with a scale;
- `not_multiple_tracks` stays the answer for a one-track athlete without a scale;
- the audience is the same as MT-A's (whoever may approve), because the choice is made before the import.

### 13.3 The values to scale: the stored preview, not a second mapper run

Section 10 says the save "recomputes the athlete's measured sum values from the imported candidate's stored snapshot, through
the same mapper". Two facts make that fragile:
- **The activations can change between the import and the save.** The mapper needs `mapping.rows`, and running it again with
  today's activations can give other values, or none.
- **The retention purge clears `raw_bundle` and `preview` together** (v22 retention, 90 days after an import). The two live
  exactly as long as each other, so the snapshot offers no longer window than the preview.

**Recommendation:**
- For a scaled athlete the mapper puts the sum values it leaves out (`scaled_by_choice`) into the preview entry as
  `scaleRecording: { targetMinutes, recordedMinutes, values: [{ metricDefinitionId, versionId, value, unit }] }`.
  - `recordedMinutes` is the athlete's whole-session duration from the same plan.
  - The entry is part of the preview hash, so the approval binds the numbers the coach saw.
- The save (`metricEstimateService`, method `scale_recording`) reads them from the **imported, not undone** candidate of the
  event's session, `status = 'imported'`. The approval imports exactly the stored preview: the hash is equal, so the stored
  preview is the imported one.
  - It writes `measured × target / recorded` for each value.
  - Duration becomes the target.
  - The basis is `{ recordedMinutes, targetMinutes, measured }`, as section 10 says.
- After the purge, the save answers `409 scale_basis_expired`. The scaled values already saved keep their basis.
- **Consequence:** the mapper specs need the variable's daily aggregation. `gpexeImportMapping.js` (the activation rows) adds
  `daily_aggregation_method` from the definition's current version. Without a choice the preview gains nothing, so the
  no-choice hash is unchanged (pinned, as in MT-B test 1).

### 13.4 Which values of a scaled athlete are imported

Whole session:
- `max` is imported as measured.
- `sum` is left out with `scaled_by_choice`, and its numbers go into `scaleRecording`.
- `avg` is left out with `not_scaled` (O6, Q-avg).
- `last` and `none` are imported as measured: they are not totals.

**Drills (open, 13.7 D2).** Estimates are whole-session only (v63: an estimate occasion has no segment, and M2 looks at whole
sessions only). So a scaled athlete's drill values have no estimate path. Recommended: import them as measured. A drill the
athlete was on the pitch for is a real recording. They do not take part in M2.

**No duration variable (13.7 D3).** If the team's activations do not include the duration variable, `recordedMinutes`
cannot be known. Recommended: the athlete is imported as without a choice, and the preview entry carries
`scaleRecording: { notPossible: "no_duration" }`, so the screen can say in one sentence why the scale was not applied. This
never guesses a value.

### 13.5 The migration (MT-D's own, the next free number, after v67)

- `metric_value_estimates.method` CHECK gains `scale_recording`.
- `estimate_basis_ok` (v63, `immutable`, used by a CHECK) is replaced under an md5 gate with a `scale_recording` branch:
  - exactly the keys `measured`, `recordedMinutes` and `targetMinutes`, all numbers;
  - `0 < recordedMinutes < targetMinutes <= 600`;
  - `measured >= 0`.

  The existing rows stay valid, because only a branch is added.
- `validate_metric_value_estimate` (v64's body, md5 gate) allows `scale_recording` for `sum` variables only.
- `gpexe_track_choices`:
  - the fingerprint CHECK accepts one track;
  - the `scale_target_minutes` column, with its CHECK;
  - the guard replaced under its md5 gate (13.2).
- The rollback refuses once:
  - a `scale_recording` estimate exists;
  - a one-track or scaled choice row exists;
  - a later migration is recorded.

  It is rehearsed in a test (apply → rollback → catalog equal → re-apply).

### 13.6 Locks, audience and tests

**Locks and the save:**
- The save is the 6b save: decider lock, team try-lock, alias set, request lock, then the writes. It reads the candidate
  without a lock, because an imported candidate does not change; an undo leaves it undone, and the save then answers
  `estimate_not_available`.
- It is never inside the approval's transaction (6b rule 4).
- The save's audience is 6b's (J20-C, `lock_activity_decider`). The choice's audience is MT-A's.

**Tests:**
- mapper:
  - the scaled athlete's max values are imported, sum values go into `scaleRecording`, avg is `not_scaled`, and drill values
    are imported (D2);
  - without a choice the plan hash equals the base;
- preview hash and `preview_changed` when a scale changes;
- the PUT with a scale on one track and on two tracks; refused without a scale on one track, and for `none` / `cleared` with
  a scale;
- the save:
  - the values, duration = target, and the basis;
  - refused for a non-sum variable;
  - `scale_basis_expired` after a purge;
  - replay;
  - the recorded SQL order;
- the undo removes the scaled estimates;
- a later full recording voids the choice and supersedes the scaled estimates (`supersede_estimate_on_value`);
- the migration round trip and the md5 refusals;
- the dashboards' estimate policy shows the scaled values only under `estimate`;
- mutations of the shares, the aggregation routing and the basis branch.

**Triggers:** 1, 3 and 4. Reviewers: `db-reviewer`, `code-reviewer` and `security-reviewer` (the PUT widens its body), then
both GOs and the owner's order naming the migration.

### 13.7 Open for the *Rukovodilac*

- **D1.** The source of the values to scale: the stored preview (13.3, recommended) or a second mapper run over the snapshot
  (section 10 as written).
- **D2.** A scaled athlete's drill values: imported as measured (recommended) or left out.
- **D3.** No duration variable on the team: the scale is not possible, and the athlete is imported as without a choice
  (recommended).
- **D4.** One-track scale rows in v67's table (13.2, recommended) or a separate scale table.
- **D5.** The server does not check the 75 % share; the basis bounds only (13.1, recommended).
- **Two PRs or one.**
  - MT-D1: the migration with the PUT and mapper side (★★).
  - MT-D2: the 6b save of `scale_recording`. It could ride in D1, since the method CHECK is in the same migration.
  - Recommended: one PR, so no method exists without its save.
- **The screen** (offer, label "Estimate · scaled 25 → 56 min") is MT-C / the design executor's.

**Decided (2026-11-13):**
- D1–D5 as recommended.
- O6 stays: `avg` left out as `not_scaled` in v1; `max`, `last` and `none` imported as measured.
- One PR for the migration and the save. The screen belongs to the design executor's coach flow.

### 13.8 While `ESTIMATES_ENABLED` is off (correction to the expectation)

The expectation was:
- the choice can be stored;
- the import leaves the sums out as `scaled_by_choice`;
- the estimate save is refused by the flag (the routes' identical 404, phase 5b contract).

**The last two are right, but together they lose data.** Under that expectation, a scaled athlete's whole-session sums are
neither imported nor estimable until the flag is on. That is only after 6b-D, on a separate owner order. Meanwhile the
athlete would show no distance, no counts and no duration at all.

**Correction (recommended):**
- The PUT refuses a scale while the flag is off, with `409 scale_not_available` ("Scaling a short recording is not switched
  on yet."). The choice without a scale (MT-A / MT-B) is unchanged.
- No new scale choice can then remove measured values before the save exists.
- A scale choice stored while the flag was on keeps its effect if the flag is later turned off. Its values stay in the
  imported candidate's stored preview for the 90 days of retention, and can be saved once the flag is back on.
- The mapper does not read the flag. The preview and its hash do not depend on the environment.

### 13.9 Dashboards, the undo and a later full recording

**Dashboards before 6b-C / 6b-D.**
- `resolveFactsToRows` (`backend/src/trainingLoadDashboardQuery.js`) has no estimate rule yet. Under the default
  `all_with_conflicts` policy it would count an `estimate` fact like a measured one.
- That is why the flag stays off until 6b-D is deployed (phase 5b contract). With 13.8, no scale exists before then.
- **With the flag off**, a scaled athlete therefore cannot exist. An unscaled short athlete shows their measured values as
  today.
- **From 6b-D on**:
  - a scaled athlete's `max` values (and `last`, `none` and the drill values) show like any import;
  - the scaled sums show only under the `estimate` policy (6b-D);
  - under every other policy the athlete has no whole-session sum for that session.

**The undo.**
- It removes the session with the scaled estimates (v63 `estimates_removed`).
- The choice stays (section 7), and so does its scale.
- A re-import applies it again, while the fingerprint still matches.

**A later full recording** (M3):
- GPEXE's rows change, so the fingerprint no longer matches. The choice is stale, and the athlete is imported as measured.
- If the session was imported before, the change is `identities_missing_from_source` until the import is undone (MT-B), as
  for any track change.
- The new measured sums supersede the scaled estimates through `supersede_estimate_on_value` (v63). The preview lists them in
  `supersededEstimates` (6b-B).
