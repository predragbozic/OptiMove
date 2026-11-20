# Central calendar — K5-1 and K5-2: UI contract

Status: **Decided** (2026-11-20).
- The stream manager decided Q1–Q10 as recommended; his notes are in section 5.
- Q11 was added after the code and security reviews. It was decided by the OptiMove manager: **widen**.
  `holdsImport` also goes on planned and RPE cards.

Documents only: no code, no route, no migration.
Written against `main` `ec467638`. Sources: `docs/ai/central-calendar-k5-plan.md` (H1–H5, K5-1, K5-2, section 3),
the approved mockups `docs/design/calendar-k5/` (README, E1–E12), and the managers' conditions for the one backend
field:
- `holdsImport` is **one boolean** on the event, planned and RPE cards of a coach's or a reader's answer
  (`publicCard`, `backend/src/calendarQuery.js`), never in the athlete's answer;
- it is proven by a key-by-key allowlist test of each of those cards, a test that the athlete's answer carries it on
  no card, a test that a viewer without the right to the activity never gets `true`, and the whole disposable
  backend run;
- the backend PR's tier is ★, with the *Nezavisni revizor*.

Every file:line below was read at `ec467638`. Where something was not verified, the text says so.

## 0. Summary

- **K5-1** gives each panel one way to where its work is done. Three of the four targets have a reachable entry
  point today, but none of the three records the calendar's place for Back. Each gets a small opener in `app.js`
  that calls `pushAppHistory()` first, the pattern of `openTrainingLoadFromCalendar`. The fourth target, the activity
  in Training Load, already does.
- **The Builder target is not frontend-only.** Opening a published plan in the Builder creates or reuses the coach's
  edit draft on the server, and a planned group card holds one plan per athlete. **Q1** recommends leaving it out of
  K5-1.
- **K5-2** covers several pieces:
  - the `gps` icon for an imported activity;
  - the H4 marks on an event card, and the GPS mark wherever an import lives (an event, a planned training or an RPE
    request). These need one new boolean, `holdsImport`, on those three card kinds;
  - the H5 day chips;
  - *Show only*, with **GPS imports** as a client-side kind.

  Everything except `holdsImport` is frontend.

## 1. K5-1 — *Go there* from each panel

### 1.1 What the panel offers today (`frontend/central-calendar-view.js`, `renderPanelHtml` :1083)

- **Any card with `links.activityIds`** (an activity, or a planned / RPE / event card with folded activities):
  - one id gives *Open in Training Load*;
  - several give *Open the day in Training Load*;
  - both are `central-calendar-open-training-load`, view :1099–1103.
- **The athletes list** (`renderPanelAthletesHtml` :823). Each athlete row opens that athlete's Weekly plan on the
  day (`openWeeklyPlanForAthleteOnDate`, `central-calendar-actions.js:2101`).
- **An event:** Edit, Cancel, Enter details, links and questions, for a manager.
- **Test and RPE cards** have no way into their module.

### 1.2 The targets

Every row's button sits under a thin line, full width and primary, with a one-line hint (mockup 01). E1 adds a
trailing arrow (Q5).

