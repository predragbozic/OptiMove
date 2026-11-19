# Central calendar — K4a contract: the athlete's Calendar

Status: **Proposed** (2026-11-19, written against `main` `c605c44`). Documents only: no code, no migration. It goes to
the OptiMove manager for GO. The backend part is ★ (external-review trigger 2, info-hiding).

Based on: the K4 plan section 2 (`docs/ai/central-calendar-k4-plan.md`, on `main`); the owner-approved mockup 04
(`docs/design/calendar-k4/04-k4a-athlete-calendar.html`, branch `claude/central-calendar-k4-design`, D7 and D8 accepted
as recommended); the owner's O1–O3 and O12–O15; the linked session's time of PR #649
(`backend/src/linkedSessionTimes.js`, K3 plan section 7).

## 0. What exists (file:line on `c605c44`)

- **The athlete's calendar read.** `GET /api/calendar` in the athlete workspace (`backend/src/routes/calendar.js:69-95`;
  filters are ignored for an athlete, `:93`) returns, for the athlete only:
  - the events the athlete is a target of, as the reduced card of D21 / D27 (`publicCard`, `calendarQuery.js:1319-1334`).
    Its allowlist is pinned key by key by `central-calendar-k2a-events.test.mjs:881-884`: `key, kind, date, title,
    eventKind, eventTypeLabel, eventTypeIconKey, eventTypeColorKey, span, startTime, endTime, timezone, location,
    place, status, cancelled, teamIds, links` with `links = { eventId }`;
  - the athlete's own planned groups (`readPlannedRows`, `calendarQuery.js:192-221`, scoped by
    `calendarAthleteScopeSql` to the athlete's own plans), their own RPE / test assignments and activities.
- **The athlete folds nothing.** `coachView = ctx.type !== "athlete"` (`calendarQuery.js:882`) gates the link reads
  (`foldsLinks`, `:888`); so an event and its linked training are **two cards** for an athlete today.
- **The athlete's questions** (K2b-2a-3) come from `GET /api/calendar/questions/mine`
  (`routes/calendarQuestions.js:13-20`): per open question `questionId, kind, eventId, eventTitle, eventDay, eventStart`
  and its form (`calendarQuestionService.js:134-154`).
- **The athlete's RPE of a planned session** is the Training Load form, opened by `plan_sessions.id`
  (`training-load-actions.js:713-716`, `openRpeFormForSessionId`, `:2770-2785`; `submitRpe`,
  `training-load-data.js:418-423`).
- **The athlete shell** (`frontend/athlete.html`): the rail tab `data-athlete-tab="calendar"` is the **Weekly plan**
  (`:36`, title "Weekly plan"). The new tab therefore needs its own key (`athlete-calendar`), not `calendar`.
- **Athlete Home's *Upcoming events*** (K2b-1e): one read of `GET /api/calendar?kinds=event` for 14 days
  (`athlete-home-events-data.js:43`).
- **Opening the Weekly plan on a date:** `openWeeklyPlanOnDate(date)` (`app.js:2738-2759`) pushes one history step,
  loads the weeks and sets `pendingScrollDate`; the render scrolls to the date (`app.js:3761-3765`). There is no scroll
  to a session today.

## 1. The backend fold (★, trigger 2)

**Change:** in the athlete workspace, a **planned** event the athlete is shown folds **the athlete's own** linked
planned sessions of that day into its card, as the coach's card does. Nothing else of the coach's fold.

### 1.1 What is read

- The link read (`readEventSessionLinks`, `calendarQuery.js:552-571`) runs for the athlete too, **restricted to the
  athlete's own plans**: `l.plan_id` in the plans whose `athlete_id` is the athlete's (`ctx.athleteId`). A teammate's
  link is never read into the athlete's request (defence in depth; the planned rows are already the athlete's only).
- The activity links are **not** read for the athlete (out of scope; the athlete's own activities stay their own
  cards as today).
- `foldsInto` keeps its rules unchanged: a planned event, shown on that day (`eventDayKeys`, so only an event the
  athlete is a target of that day), `kinds` containing `event`. A cancelled event folds nothing (K2a manager decision
  9.12): its sessions are planned cards again.

### 1.2 What the athlete's event card carries

