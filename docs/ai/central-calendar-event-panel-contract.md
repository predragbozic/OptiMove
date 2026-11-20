# Central calendar — the event panel package: each athlete's RPE and duration, the summary, the athlete click

Status: **Proposed** (not reviewed, no GO). Item 5 of the K4 plan's order (`docs/ai/central-calendar-k4-plan.md`,
section 6). Documents only; written against `main` `148fcd55` (K3 merged). No migration.

The goal, in the plan's words: in the coach's event panel, each athlete's RPE and duration, a summary
("Answered 12/15 · average RPE 6.8"), and a clearer athlete click.

## 1. The data today (file:line, on `148fcd55`)

### 1.1 What the panel's reads carry per athlete

| Read | Who gets it | Per athlete | RPE value / duration |
|---|---|---|---|
| The event card, `GET /api/calendar` (range, then the panel's own day read with `include=athletes`: `frontend/central-calendar-data.js:465-504`) | every coach who reads the card | `athletes[].rpe` as a **state**: `submitted` / `missing` / `missed` / `not_asked` / `null` | **no** |
| — its sources | | linked planned sessions (`backend/src/calendarQuery.js:785-818`, `applyEventFold`; one state per athlete, merged by `mergeRpeState` `:180-184`); a folded RPE request of the event's schedule (`:1287-1301`, its states replace the athletes'); a linked athlete no longer targeted is listed with `targeted: false` (`:817`) | |
| — the card's count | | `card.rpe = { asked, submitted }` (`:806-810`): counts **entries** (one per linked session that asks, plus one per assignment of a folded request), not athletes | |
| `GET /api/calendar/events/:eventId`, **manager** (`backend/src/calendarEventService.js:619-623`, `viewOf` `:432-450`, `linkFacts` `:463-488`) | `eventWriteBasis` ≠ null | `sessionLinks[]` (plan, day, slot, `logicalSessionId`, `athleteId`, `athleteName`, `asksRpe`), `externalScheduleId` | **no** |
| `GET /api/calendar/events/:eventId`, **reader** (`reducedViewOf` `:496-531`) | reads the event through the calendar's scope | targets in the reader's scope (athlete names) | **no** |
| `GET /api/calendar/events/:eventId/questions`, manager only (`backend/src/calendarQuestionService.js:66-119`; 404 unless `eventWriteBasis`, `:80`) | the event's manager, questions on | per RPE question: `answered[]` with `changed` / `lastChangedAt` (v83, `:81-88`, `:112-114`), `later[]`, `notAnswered[]` | **no** (who answered, and when it last changed) |
| `GET /api/training-load/weekly?weekStart&athleteIds` (`backend/src/routes/trainingLoad.js:1078`) | a coach, for the athletes of the active workspace's scope (`coachWorkspaceScopeSqlForWorkspace`, `:1156`) | every session and RPE request of the week, `feedback: { rpe, durationMinutes, srpe, note, submittedAt }` (`formatFeedback` `:163-172`) | **yes** |
| — planned rows (`:1319-1380`) | | `planId`, date, `amPm`, `bta`, `sessionName`, `athleteId`; **no `logicalSessionId`, no session order** | |
| — RPE-request rows (`:1416-1451`) | | `scheduleId`, `externalAssignmentId`, date, `athleteId` | |

A changed answer (v83) is the same row: `training_load.change_external_rpe()` writes the history and updates
`session_feedback` in place (`migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql:362`, `:371`). Every
reader of the row sees the current value (ADR-004).

### 1.2 Is the value there for a manager?

**Yes, with one gap.** The calendar's own reads have states only. The values are in `GET /api/training-load/weekly`,
which a manager may already call for the athletes of their active workspace. An event's manager is a coach of the
event's owner (`eventWriteBasis`), and an event targets only athletes inside its owner. So every targeted athlete of an
event the manager manages is in that read's scope (test P3 pins this).

The gap is the planned rows. They carry no `logicalSessionId` and no session order, so a panel can match a linked
session only by plan, day, AM/PM and B/T/A. Two sessions in one slot (a Builder day with two Training sessions) cannot
be told apart. The RPE-request rows match exactly, by schedule, day and athlete.

### 1.3 The smallest read: two fields on rows the coach already reads (recommended)

Add `logicalSessionId` and `sessionOrder` to the planned rows of `GET /api/training-load/weekly`, the live ones
(`:1319-1380`) and the orphaned ones (`:1385-1411`, where `logicalSessionId` comes from the feedback row).