| Card | Button | Existing entry point (file:line) | Inputs on the card | What it opens | Back today | Step in K5-1 |
|---|---|---|---|---|---|---|
| Activity | *Open in Training Load →* (exists) | `openTrainingLoadFromCalendar({ activityId, date })`, `app.js:2518`; dispatches `training-load-results-view-activity-in-calendar` (`training-load-actions.js:2491`) | `links.activityIds[0]`, `date` | Training Load's calendar on that week and day with the activity open | **Yes**, `pushAppHistory()` at `app.js:2524` | Keep it; only the wording and placement change (mockup 01). |
| Activity with `attendance.needsState > 0` | *Roster · N need a state →* (second button) | The same opener. The Roster tab already opens by itself when someone needs a state and the coach picked no tab (`maybeOpenRoster`, `activity-roster-actions.js:43`). | as above | The activity on its Roster tab | Yes | A caller cannot ask for the Roster tab. Add an optional `tab: "roster"` to `openTrainingLoadFromCalendar`; after the dispatch it sets `activityDetailTab = "roster"` and `roster.userPickedTab = true`. This is the same pair of assignments the GPEXE review hand-off already makes (`training-load-actions.js:2485`). |
| RPE schedule (`kind: "external"`) | *Open in Training Load →* | `openExternalScheduleDetail(scheduleId, render)`, `training-load-actions.js:2631` (not exported), reached by action `training-load-open-external-schedule` (:2388) | `links.externalScheduleId` | Training Load › Schedule with that schedule's detail (`renderExternalScheduleDetailHtml`) | **No** | New `openTrainingLoadScheduleFromCalendar({ scheduleId, date })` in `app.js`, built like `openTrainingLoadFromCalendar`: `confirmLeaveTrainingLoad`, `pushAppHistory()`, the tab, `setTrainingLoadSection("schedule")`, the Schedule week to `weekMondayIso(date)`, then dispatch `{ action: "training-load-open-external-schedule", scheduleId }` through `handleTrainingLoadAction`. The detail is per schedule, not per day or occurrence; the hint names the schedule. |
| Tests schedule (`kind: "test"`) | *Open in Tests →* | `openWeeklyTodaySession(scheduleId, date, render)`, `tests-actions.js:636` (not exported), action `tests-weekly-open-today-session`. Tests' week is `state.tests.weekly.today.weekStart/selectedDate` (`loadTestsWeekly`, `tests-data.js:209`). The app's openers `openTestsToday` / `openTestsResults` (`app.js:2893`, `:2907`) open only the section. | `links.testScheduleId`, `date` | Tests › Today on that week and day, with that schedule's day group (athletes, statuses, reminder) | **No**: neither opener calls `pushAppHistory()` | New `openTestsDayFromCalendar({ scheduleId, date })` in `app.js`: `pushAppHistory()`, `activeTab = "tests"`, `section = "today"`, `weekly.today.weekStart = weekMondayIso(date)` and `selectedDate = date`, `await loadTests(...)`, then dispatch the existing action `tests-weekly-open-today-session`. No occurrence id is needed. A coach does not type results here: in this module results come from the athletes' own forms, so the hint reads "Opens Tests on Tuesday, to see who has answered", **not** the plan's "to enter results" (Q4). |
| Planned group (Builder training) | *Open in Builder →* | `builder-edit-plan` (`builder-actions.js:220`) → `POST /api/builder/plans/:planId/edit` (`backend/src/routes/builder.js:980`) | `links.planIds` (one per athlete's plan), `date`, `slot` | The whole plan in the Builder. It selects no week, day or session. | **No** | **Not in K5-1 (Q1).** Each click creates or reuses the coach's server-side edit draft of one athlete's plan. A group card holds many plans, and the card does not say whether a plan is a weekly plan or a specific program (`planType` is not in `publicCard`). The panel keeps today's athlete rows (each opens that athlete's Weekly plan on the day). |
| Event | Its folded items' buttons in the plan's order: Builder (left out, Q1), RPE, Tests, then GPS / activities | The rows above, with the ids from the event card | Manager: `links.externalScheduleId`, `links.testScheduleId`, `links.activityIds`. Reader: `links.activityIds` only (`publicCard` :1438) | — | — | A reader of an event sees only the activity buttons: the server sends no schedule id to a reader, by design. One button per item (E2), under "In this event". |

**Back (K4-0).**
- Every new opener calls `pushAppHistory()` before it changes the tab.
- The entry it pushes (`appHistoryEntryOf`, `app-history.js:12`) holds the calendar's view, anchor, selected day and
  open panel's key.
- Back runs `restoreCentralCalendarPlace` (`app.js` `restoreAppPlace`), so it lands on the same day with the same
  panel open when its item is still there, otherwise with the panel closed and the "no longer on this day" note
  (K4-0, already tested).

**A guard that says "stay"** (Training Load's leave guard, the roster's `rosterMayBeLeft`) leaves the calendar as it
was and pushes nothing. That is the order of `openTrainingLoadFromCalendar` today: the guards come first, then the
push.

## 2. K5-2 — GPS visible, H4 marks, H5 chips, *Show only*

### 2.1 Imported activity: one helper, the `gps` icon

- **Rule:** an activity is imported when its `origin` is `api_import` or `source_import`.
  - The server's set is `IMPORTED_ORIGINS` (`calendarQuery.js:90`).
  - The view already tests the same two words inline (`central-calendar-view.js:244`, "Imported activity").
- **One helper replaces the inline test:** `centralCalendarItemImported(item)`, exported from
  `central-calendar-view.js`. It answers `true` for:
  - an activity whose origin is in that set;
  - an event, planned or RPE card with `holdsImport === true`.
- **Not `measuredSource`.** The plan names it, but `publicCard` does not output it (it is internal, :1214). An
  activity card's `expects` holds `device_data` exactly when it is imported (:1201), but `origin` is the plainer
  reading.
- **Icon:** `centralCalendarItemIconKey(item)` returns `gps` for an imported activity, and `activity` for any other
  activity, as today. The icon flows to the card, the month's mini card, the chip and the panel.

### 2.2 `holdsImport` (the one backend field)

- **Definition.** On an event, planned or RPE (`external`) card, `holdsImport` is `true` when any id in that card's
  own `links.activityIds` is an activity with an imported origin. Only rows of the viewer's scoped activity read
  count (`readActivityRows`, `calendarQuery.js:1165`).
- **How an id enters `links.activityIds`:**
  - **an event card,** three ways:
    - linked to the event directly, `fold.activities[]` (`:1196`), which already carries `imported`;
    - through a Builder session linked to the event, `fold.activityIds` (`:1179`), which keeps **only the id**;
    - through the event's referenced RPE schedule when its card folds under the event (`:1297`, copying the RPE
      card's ids);
  - **a planned card:** an activity whose session is one of the card's (`:1180`);
  - **an RPE card:** an activity whose assignment is one of the card's (`:1186`).
- **Recommended implementation.**
  - One set of the imported ids from that read (`IMPORTED_ORIGINS.has(row.origin)`).
  - Once every fold is done (after the event fold of `:1290–1310`, so an RPE card's ids are already copied),
    `card.holdsImport = card.links.activityIds.some((id) => importedIds.has(id))` for each event, planned and RPE
    card.
  - That counts every path, today's and any later one, without recording `imported` per path. It never uses an id
    the viewer's read did not return.
- **Not an import:** an event that only *waits* for device data (`expects` has `device_data`, nothing linked). It
  answers `false`, and its status line says what is missing, as today.
- **Output** (`publicCard`). The same boolean, `out.holdsImport = card.holdsImport === true`, always present:
  - on **every** event card of a coach or a reader (the event branch at `:1410`);
  - on **every** planned card and RPE card of a coach or a reader;
  - **never** on an activity or test card;
  - **never in the athlete's answer**, on no card at all.
- **Gate on the viewer, not on the card.**
  - The athlete's event card already returns early (`:1381`, `athleteView`).
  - But the athlete workspace's **planned and RPE cards go through the same generic branch** as a coach's (no
    `athleteView` on them).
  - So `publicCard` must be told the viewer, for example `publicCard(card, includeAthletes, { athleteViewer:
    ctx.type === "athlete" })` at the call (`:1349`). It emits `holdsImport` only when `athleteViewer` is false.
- **No conditional key.** On those three kinds the key must never be left out, even when its value is false. The
  k2b2 questions suite asserts that folding adds no key to an event card (`central-calendar-k2b2-questions.test.mjs:1921`).
- **What it reveals.** A reader already receives the folded activities' ids (`links.activityIds`, kept for a reader
  of an event at `:1438`; planned and RPE cards keep their whole `links`) and may open them. The boolean says only that one of them is an import, which the reader sees by
  opening it. It adds no difference between "missing" and "outside your scope" (ADR-006): such an activity never
  enters the read, and the key is always present. The implementer confirms that the activity route's read scope
  (`resolveActivityReadContext`, `routes/trainingActivity.js:225`) matches the calendar's, which the security review
  assumed but did not read line by line.
- **Tests (backend, disposable, the calendar fixture):**
  1. **Allowlists.** The manager's event card, the reader's event card, a planned card and an RPE card each have
     **exactly** today's keys plus `holdsImport`, key by key. That is exactly one new key, always present, a boolean.
     These are new full allowlists, not "contains", so any later key needs a deliberate change.
  2. **The athlete's answer has the key on no card.** Read the athlete workspace's answer with an event, a planned
     card and an RPE card that hold an import, and assert that no card of any kind has `holdsImport`. The athlete's
     event allowlists stay unchanged: `central-calendar-k2b-1d2.test.mjs:85` and
     `central-calendar-k2b-event-details.test.mjs:481` stay green and are not edited.
  3. **The value:**
     - `true` for an imported activity linked to the event directly;
     - `true` through a Builder session linked to the event;
     - `true` through the event's folded RPE schedule: an imported activity whose participant carries the
       schedule's `external_assignment_id`, with `scheduleFold.external === "folded"`;
     - `true` on a planned card holding an import through its session;
     - `true` on a lone RPE card holding an import through its assignment;
     - `false` for a coach-made activity;
     - `false` for `expects: ["device_data"]` with nothing linked;
     - `false` with no activity;
     - `false` for a cancelled event (no fold).
  4. **No right, never `true`.** A viewer with no right to the imported activity (another club's coach, or a team
     coach outside its scope) reads the same day. For that viewer, the event, planned or RPE card that holds the
     import answers `false`, or is not in the answer at all. The value comes only from what the scoped read returns.
  5. Activity and test cards have no `holdsImport` key.
  6. The **whole** `--project backend --kind disposable` run on the head against a clean `origin/main`, compared
     file by file.

  Each path gets a mutation: the direct link, the Builder session, the folded RPE schedule, the planned card's
  session, the RPE card's assignment, the viewer gate, and the key always being present.

### 2.3 H4 — what an event holds (marks on the card)

Each mark is a 14 px icon in the card's top line, after the type's icon and before the time. The order is RPE, GPS,
test (mockup 07). Each mark is only a mark: no number and no state.

| Mark | Icon (`icon-library.js`) | Shown when (fields of the event card) |
|---|---|---|
| RPE | `gauge`, amber | `scheduleFold.external === "folded"`, **or** `expects` has `rpe` **and** `scheduleFold.external !== "separate"` |
| GPS | `gps`, blue | `holdsImport === true` |
| Test | `clipboard`, violet | `scheduleFold.test === "folded"`, **or** `expects` has `test_result` **and** `scheduleFold.test !== "separate"` |

- **The `separate` clause.** It refines the plan's wording to match its own rule: "a schedule shown beside the event
  (`separate`) keeps its own chip and gives the event no icon". Such an event usually also lists `rpe` /
  `test_result` in `expects`.
- **The GPS mark wherever an import lives** (Q11, widened): a planned card and an RPE card with `holdsImport` carry the
  `gps` mark too, in the same place after their own icon. They get no RPE or test mark: their own icon already says
  what they are. On an RPE day chip (2.4) the mark sits after the chip's icon.
- **One helper:** `centralCalendarCardMarks(item)` returns, in this order and only the ones that apply:
  - for an event, `["rpe", "gps", "test"]` by the table above;
  - for a planned or RPE card, `["gps"]` when `holdsImport` is true;
  - `[]` for every other kind, a cancelled card (Q6) and anything without the fields. The athlete's answer has no
    `holdsImport`, `expects` or `scheduleFold` on her event card, so it yields `[]` without a special case, and the
    athlete never sees the central calendar (section 3).
- **Markup:** a `<span class="cc-card-marks" role="img" aria-label="Holds RPE, GPS data and a test">` with the icons
  `aria-hidden`. The same words are added to `cardAriaLabel`. The month's mini card shows the marks too, at 12 px, on
  wide and medium screens; on a phone the month cell stays a count, as today.
- **Phone:** the marks and the type's icon share one row; the title wraps below and is never cut (mockup 07's long
  title).

### 2.4 H5 — day chips (what is in no event)

**Which items become a chip.** Every card of kind `test`, `external` or `activity` in the answer the cards come from
(`centralCalendarShownData`). A folded item is not in that answer as its own card, so it never becomes a chip. A
schedule shown `separate` beside its event *is* its own card, so it becomes a chip (plan, K5-2). Events and planned
trainings stay full cards.

**The chip.**
- A `<button class="cc-daychip cc-daychip-{kind}">` with the kind's icon and short text:
  - a test shows its title ("CMJ test");
  - an RPE request shows "RPE · {title}";
  - an imported activity shows "GPS {startTime}", or "GPS" without a time;
  - another activity shows its title, or "Activity".
- The status survives as the month mini card's dot (tone from `centralCalendarStatusBadge`), so "awaiting" and "needs
  a state" are not lost. The full sentence is the chip's `aria-label` (`cardAriaLabel`).
- Same `data-action="central-calendar-open-item"`: a click opens its panel, never the module (README section 2).
- Height about a third of a card, and at least 44 px on touch (`frontend.md`).

**Where (E4).**
- In the list layouts (week columns, the phone's selected day, the Day view), the day's cards come first, then its
  chips, each part in the server's order. The phone's "No time" split applies to cards only.
- In the wide time grid, a chip sits in its hour's cell like a card, because the grid is positional, and a chip with
  no time sits in the "No set time" row.
- The month already draws compact mini cards. Only the icon changes: `gps` for an import.

### 2.5 *Show only* and **GPS imports** (H3, E9–E11)

**The control.**
- One row of pills: **All · Events · Planned training · GPS imports · Other activities · RPE requests · Scheduled
  tests**. Each pill has its icon and the count of the displayed days.
- It is a radio group (`role="radiogroup"`, each pill `role="radio"` / `aria-checked`).
- One tap shows only that kind; another tap switches straight over; *All* or *Show all* brings everything back.
- While it is not *All*, a green line says "Showing only **GPS imports** · 5 this week · *Show all*" (E10).
- Groups and event types stay multi-choice, folded under **More filters**.

**The filter state.** `cal.filters.kinds` becomes a list of **at most one** client kind. The client kinds are the
five server kinds plus `gps` (GPS imports) and `other_activity` (Other activities). Event types (`filters.eventKinds`)
narrow events only:
- choosing an event type sets *Show only* to **Events**;
- choosing any non-event kind clears the event types.

So "RPE requests plus an event type" can no longer be chosen, and FE-D16's known limit 2 disappears. FE-D16i, which
pins it, changes on purpose (Q3).

**Client-side matching** (`centralCalendarVisibleItems`), over the answer the cards come from:

| *Show only* | An item passes when |
|---|---|
| All | always (the groups still apply) |
| Events | `kind === "event"`, and its `eventKind` is chosen when event types are chosen |
| Planned training | `kind === "planned"` |
| GPS imports | `centralCalendarItemImported(item)`: an imported activity, or an event, planned or RPE card with `holdsImport` (E11, Q11). After K5-4: the "to review" marks. |
| Other activities | `kind === "activity"` and not imported |
| RPE requests | `kind === "external"` |
| Scheduled tests | `kind === "test"` |

**FE-D16 interplay** (`centralCalendarServerKinds`, `central-calendar-data.js:82`):

| *Show only* | Server read | Why |
|---|---|---|
| All, Events, GPS imports | unfiltered (no `kinds`) | GPS imports needs the event, planned and RPE cards that hold an import, and an event folds only with `event` in the read |
| Planned training | `kinds=planned` | as today |
| RPE requests | `kinds=external` | an RPE request an event folds is its own card again, as today |
| Scheduled tests | `kinds=test` | the same for a test schedule an event folds |
| Other activities | `kinds=activity` | an activity folded into a planned or RPE card stays folded there; filtered to the non-imported ones on the client |

The cache keys, the stale-answer rules and the panel-closing rules of FE-D16 (FE-D16c, e, f, g) are unchanged.

**Counts.** The counts come from the unfiltered answer over the displayed days (`centralCalendarChipCounts`):
- **GPS imports** counts imported activities plus the event, planned and RPE cards with `holdsImport`;
- **Other activities** counts the rest of the activities;
- a kind read through `kinds` counts what it shows, as FE-D16 does (the override after the kinds read,
  `central-calendar-view.js:1186–1188`). Under Other activities the `kinds=activity` answer also holds imports, now
  unfolded from their events. So the count written to `other_activity` is that answer's `kind === "activity"` items
  that are **not** imported. The server kind `activity` is no longer a pill of its own.

**Phone.**
- The row scrolls sideways, and the chosen pill is scrolled into view after every paint
  (`scrollIntoView({ inline: "nearest", block: "nearest" })`).
- The green line sits above the strip, so "only this" is always said in words, never shown by the pill's colour
  alone.
- Every pill is at least 44 px tall.
- *More filters* is a disclosure button under the row.

## 3. Who sees what

| Viewer | Calendar | K5-1 buttons | GPS icon / H4 marks / chips / *Show only* |
|---|---|---|---|
| Club admin (club workspace), private coach | the central calendar | All of section 1.2 for the cards it reads. On an event it manages, the RPE and Tests rows; on a reader's event, only the activities. A private coach manages only its own events, and only as an independent coach (`isIndependentCoach`, `calendarEventAccess.js`); `canManage` on the card already says which. | Yes |
| Team coach (team workspace) | the central calendar | The same. RPE and Tests rows only where the card carries the schedule id (manager), as above. | Yes |
| Platform admin | the central calendar in the workspace it is in | as that workspace's role | Yes |
| Athlete | the K4a athlete Calendar (`athlete-calendar-*.js`), **not** the central calendar | none of these (K4a has its own buttons) | **No**: her answer carries `holdsImport` on no card (2.2, the viewer gate), her event card is the reduced one, and K4a draws no marks, chips or filter |

Module rights are unchanged. A target the viewer may not open answers there as it does today; the calendar adds no
check of its own. For example, Training Load's leave guard and the route's 404 stay the authority.

## 4. Tests

**Frontend unit tests** (`central-calendar.actions`, `central-calendar-events.actions`, and a new
`central-calendar-k5.actions` for the new suites). The fakes honour `kinds` as the real route does, the
FE-D16 pattern.
- `centralCalendarItemImported` and `centralCalendarItemIconKey`: `api_import` and `source_import` give `gps`;
  `manual` and the self-report origins give `activity`; an event, planned or RPE card uses `holdsImport`.
- `centralCalendarCardMarks`: each row of 2.3, including both `separate` cases, a cancelled card, the GPS mark on a
  planned and an RPE card (never an RPE or test mark there), another kind and the reduced card. Also the order, and
  the `aria-label` words.
- Chips: which items become a chip, and that a folded item is never one; the chip's text per kind; cards before
  chips in the list layouts; the hour cell in the time grid; the month's icon.
- *Show only*: each pill's matching (the table in 2.5); the radio semantics (one at a time, a second tap switches,
  *All* resets); event types setting Events and a kind clearing them; the green line; the counts. Two more:
  - the Other activities count leaves out the imports of the `kinds=activity` answer;
  - Q11: a planned card and an RPE card with `holdsImport` pass under GPS imports and are counted; without it they
    do not.
- FE-D16 with the new kinds: `gps` gives no `kinds` read, `other_activity` gives `kinds=activity`, and the existing
  FE-D16 to FE-D16i stay green, except FE-D16i, which changes on purpose (Q3).
- K5-1: each button's presence per card and per viewer (manager or reader event); a click calls the right opener with
  the card's ids. Each opener calls `pushAppHistory()` before the tab changes, and not at all when a guard says stay.
  The Roster option sets the tab.

**Backend tests:** section 2.2's list, plus the whole disposable run against main.

**e2e at 1280, 390, 375 and 360 px**, on the e2e world with an imported activity linked to an event, a lone import,
a lone RPE request and a lone test:
- the GPS mark on the event and on a planned card holding an import, and the chips under the day;
- *Show only* GPS imports, then Scheduled tests, then *Show all*: the chosen pill is in view on a phone, there is no
  horizontal overflow, every target is at least 44 px and the green line is present;
- *Open in Tests* and *Open in Training Load* from a panel, then Back by button and by `page.goBack()`: the same day,
  the same panel;
- the athlete's K4a Calendar shows no mark.

**Mutations, each to be killed by a named test:**
- `holdsImport` dropped from `publicCard`, from each of the event, planned and RPE branches (the allowlists);
- `holdsImport` emitted only when true (the "no new key" and allowlist tests);
- the viewer gate removed, so the athlete's planned or RPE card gets the key (the "no card in the athlete's answer"
  test);
