# Central calendar — the event panel package: each athlete's RPE and duration, the summary, the athlete click

Status: **Decided by the stream manager** (2026-11-20: Q1–Q7 as recommended, section 6), revised after its internal
reviews (section 8). Item 5 of the K4 plan's order (`docs/ai/central-calendar-k4-plan.md`, section 6). Documents only;
written against `main` `148fcd55` (K3 merged). No migration. No code before this document's GO.

The goal, in the plan's words: in the coach's event panel, each athlete's RPE and duration, a summary
("Answered 12/15 · average RPE 6.8"), and a clearer athlete click.

## 1. The data today (file:line, on `148fcd55`)

### 1.1 What the panel's reads carry per athlete

| Read | Who gets it | Per athlete | RPE value / duration |
|---|---|---|---|
| The event card, `GET /api/calendar` (range, then the panel's own day read with `include=athletes`: `frontend/central-calendar-data.js:465-504`) | every coach who reads the card | `athletes[].rpe` as a **state**: `submitted` / `missing` / `missed` / `not_asked` / `null` | **no** |
| — its sources | | linked planned sessions (`backend/src/calendarQuery.js:785-818`, `applyEventFold`; one state per athlete, merged by `mergeRpeState` `:180-184`); a folded RPE request of the event's schedule (`:1287-1301`, its states replace the athletes', only when `scheduleFold.external` is `folded`); a linked athlete no longer targeted is listed with `targeted: false` (`:817`) | |
| — its links | | `links.logicalSessionIds`, `links.externalScheduleId` (`:1403`; reduced for a reader, `:1438`) | |
| — the card's count | | `card.rpe = { asked, submitted }` (`:806-810`): counts **entries** (one per linked session that asks, plus one per assignment of a folded request), not athletes | |
| `GET /api/calendar/events/:eventId`, **manager** (`backend/src/calendarEventService.js:619-623`, `viewOf` `:432-450`, `linkFacts` `:463-488`) | `eventWriteBasis` ≠ null | `sessionLinks[]` (plan, day, slot with `order`, `logicalSessionId`, `athleteId`, `athleteName`, `asksRpe`), `externalScheduleId` | **no** |
| `GET /api/calendar/events/:eventId`, **reader** (`reducedViewOf` `:496-531`) | reads the event through the calendar's scope | targets in the reader's scope (athlete names) | **no** |
| `GET /api/calendar/events/:eventId/questions`, manager only (`backend/src/calendarQuestionService.js:66-119`; 404 unless questions are on and `eventWriteBasis`, `:80`) | the event's manager | per RPE question: `answered[]` with `changed` / `lastChangedAt` (v83, `:81-88`, `:112-114`), `later[]`, `notAnswered[]` | **no** (who answered, and when it last changed) |
| `GET /api/training-load/weekly?weekStart&athleteIds` (`backend/src/routes/trainingLoad.js:1078`) | a coach, for the athletes of the active workspace's scope (`coachWorkspaceScopeSqlForWorkspace`, `:1156`; current **active** memberships, `:1017`, `:1023`) | every session and RPE request of the week, `feedback: { rpe, durationMinutes, srpe, note, submittedAt }` (`formatFeedback` `:163-172`) | **yes** |
| — planned rows (`:1319-1380`) | | `planId`, date, `amPm`, `bta`, `sessionName`, `athleteId`, `rpeEnabled`, `workspacePlannedRpeEnabled`; **no `logicalSessionId`, no session order** | |
| — RPE-request rows (`:1416-1451`) | | `scheduleId`, `externalAssignmentId`, date, `athleteId`, `assignmentStatus`, `closesAt` | |

A changed answer (v83) is the same row: `training_load.change_external_rpe()` writes the history and updates
`session_feedback` in place (`migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql:362`, `:371`). Every
reader of the row sees the current value (ADR-004).

### 1.2 Is the value there for a manager?

**Yes, for every athlete who is still a member of the manager's active workspace; and there is one gap.** The
calendar's own reads have states only. The values are in `GET /api/training-load/weekly`, which a manager may already
call.