- **No new route, no new row, no access change.** The rows are the same, for the same caller, under the same scope
  predicate. Only two identifiers of a session the caller already sees are added; both are already in that caller's
  calendar card (`card.links.logicalSessionIds`).
- **Trigger 2: no.** No auth, role, `owner_scope` / `data_workspace`, cross-workspace or info-hiding contract changes.
  Reviewers: `code-reviewer` alone for the backend part (the orchestration matrix's "ordinary backend query").
- The panel then matches a linked session by `logicalSessionId` + `athleteId`, and an RPE request by `scheduleId` +
  date + `athleteId`: exact, no guessing.

**Rejected:**
- **Frontend only, matching by slot:** ambiguous for two sessions in one slot; a wrong number in front of a coach is
  worse than none.
- **A new manager-only read on the events router** (`GET /api/calendar/events/:eventId/answers`): exact and narrow,
  but it is a new route gated by the event's manage right, with its own 404 for everyone else. That is an info-hiding
  contract, so **trigger 2 applies** (★★, the external review). Nothing here needs it, because the values are already
  readable by the same coaches.

**Note on the weekly read:** it materialises the active workspace's due RPE occurrences before reading
(`ensureCurrentExternalOccurrencesForCoach`, `:1171`). That write happens today whenever Training Load opens; the panel
adds no new kind of write, but it adds that call when a manager opens an event's panel. Recorded, not a blocker.

## 2. Who sees what

| Viewer | Sees |
|---|---|
| **The event's manager** (`item.canManage === true`) | per athlete the value and duration of each asked answer, "Changed HH:MM" for a changed RPE-request answer, and the summary |
| **A reader** (a coach who reads the event but may not manage it) | exactly today's panel: the states ("RPE entered" / "RPE missing" / "RPE missed" / "Not asked", `frontend/central-calendar-view.js:394-406`), no summary, no values. The panel does **not** call the weekly read for a reader. |
| **The athlete** | untouched. The athlete's Calendar (K4a) and her own event card are not changed. |

The manager's values are read once per open panel, for the panel's day only (`weekStart` = that day's Monday,
`athleteIds` = the card's athletes), and dropped when the panel closes or moves, as the panel's day read is
(`central-calendar-data.js:482`, the generation check).

## 3. The summary

`Answered 12/15 · average RPE 6.8`, under the panel's Athletes heading, for a manager only, and only when the event
asks for RPE (`expects` includes `rpe`, or some athlete has a state other than `not_asked`).

- **Who counts:** the athletes the card lists with `targeted !== false` whose state is not `not_asked` / `null`.
  - An athlete counts once, whatever the number of her asked entries.
  - She is **answered** when every asked entry of hers is submitted (her merged state is `submitted`).
  - **Excluded athletes** (`targeted: false`, linked but no longer targets) are left out of both numbers. Their rows
    still show, as today, after the others and with a new mark, "No longer in this event". Today's list shows them
    with no mark (`renderPanelAthletesHtml` does not read `targeted`).
  - `missed` (the window closed) counts in the denominator, not as answered.
- **The average:** the mean of the RPE values of the counted athletes' submitted entries.
  - One decimal, rounded half up on the value × 10 (`Math.round(sum * 10 / n) / 10`, then shown with one decimal:
    7 → "7.0").
  - Every submitted entry counts once (an athlete with Training and After both answered adds two values).
  - Only values the panel's read returned are averaged. If a counted athlete's value could not be read (outside the
    weekly read's scope, which P3 says cannot happen), she still counts as answered, and the average is over the
    values that were read. The summary then says "average RPE 6.8 of 11 answers".
- **No answers:** "Answered 0/15", with no average.
- **Nobody asked:** no summary line.
- **A changed answer (v83):** the current value counts (the row is updated in place). The athlete's row says
  "Changed 21:40", the label of `frontend/central-calendar-questions.js:322-326`, taken from the questions read's
  `lastChangedAt` for that athlete.
- **The card's own count stays as it is** ("RPE 14/16" counts entries, `calendarQuery.js:806-810`). The panel's summary
  counts athletes, and its label says so: "Answered" means athletes. See Q2.

## 4. The athlete row and the athlete click

### 4.1 The row (manager)

`Ana Example — RPE 7 · 60 min · Changed 21:40`, then the teams.

- One answer: "RPE 7 · 60 min".
- Several asked entries: one short group per entry, in slot order, each named by its session or "RPE request" (e.g.
  "Training RPE 7 · 60 min · After RPE 4 · 15 min").
- Missing or missed entries keep today's words ("RPE missing", "RPE missed").
- A value the read could not return: "RPE entered" (today's state).
- Duration: "60 min". No duration: the RPE alone.
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

**Backend** (only if the recommended §1.3 read is built; `backend/tests/training-load-weekly-*.test.mjs` or the
existing weekly suite, on a disposable database):
- **B1:** a planned row carries `logicalSessionId` and `sessionOrder`. Two sessions in one slot carry different ids
  and orders. An orphaned row carries its feedback row's `logicalSessionId`.
- **B2:** the scope is unchanged. Byte-identical rows apart from the two fields for a team coach, a club admin and an
  athlete. An athlete of another team is still absent.
- **Mutations:** drop either field; swap the two sessions' ids.

**Frontend** (`frontend/tests/central-calendar-event-panel.actions.test.mjs`, the real handlers with a fake fetch):
- **P1:** a manager's panel issues ONE weekly read for the panel's day (its Monday, the card's athlete ids). A reader's
  panel issues none.
- **P2:** values match by `logicalSessionId` + athlete and by `scheduleId` + day + athlete. Two sessions in one slot
  get their own values. Another day's row of the same schedule is not used.
- **P3** (a backend test, the claim of §1.2): for a team coach and a club admin who manage an event, every targeted
  athlete of the event is in the weekly read's answer.
- **P4:** the summary.
  - It counts targeted athletes once.
  - `targeted: false` is left out.
  - `missed` is in the denominator.
  - "Answered 0/15" has no average.
  - Rounding: 6.75 → "6.8", 7 → "7.0", 6.85 → "6.9".
  - With nobody asked, there is no line.
- **P5:** a changed answer shows the current value and "Changed HH:MM" from `lastChangedAt`.
- **P6:** a late weekly answer for a panel that closed or moved is dropped. A failed weekly read keeps today's states
  and says "Answers could not be loaded." with *Try again*, never a wrong number.
- **P7:** the click.
  - The row's button opens `openWeeklyPlanForAthleteOnDate(rosterId, day)`.
  - "Weekly plan ›" is present for a roster athlete, absent for a static one.
  - The `aria-label` carries the values.
- **P8:** the athlete's view is untouched: the athlete workspace's calendar answer and K4a's views are byte-identical
  (an existing suite).

Mutations (each must fail a named test):
- the reader also reading values (P1);
- matching by slot instead of `logicalSessionId` (P2);
- counting `targeted: false` (P4);
- counting entries instead of athletes (P4);
- `Math.floor` for the rounding (P4);
- keeping a late answer (P6).

**e2e** (`e2e/tests/central-calendar-event-panel.test.mjs`, the real server):
- a team event with three athletes, two answers and one changed;
- the manager's panel at 1280 / 390 / 375 / 360 shows the values and the summary, with no horizontal overflow;
- the click opens the Weekly plan on the day, and Back returns to the panel;
- a reader's panel shows states only.

## 6. Open questions (each with a recommendation)

| | Question | Recommendation |
|---|---|---|
| **Q1** | Two identifiers on the weekly read's planned rows (§1.3), or a new manager-only events read (★★)? | **The two fields.** No access change and no trigger 2, and the values are already readable by the same coaches. |
| **Q2** | The panel counts athletes ("Answered 12/15"), the card counts entries ("RPE 14/16"). Align the card? | **Keep the card for now; the panel says "Answered" (athletes).** Changing the card's count changes every card's badge and status (D14), which is its own decision. Record it as a follow-up. |
| **Q3** | Average of entries or of athletes (an athlete with two answers)? | **Entries:** it is the average of the numbers shown, so a coach can check it by eye. |
| **Q4** | Show the duration in the summary ("· 58 min average")? | **No** for this package: the owner named RPE. Durations are on each row. |
| **Q5** | sRPE (RPE × minutes) on the row? | **No:** Training Load's own screens carry it. The panel stays a glance. |
| **Q6** | A reader who also may read the athletes in Training Load: show values to them too? | **No, as asked:** a reader sees what they see today. The values stay a manager's panel feature. |
| **Q7** | Read the values on open, or only when the coach expands the list? | **On open, for a manager:** one read of one week for the card's athletes, cached for the panel's day like the day read. |

## 7. Out of scope

- The athlete's view (K4a) and K4b's change flow.
- The card's own count and badges (Q2).
- Training Load's screens, and any migration.
- Any change to who may read an event or its questions.