- each path left out of the imported-id check: the direct link, the Builder session, the folded RPE schedule, the
  planned card's session, the RPE card's assignment (the backend value tests);
- the imported-id set built from every activity row, not the viewer's scoped read (the "no right, never true" test);
- `source_import` missing from the frontend helper;
- the `separate` clause dropped from either mark;
- the mark order changed;
- chips including a folded item;
- *Show only* as multi-choice (a second tap adds);
- an event type not clearing a non-event kind;
- `gps` reading with `kinds=event,activity` instead of unfiltered;
- `other_activity` keeping imports;
- an opener's `pushAppHistory()` moved after a guard or removed;
- the Roster option ignored;
- the scroll-into-view of the chosen pill removed (the e2e test at 360 px);
- the Other activities count including imports (its unit test);
- planned or RPE cards left out of GPS imports (the Q11 unit test).

## 5. Questions, recommendations and decisions

The stream manager decided all ten as recommended (2026-11-20). His notes are under Q1, Q3, Q7 and Q10.

- **Q1. The Builder target (K5-1, *Open in Builder*).**
  - Opening a plan in the Builder creates or reuses the coach's edit draft on the server (`POST …/edit`).
  - A group card holds one plan per athlete, and the card does not say whether a plan is weekly or a program.
  - **Recommendation:** leave *Open in Builder* out of K5-1. The planned card keeps its athlete rows, each opening
    that athlete's Weekly plan on the day.
  - Agree the Builder entry later with E's Builder batch edit (#673, step 2), which edits a group's plans together.
    It is its own small step with E's GO and needs at least `planType` (or a "the group's batch" id) on the card.
  - **Decided:** the Builder stays out of K5-1.
    - For an event, K3's *Plan the training* (#678) is already the way into the Builder.
    - A planned card's *Open in Builder* waits for #673 and for a decision on the edit draft.
    - The approved mockups show *Open in Builder* on the planned card, so the stream manager tells the owner.