The D21 / D27 allowlist **plus one key, `sessions`**, present only when at least one own session folded (an event
without one is byte-for-byte today's card):

```json
"sessions": [
  { "title": "Main session", "slot": { "amPm": "AM", "bta": "T", "order": 1 },
    "time": "10:30", "timeFromEvent": false,
    "sessionId": "<plan_sessions.id>", "logicalSessionId": "<uuid>", "rpe": "missing" }
]
```

- **Only the athlete's own sessions**, ordered by AM/PM, B/T/A, order (the Weekly plan's order).
- `title`: the session's own name (as the athlete's planned card's title); `slot`: as the planned card.
- `time` / `timeFromEvent` (O12 / O14, #649's rule): the session's own `session_time` when set
  (`timeFromEvent: false`), else the event's start on its first day (`timeFromEvent: true`), else `null`.
- `sessionId` and `logicalSessionId`: the athlete's **own** session's ids, which the athlete already reads through
  the planned card (`links.logicalSessionIds`) and the Weekly plan. They open *Open training* and *Rate RPE*.
- `rpe`: the athlete's own state for that session (`missing` / `submitted` / `not_asked`), from the same row fields
  as the planned card (`rpe_expected`, `rpe_submitted`).
- **Never:** another athlete, a link id (`calendar.event_session_links.id`), a plan id, a count (`rpe.asked`,
  `attendance`, `athleteCount`), `links.planIds` / `logicalSessionIds` on the event card, an orphaned or renamed count,
  the coach's notes or details. `links` stays `{ eventId }`.
- The folded session **does not** also appear as a planned card (one card, O3).

### 1.3 Tests (disposable database, the real route; `security-reviewer` and the external review)

1. The allowlist **key by key**: the event card without a fold is exactly today's keys; with a fold, today's keys plus
   `sessions`; each session exactly `title, slot, time, timeFromEvent, sessionId, logicalSessionId, rpe`; `links`
   exactly `{ eventId }`.
2. Two athletes of one team, both with a linked session in one event: each sees **only their own** session in the
   card; the response text contains no teammate's ids or name.
3. A session linked to an event the athlete is **not** a target of (a removed athlete target, or an event of another
   team) stays its own planned card; the event is not in the athlete's answer.
4. A cancelled event: no `sessions`; the sessions are planned cards again.
5. Time: own time wins; no own time → the event's start, `timeFromEvent: true`; a multi-day event's middle day → `null`.
6. The link read for the athlete names only the athlete's own plans (a statement recorder, or the read's parameters).
7. The coach's card is unchanged (the existing K2a-1b and K2c suites green).
8. `kinds=event` alone (Home's *Upcoming events*): the fold happens as well, and the Home list ignores `sessions`
   (unchanged screen) — or the fold is skipped when `planned` is not asked (Q2).

**No migration.** Reviews: `code-reviewer`, `security-reviewer`; external review (trigger 2) before merge.

## 2. The athlete's Calendar tab (frontend)

### 2.1 Where

- A new rail tab **Calendar**, key `athlete-calendar`, first in the athlete rail (D8, K4a-1). *Weekly plan* stays
  beside it (K4a-1).
- Its own module set: `athlete-calendar-{view,actions,data}.js` (the frontend module pattern); one read per shown week:
  `GET /api/calendar?from=<Mon>&to=<Sun>&today=<today>&include=athletes` (no `kinds`: events, planned, assignments)
  plus `GET /api/calendar/questions/mine` (the open questions); a generation counter drops a slower, older answer.

### 2.2 The screen (mockup 04, step 1)

- **Head:** "12 – 18 Oct" with ‹ › arrows and **Today**.
- **Phone:** a strip of the 7 days (weekday and date), today highlighted, a dot on a day that has something; tapping a
  day scrolls the list to it.
- **List by day:** "Monday 12.10 · today"; a day with nothing is left out (no empty card); a week with nothing: "Nothing
  planned this week." with **Today** when it is another week.
- **Cards:**
  - **An event** (with or without folded sessions): the colour stripe, the type's icon, the time ("10:00–11:30") and
    the type word; the title; the place with *Open in maps* (as Home's list); **the sessions inside** as a short grey
    list (D7): "Before · Mobility & activation · 10:00", "Training · Main session · 10:30" — names and times only, no
    exercises (`time` with "from the event" never written: the time alone); then the buttons.
  - **My training** (a planned card of the athlete's own plan, not in an event): "AM · My training", the session's
    name, **Open training**.
  - **Cancelled:** the existing ✕ *Cancelled* badge, the title struck through, no place, no sessions, no buttons.
  - **An assignment card** (an external RPE schedule or a test not folded into an event): as Home shows it today, with
    its own button.
- **Buttons:** one primary per card. **Rate RPE** (primary) when an open RPE question of the event exists (from
  `questions/mine`, by `eventId`), or when a folded session's `rpe` is `missing` and its day is today or past; then
  **Open training** (secondary). Otherwise **Open training** is the primary. A wellness question: **Wellness**.

### 2.3 The actions

- **Open training:** `openWeeklyPlanOnDate(date)` plus a new `pendingScrollSessionId` (the folded or planned card's
  `sessionId`); the Weekly plan scrolls to that session's block when its render has it, else to the day (the date
  scroll of today). The Weekly plan shows **Back to calendar** at its top, beside "Monday 12.10 · Team training", only
  when it was opened from the Calendar.
- **Rate RPE:** an event question opens its form exactly as Home's question list does (`openCalendarQuestion`); a
  planned session's RPE opens the Training Load form for that `sessionId` (a new small entry like the notification's
  `openTrainingLoadAssignment`, Q4). After a confirmed answer the calendar is read again.
- **Open in maps:** as Home.

### 2.4 Back (O1, K4-0)

- Entering the Calendar from the rail is a tab change (K4-0's stack). **Open training** pushes one step whose state
  holds the calendar's context: the week, the selected day and the list's scroll position.
- The phone's or browser's Back, and **Back to calendar**, return to that week, day and scroll — restored from the
  step, never from defaults.
- From the Weekly plan opened another way (the rail), there is no *Back to calendar*.
- K4a's code waits for K4-0's merge and uses its stack; it adds no history mechanism of its own.

### 2.5 Home's *See all*

- *Upcoming events* on Athlete Home gets **See all** under its list (and in its empty state: "No events in the next 14
  days." · *See all*), which opens the Calendar tab on the current week.

### 2.6 Phones (360 / 375 / 390 px)

- The day strip is sticky under the head; 7 targets of at least 44 px; no horizontal scroll.
- Each card's buttons go full width and stack (primary first).
- The session list inside a card wraps; long titles wrap, never clip.
- Checked in Chromium at 1280, 390, 375 and 360 px through the e2e world (the athlete demo account).

### 2.7 English copy

"Calendar" · "Today" · "Monday 12.10 · today" · "Nothing planned this week." · "My training" · "Open training" ·
"Rate RPE" · "Wellness" · "Open in maps" · "Cancelled" · "Back to calendar" · "See all" · "Before" / "Training" /
"After" · "The calendar could not be read." with *Try again* · "Your answer was saved." (after a confirmed RPE answer).

## 3. What K4b adds later (the card leaves room)

- K4b (changing an RPE answer while the question is open) adds one line on the card, under the sessions: **"Your RPE: 7
  · Change"** with "You can change it until 22:00", and the same on Home.
- K4a keeps that place: the card's last block is a "your answer" row that K4a leaves empty; after a confirmed answer
  K4a shows only "RPE given" with a check glyph (no value, no Change) until K4b.

## 4. Open questions (each with a recommendation)

- **Q1 — Folded session ids.** Carry `sessionId` and `logicalSessionId` of the athlete's own session (recommended:
  they are the athlete's own, already readable through the planned card and the Weekly plan, and *Open training* /
  *Rate RPE* need them), or carry none and let the frontend find the session in the Weekly plan by slot and name.
- **Q2 — Fold with `kinds=event` alone.** Fold only when `planned` is also asked (recommended: Home's *Upcoming events*
  stays byte-for-byte as today, and its read stays one statement lighter), or always.
- **Q3 — Rate RPE on a past day.** Offer *Rate RPE* for a folded session with `rpe: "missing"` on today and the past
  days of the week only (recommended: the Training Load form refuses a future session anyway), or also in the future,
  greyed.
- **Q4 — Planned-session RPE entry.** A small deep link into the existing Training Load form by `sessionId`
  (recommended; the form, its checks and its sentences stay one), or a new form on the calendar.
- **Q5 — A day strip on a computer.** Phones only (recommended, mockup 04), or on every width.
- **Q6 — Weekly plan after the pilot.** K4a-1 keeps *Weekly plan* as a tab until the pilot ends; nothing to decide now.

## 5. Order and reviews

1. **K4a-B** (the fold, section 1): `code-reviewer`, `security-reviewer`, then the external review (trigger 2);
   disposable-database tests of 1.3.
2. **K4a-F** (the screen, section 2), after K4-0 and K4a-B: `code-reviewer`, `ux-design-reviewer`, `mobile-qa`; the
   Frontend PR gate; the browser checks of 2.6.
