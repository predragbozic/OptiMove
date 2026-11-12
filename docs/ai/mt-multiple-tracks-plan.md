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
- **Lock order** (decided, 2026-11-12), the approval's: an unlocked rights read (the fast 404) → the candidate FOR SHARE
  (pending or blocked, its snapshot available) → the team import lock (blocking, with the approval's `lock_timeout` mapped to
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
| **MT-0** | Section 11: identical tracks are one recording. Mapper and preview only, no migration, no choice | ★★ (trigger 3: the mapper's identity) | `code-reviewer`, `db-reviewer`; the *Nezavisni revizor*; the owner's yes (it is automatic) |
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