- **Q2. *Go there* for an activity folded into a planned or RPE card.**
  - **Recommendation:** the existing *Open in Training Load* stays on those panels as today.
  - No new rows: the Builder and RPE rows come first, and the activity's button follows them (the plan's order).
- **Q3. FE-D16i (known limit 2) under single-choice *Show only*.**
  - **Recommendation:** accept that event types become a sub-filter of Events, so the combination cannot be chosen.
  - FE-D16i is rewritten on purpose to assert that choosing RPE requests clears the event types.
  - Plan 9.4's limit 2 is marked closed by K5-2.
  - **Decided** as recommended. #677 pins the current limit in FE-D16i, so the K5 frontend PR updates that test.
- **Q4. "To enter results" in Tests.**
  - The Tests coach screen shows who has answered and offers reminders; results come from the athletes' own forms.
  - **Recommendation:** the hint says "to see who has answered", and the plan's wording is corrected in the same PR.
- **Q5. E1, the trailing arrow.** **Recommendation:** yes, as the mockups draw it. It is the one control in the
  panel that leaves the calendar.
- **Q6. Marks on a cancelled event.** **Recommendation:** no marks. The card is struck through, and its status line
  says cancelled.
- **Q7. The test kind's icon.**
  - Today a test card and the Scheduled tests filter use `stopwatch` (`CENTRAL_CALENDAR_KIND_ICONS.test`); the
    approved mockups draw `clipboard` for tests.
  - **Recommendation:** one icon per kind everywhere. Switch the test kind to `clipboard` with K5-2 (card, chip,
    filter, mark).
  - **Decided:** `clipboard` everywhere, as in the approved mockups.