**The two reads use different membership rules:**
- The card names an event's athletes by membership **on the event's day** (`calendarAccess.js:108-112`,
  `membershipOnDaySql`; targets are checked on the event's first day, `calendarEventAccess.js:131-171`).
- `/weekly` scopes by **current active** membership (`trainingLoad.js:1012-1033`).

So an athlete who has left the team or club since the event (or was moved) stays on the card, but `/weekly` no longer
returns her. Whether a club workspace's scope (an active `membership_type='club'` row, `:1017`) can also miss a
team-only athlete of a club event is **not verified**; P3 checks it.

The difference fails closed: such an athlete keeps her state, with no value (section 3). The other bases are covered:
- the platform workspace scopes nothing (`:1014`);
- a team coach on a team event uses the team membership;
- a private coach's `/weekly` scope is wider than the event's target rule.

**The gap:** the planned rows carry no `logicalSessionId` and no session order, so a panel could match a linked session
only by plan, day, AM/PM and B/T/A. Two sessions in one slot (a Builder day with two Training sessions) cannot be told
apart. The RPE-request rows match exactly, by schedule, day and athlete.

### 1.3 The smallest read: two fields on rows the coach already reads (decided, Q1)

Add `logicalSessionId` and `sessionOrder` to the planned rows of `GET /api/training-load/weekly`:
- **the live rows** (`:1319-1380`): the query's select (`:1185`) gains `ps.logical_session_id` and
  `ps.session_order`;
- **the orphaned rows** (`:1385-1411`): the query's select (`:1276`) gains `sf.logical_session_id`, which is non-null
  there because of `sf.source = 'planned'` (`:1289`). Their `sessionOrder` is `null`: the feedback row stores no order.

What this changes, and what it does not:
- **No new route, no new row, no access change.** The rows are the same, for the same caller, under the same scope
  predicate. Only an opaque id and an order of a session whose row the caller already reads are added.
  - A live row's id is already on that caller's calendar card (`links.logicalSessionIds`).
  - An orphaned row's id is not on any card, since its session is gone, but it belongs to a feedback row the same
    caller already reads.
  - No route takes a `logicalSessionId` from a request.
- **Trigger 2: no.** No auth, role, `owner_scope` / `data_workspace`, cross-workspace or info-hiding contract changes
  (`security-reviewer`, section 8). Reviewers: `code-reviewer` alone for the backend part (the orchestration matrix's
  "ordinary backend query").
- **How the panel matches:**
  - a linked session by `logicalSessionId` + `athleteId`, taken from the card's `links.logicalSessionIds`;
  - an RPE request by `scheduleId` + date + `athleteId`, **only when `item.scheduleFold.external === "folded"`**.
    When the request stays a separate card (`separate`, `calendarQuery.js:1292`), its states are not the event's, so
    neither are its values.

**Rejected:**
- **Frontend only, matching by slot:** ambiguous for two sessions in one slot. A wrong number in front of a coach is
  worse than none.
- **A new manager-only read on the events router** (`GET /api/calendar/events/:eventId/answers`): exact and narrow,
  but it is a new route gated by the event's manage right, with its own 404 for everyone else. That is an info-hiding
  contract, so **trigger 2 applies** (★★, the external review). Nothing here needs it, because the values are already
  readable by the same coaches.

**The weekly read's write.** `/weekly` materialises the active workspace's due RPE occurrences before reading
(`ensureCurrentExternalOccurrencesForCoach`, `:1171`; `trainingLoadOccurrenceService.js:153-172`). It changes no
authorization and exposes nothing. The panel adds no new kind of write, but it does add this call when a manager opens
an event's panel.
- In the platform workspace it covers every active schedule in the system. That is a load cost, not an exposure, and
  it is the same cost as opening Training Load there today. Recorded, not a blocker.
- The comment at `trainingLoad.js:1036-1041` ("no materialization") contradicts `:1171`. The build PR corrects that
  comment.

## 2. Who sees what

| Viewer | Sees |
|---|---|
| **The event's manager** (`item.canManage === true`) | per athlete the value and duration of each asked entry, "Changed HH:MM" where the questions read gives it, and the summary |
| **A reader** (a coach who reads the event but may not manage it) | exactly today's panel: the states ("RPE entered" / "RPE missing" / "RPE missed" / "Not asked", `frontend/central-calendar-view.js:394-406`), no summary, no values. The panel does **not** call the weekly read for a reader. |
| **The athlete** | untouched. The athlete's Calendar (K4a), her own event card and the athlete branch of `/weekly` (`trainingLoad.js:1120-1135`, bound to her own id) are unchanged; the two new fields on her own rows name her own sessions. |

**This is a UI rule, not an authorization rule.** Nothing on the server marks the values as manager-only: `/weekly`
never reads event rights, and any coach already reads these values for the athletes of their active workspace. The
`canManage` gate decides what the panel shows. It must never be cited as an access boundary.

**When the values are read (Q7):**
- **Read on every open of a manager's panel, and again when the panel moves to another event or day.** Not cached: an
  athlete may change her answer (v83) while the coach looks.
- **Scope of the read:** the panel's day only (`weekStart` = that day's Monday, `athleteIds` = the card's athletes).
- **A late answer** for a panel that closed or moved is dropped (the day read's generation check,
  `central-calendar-data.js:482`).
- ***Try again*** re-reads.

**A workspace switch between the event read and the weekly read** scopes the weekly read to the new workspace. It
fails closed: values for athletes in both scopes, or none. A workspace switch also closes the panel.

## 3. The summary

`Answered 12/15 · average RPE 6.8`, under the panel's Athletes heading, for a manager only, **when at least one
athlete is counted**.

**Who counts:** the athletes the card lists with `targeted !== false` whose state is not `not_asked` / `null`.
- An athlete counts once, whatever the number of her asked entries.
- She is **answered** when her merged state is `submitted`, that is, every asked entry of hers is submitted.
- `missed` (the window closed) counts in the denominator, not as answered.
- **Excluded athletes** (`targeted: false`, linked but no longer targets) are left out of both numbers. Their rows
  move after the others with a new mark, "No longer in this event". Both are new: today's list sorts by name only
  (`central-calendar-view.js:835`) and does not read `targeted`.
- **The heading's count** ("Athletes (16)", `item.athleteCount`, `:826`) includes excluded athletes, so it can differ
  from the summary's denominator. This is accepted; the summary's label names what it counts ("Answered").

**Which entries are asked** (each matched weekly row of a counted athlete):
- a planned row is asked when `rpeEnabled && workspacePlannedRpeEnabled` (the card's `rpe_expected`,
  `calendarQuery.js:208`);
- a matched RPE-request row (folded request only) is asked.

**Each entry's state:**
- rated → submitted;
- an RPE-request row not rated → `missed` once its assignment is closed (`assignmentStatus`, `closesAt`), else
  `missing`;
- a planned row not rated → `missing`.

A rated row that is not asked (its RPE was switched off later) shows its value on the row as "Not asked (RPE 6)" and
stays out of the average.

**The average:** the mean of the RPE values of the counted athletes' submitted, asked entries **that the weekly read
returned**.
- One decimal, rounded half up on the value × 10 (`Math.round(sum * 10 / n) / 10`, shown with one decimal: 7 → "7.0").
- Every such entry counts once. An athlete with Training and After both answered adds two values.
- An athlete who is not answered (one entry submitted, another missing) still adds her submitted value.
- **Values the read did not return** (an athlete no longer in the active workspace, section 1.2): she still counts by
  her card state, and the average covers only the values read. When that leaves fewer values than submitted entries,
  the line names the number: "Answered 12/15 · average RPE 6.8 of 11 answers" (answers = entries with a value).
- With **no value read at all**: "Answered 12/15" and no average.

**Other cases:**
- **No answers:** "Answered 0/15", with no average.
- **Nobody counted** (no state, or the event expects RPE but no channel asks yet): no summary line, never
  "Answered 0/0".
- **A changed answer (v83):** the current value counts (the row is updated in place).
- **The card's own count stays as it is.** "RPE 14/16" counts entries (`calendarQuery.js:806-810`); the panel's
  summary counts athletes. See Q2.

## 4. The athlete row and the athlete click

### 4.1 The row (manager)

`Ana Example — RPE 7 · 60 min · Changed 21:40`, then the teams.

- One answer: "RPE 7 · 60 min".
- Several asked entries: one short group per entry, in slot order, each named by its session or "RPE request" (e.g.
  "Training RPE 7 · 60 min · After RPE 4 · 15 min").
- Each entry's words follow its state (section 3): "RPE missing", "RPE missed", or the value.
- An athlete whose values the read did not return: today's state word ("RPE entered").
- Duration: "60 min". No duration: the RPE alone.
- **"Changed HH:MM"** (the label of `frontend/central-calendar-questions.js:322-326`):
  - **Source:** the questions read's `lastChangedAt` for that athlete only.
  - **When the questions read is absent** (questions off, or not this manager's): no mark and no error.
  - **Known limit:** that read takes her latest change across all occurrences of the schedule (`:84`). On a recurring
    request it can name another day's change. Recorded, not fixed here.
- Every value has words; nothing relies on colour alone.

### 4.2 The click

- **The target stays as today:** the athlete's Weekly plan on the event's day
  (`central-calendar-open-athlete`, `frontend/central-calendar-actions.js:2127-2135` →
  `openWeeklyPlanForAthleteOnDate`, `frontend/app.js:2856-2860`). `openWeeklyPlanOnDate` pushes one app-history step
  from the calendar (`app.js:2869`), so Back (K4-0) returns to the calendar on that day with the panel open.
- **What becomes clearer:** the row shows its action as words and a glyph, "Weekly plan ›", at the row's end, beside
  the values. Today it is a whole-row button whose purpose shows only in its `aria-label`.
- The `aria-label` keeps its sentence and adds the values: "Ana Example, RPE 7, 60 minutes, open the weekly plan on
  Thursday 19 November".
- **An athlete outside the workspace's roster** stays a static row ("Not in this workspace's roster",
  `central-calendar-view.js:846-851`); she has no click and no "Weekly plan ›".

### 4.3 Phones (360 / 375 / 390 px)

- Each row is one button, at least 44 px high (`.cc-athlete`, `frontend/styles.css:21582-21590`).
- Below 480 px the row wraps:
  - first line: the name and "Weekly plan ›";
  - second line: the values and "Changed HH:MM";
  - long names and session names wrap (`overflow-wrap: anywhere`).
- No horizontal page scroll at any of the three widths.
- The summary line wraps at "·".
- No new input, so no 16 px rule applies.

## 5. Tests and mutations

**Backend** (the §1.3 read, Q1; the existing weekly suite or a new `backend/tests/training-load-weekly-*.test.mjs`).
`/weekly` is non-GPEXE Training Load, so the matching shared-kind files are also run directly with `node --test`, on
the head and on `main`, as the manager's rule asks.
- **B1:** a live planned row carries `logicalSessionId` and `sessionOrder`. Two sessions in one slot carry different
  ids and orders. An orphaned row carries its feedback row's `logicalSessionId` and `sessionOrder: null`.
- **B2:** the scope is unchanged. The rows are byte-identical apart from the two fields, for a team coach, a club admin
  and an athlete. An athlete of another team is still absent.
- **P3** (the claim of §1.2), on the same suite:
  - **P3a:** the manager of a team event and the manager of a club event each get every **current** member among the
    event's athletes.
  - **P3b:** an athlete whose membership ended after the event's day is on the card and absent from `/weekly`.
  - **P3c:** a club admin in the club workspace, for a team-only athlete of a club event: present or absent, whichever
    the code does. The result decides the wording of §1.2's "not verified" sentence.
- **Mutations:** drop either field; swap the two sessions' ids.

**Frontend** (`frontend/tests/central-calendar-event-panel.actions.test.mjs`, the real handlers with a fake fetch):
- **P1:** the reads.
  - A manager's panel issues ONE weekly read for the panel's day (its Monday, the card's athlete ids). A reader's panel
    issues none.
  - **P1b:** close the panel, change the fake weekly answer, reopen. A second read is made and the new value shows.
- **P2:** matching.
  - Values match by `logicalSessionId` + athlete, and by `scheduleId` + day + athlete.
  - Two sessions in one slot get their own values.
  - Another day's row of the same schedule is not used.
  - **P2b:** with `scheduleFold.external = "separate"`, a submitted row of that schedule shows no value and is not
    averaged.
- **P4:** the summary.
  - It counts targeted athletes once; `targeted: false` is left out; `missed` is in the denominator.
  - "Answered 0/15" has no average.
  - Rounding: 6.75 → "6.8", 7 → "7.0", 6.85 → "6.9".
  - Nobody counted (every state `null`, `expects` `["rpe"]`): no line.
  - **P4b:** a rated row whose RPE is now off reads "Not asked (RPE 6)" and is not averaged.
  - **P4c:** an athlete with entries "submitted 8" and "missing" is not answered, and 8 is in the average.
  - **P4d** (the P3b case): a counted, answered athlete with no value read shows "RPE entered". The line reads
    "… of N answers", or has no average when no value was read.
- **P5:** a changed answer shows the current value and "Changed HH:MM" from `lastChangedAt`. **P5b:** with the
  questions read answering 404, the value shows with no mark and no error.
- **P6:** a late weekly answer for a panel that closed or moved is dropped. A failed weekly read keeps today's states
  and says "Answers could not be loaded." with *Try again*, never a wrong number.
- **P7:** the click.
  - The row's button opens `openWeeklyPlanForAthleteOnDate(rosterId, day)`.
  - "Weekly plan ›" is present for a roster athlete, absent for a static one.
  - The `aria-label` carries the values.
  - Excluded athletes come after the others, marked "No longer in this event".
- **P8:** the athlete's view is untouched: the athlete workspace's calendar answer and K4a's views are byte-identical
  (an existing suite).

**Mutations** (each must fail a named test):
- the reader also reading values (P1);
- caching the values (P1b);
- matching by slot instead of `logicalSessionId` (P2);
- using a `separate` schedule's rows (P2b);
- counting `targeted: false` (P4);
- counting entries instead of athletes (P4);
- `Math.floor` for the rounding (P4);
- averaging only answered athletes (P4c);
- a not-asked value averaged (P4b);
- keeping a late answer (P6).

**e2e** (`e2e/tests/central-calendar-event-panel.test.mjs`, the real server):
- a team event with three athletes, two answers and one changed;
- the manager's panel at 1280 / 390 / 375 / 360 shows the values and the summary, with no horizontal overflow;
- the click opens the Weekly plan on the day, and Back returns to the panel;
- a reader's panel shows states only.

## 6. Decisions (the stream manager, 2026-11-20: every recommendation below is decided as written)

| | Question | Decided |
|---|---|---|
| **Q1** | Two identifiers on the weekly read's planned rows (§1.3), or a new manager-only events read (★★)? | **The two fields.** No access change and no trigger 2, and the values are already readable by the same coaches. |
| **Q2** | The panel counts athletes ("Answered 12/15"), the card counts entries ("RPE 14/16"). Align the card? | **Keep the card for now; the panel says "Answered" (athletes).** Changing the card's count changes every card's badge and status (D14), which is its own decision. Record it as a follow-up. |
| **Q3** | Average of entries or of athletes (an athlete with two answers)? | **Entries:** it is the average of the numbers shown, so a coach can check it by eye. |
| **Q4** | Show the duration in the summary ("· 58 min average")? | **No** for this package: the owner named RPE. Durations are on each row. |
| **Q5** | sRPE (RPE × minutes) on the row? | **No:** Training Load's own screens carry it. The panel stays a glance. |
| **Q6** | A reader who also may read the athletes in Training Load: show values to them too? | **No, as asked:** a reader sees what they see today. The values stay a manager's panel feature (a UI rule, section 2). |
| **Q7** | Read the values on open, or only when the coach expands the list? | **On open, for a manager.** One read of one week for the card's athletes, on every open, not cached (corrected after review: the first wording said "cached for the panel's day", which contradicted section 2). |

## 7. Out of scope

- The athlete's view (K4a) and K4b's change flow.
- The card's own count and badges (Q2).
- "Changed" per occurrence (section 4.1's known limit).
- Training Load's screens, and any migration.
- Any change to who may read an event or its questions.

## 8. Review record

**`code-reviewer`** (whole document): READY WITH NON-BLOCKING NOTES. Every file:line claim was checked except four,
which are now corrected.
- **The five MEDIUM findings, all applied:**
  - the two membership rules (§1.2, P3);
  - the folded-only schedule match (§1.3, P2b);
  - one caching rule (§2, Q7, P1b);
  - each entry's asked and state source (§3, P4b);
  - the partly answered athlete (P4c).
- **The LOW / NIT findings, applied:**
  - no "Answered 0/0";
  - the "Changed" source and its limit;
  - the excluded rows' order;
  - `sessionOrder` on the orphaned rows;
  - the heading's count.
- **Not checked by it:**
  - the day cache's invalidation (no longer relied on);
  - the external card's day against `local_scheduled_date` (P2 pins it);
  - the CSS below 480 px (the build's `mobile-qa` and browser check).

**`security-reviewer`** (sections 1–2): no BLOCKER or HIGH; trigger 2 does not apply.
- **The MEDIUM, applied:** "every targeted athlete is in scope" was false for former members. §1.2, P3a–P3c and P4d now
  say so and test it.
- **The LOW findings, applied:**
  - the orphaned id is not on any card;
  - the platform materialisation's load;
  - the workspace-switch race;
  - the manager-only rule is a UI rule.