- **Q8. A planned training (Builder card) that holds an import.**
  - An imported activity can fold into a planned card through its session.
  - H4 names events only. **Recommendation:** no mark on a planned card in K5-2. If the pilot asks for it, the same
    boolean is added to the planned card by the same pattern.
  - **Superseded by Q11:** planned and RPE cards carry `holdsImport` and the GPS mark (only the GPS mark).
- **Q9. Remembering *Show only* (E10).** **Recommendation:** for the session only, as the filters are kept today.
  The green line shows whenever it is not *All*.
- **Q10. Splitting the work.** **Recommendation:** two pull requests in one package:
  - K5-2a, the backend `holdsImport` with its tests (`code-reviewer`, and the whole disposable run);
  - K5-12, the frontend of K5-1 and K5-2, with `code-reviewer`, `mobile-qa` and `ux-design-reviewer`, the browser
    check at the four widths and the Frontend PR gate.

  The backend PR first, so the frontend reads a field that exists on main.
  - **Decided:** two PRs.
    1. **Backend `holdsImport`**, covering every fold path and, after Q11, the planned and RPE cards too. It carries
       the full key-by-key allowlists (section 2.2) and the whole disposable run against main. Tier ★, with the
       *Nezavisni revizor* (Q11).
    2. **The frontend.**
  - **After the reviews:** the code and security reviews found a third path, an import that comes in through the
    event's folded RPE schedule (`calendarQuery.js:1297`). Section 2.2 now covers all three, through one set of
    imported ids checked against the event's `links.activityIds`. The backend PR covers every path.
- **Q11. GPS imports and an import folded into a planned card or a lone RPE card** (new after the reviews).
  - Such an import has no card of its own. Without `holdsImport` on the card it folds into, it would not be found
    under *Show only · GPS imports*, and it would have no GPS mark.
  - The first recommendation was a pinned known limit. The stream manager recommended widening instead: the owner's
    H2 wants the GPS icon wherever an import lives.
  - **Decided by the OptiMove manager, 2026-11-20: widen.** The same `holdsImport` boolean, from the same imported-id
    set of the viewer's scoped read, also goes on the planned (Builder) and RPE (`external`) cards of a coach or a
    reader. It never goes in the athlete's answer.
  - **His conditions** (section 2.2 carries them):
    - the key-by-key allowlist test extended to those two card kinds: still exactly one new key, always present, a
      boolean;
    - a test that the athlete's answer has the key on no card;
    - a test that a viewer with no right to the activity never gets `true`;
    - the whole backend disposable run;
    - the backend PR's tier is ★, with the *Nezavisni revizor*.
  - The known-limit pin is not written. Sections 2.2–2.5 and the tests are updated.

## 6. Not in this contract

- K5-3 (*Add to the event?*), K5-4 (GPS sessions waiting for import, and Imports opening on a day) and K5-5 (*Open
  in calendar*).
- Any change to the Builder, Tests, Training Load or Imports beyond the openers named in 1.2.
- A route change, a migration, or a new read.
