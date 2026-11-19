# Central calendar — K4 plan: the athlete's calendar, and changing an answer

Status: **Proposed** (2026-11-19, written against `main` `f406ee2d`). This plan contains no code. The first step is
**K4-0**, which comes from the reproduction described in section 3; it needs the manager's GO before any code. K4a
needs a UI contract and a GO. K4b needs the OptiMove manager's approval and a migration number (v83 or later).

## 0. The owner's decisions (2026-11-19, in the calendar stream's chat)

| | The owner's words | Read as |
|---|---|---|
| **O1** | „Kalendar je ulaz, Weekly plan je sadržaj to je ok, samo da mozemo uci kroz kalendar i da se mozemo vratiti na kalendar lako userfriendly." · „ulaz izlaz lagan i userfriendly" | The athlete's Calendar lists the days. A training opens its exercises in the Weekly plan, and Back returns to the same place in the calendar. |
| **O2** | „i u kalendaru verovatno da se vide i treninzi" · „grupni i ostali dogadjaji" | The athlete's Calendar shows trainings and every event the athlete is part of: team and club events (training, match, travel, meeting, day off, camp, test). |
| **O3** | „Ostaje samo kod sportiste da imamo mozda povezivanje ovih stvari" · „Ako samo kroz builder pravimo na kalendaru ce svakako ocrtava kao i sada sta je zakazano a moguc ulaz u weekly plan, to i funkcionise u trenerovoom kalendaru" | An event linked to a training is **one card** for the athlete too, as it already is for the coach. Coaches create trainings through the Builder's *Make an event*, which links them. Nothing is matched by guessing. |
| **O4** | „mozda mu dati neko vreme za edit svog odgovora … ostaviti neki razuman rok za editovanje odgovora, a to se moze postaviti i unutar vazenja ankete" | The athlete may change their own answer while the question's window is open, from the event in their calendar. |
| **O5** | (reported) „za sada svuda ne funkcioniše to vraćanje back" · drop-downs „brzo se zatvaraju (npr tokom izbora ko nije učestvovao u trening)" | These are bugs. Section 3 deals with them. |
| **O6** | „ne znam jos uvek sta raditi kroz builder da li i tu nekako omoguciti kreiranje dogadjaja ili ne" · „ili da se izabere unutar kog dogadjaja idu vezbe" · „ako se ne izabere da radi kao do sada" · „daj kreativne predloge" | Open: the Builder's side. Section 5 proposes options, and the owner chooses. If nothing is chosen in the Builder, it works as today. |

The Weekly plan screen does not change (K0 D5). It stays its own tab beside Calendar until the pilot shows whether it
is still needed (section 2, decision K4a-1). The Builder's side is open (O6); section 5 proposes options.

## 1. What exists today

- **The athlete shell** (`frontend/athlete.html`):
  - a *Weekly plan* tab (`data-athlete-tab="calendar"`);
  - Athlete Home with *Upcoming events* (K2b-1e: 14 days, `GET /api/calendar?kinds=event`);
  - the open questions (K2b-2a-3).

  There is no calendar screen.
- **`GET /api/calendar` in the athlete workspace** already returns:
  - the athlete's own events, as the D21 / D27 reduced card;
  - their own planned groups (their own plans);
  - their own RPE and test assignments;
  - their own participation in activities;
  - never a teammate.

  It **folds nothing**: `coachView = ctx.type !== "athlete"` gates the event links (`backend/src/calendarQuery.js`,
  the comment "The links (K2a-1b) are a coach's matter"). So an event and its linked training are two cards for an
  athlete today.
- **Opening the Weekly plan on a date:** `openWeeklyPlanOnDate(date)` (`frontend/app.js`) pushes one app-history step
  and sets the week and day. The coach calendar's athlete row uses `openWeeklyPlanForAthleteOnDate`.
- **An RPE answer:**
  - It goes through `POST /api/training-load/external-assignments/:assignmentId/rpe`. The same answer again is a
    replay (200); a different answer is `409 "This session already has a submitted result."`.
  - The row in `training_load.session_feedback` is an **immutable snapshot**: the v2 trigger
    `protect_session_feedback_snapshot` refuses any change of `rpe`, `duration_minutes`, `athlete_note` and
    `submitted_at`.
  - Every reader reads that one row live (ADR-004).
  - The assignment's window is `external_assignments.opens_at` / `closes_at`.

## 2. K4a — the athlete's Calendar (frontend, plus one small backend change, no migration)

**The screen.** A new **Calendar** tab, first in the athlete rail. *Upcoming events* on Home gets *See all* → Calendar.

- **One week, a list by day** (the D13 list mode):
  - arrows and *Today*;
  - on a phone, a strip of the week's days;
  - a day with nothing shows nothing (no empty card).
- **Cards:**
  - an **event**: the type's icon and colour, the title, the time, the place with *Open in maps*, and *Cancelled*
    when it is;
  - **my training** (a planned group of my plan): the session's name and slot, and *Open training*;
  - **an event linked to my training**: one card. The event's head (time, place) comes first, then *Open training*;
  - **a question waiting for me**: *Rate RPE* / *Wellness* on the card. After K4b, also "Your RPE: 7 · Change
    (until 22:00)".
- **Open training** opens the Weekly plan on that day and session (`openWeeklyPlanOnDate` plus a scroll to the
  session).
- **Back to the calendar (O1):** the phone's or browser's Back and a visible *Back to calendar* control in the Weekly
  plan both return to the same week, the same day and the same scroll position. The calendar's context
  (week, day, scroll) is saved on the history step and restored, never read again from defaults.
- **The backend change:** the athlete workspace folds **its own** linked planned sessions into the event card.
  - The event keeps the D21 / D27 allowlist.
  - The folded part carries only what the athlete's own planned card already carries.
  - It carries no other athlete, no link id beyond the athlete's own session, and no count.
  - A cancelled event folds nothing, as for a coach (K2a manager decision 9.12).
  - Reviews: `security-reviewer`, and the external review for trigger 2 (info-hiding).
  - Tests: the allowlist key by key; an athlete never sees a teammate's linked session; a session linked to an event
    the athlete is not targeted by stays its own card.
- **Not in K4a:** exercises shown inside the calendar (option B: later, if athletes ask for it); a month view beyond
  the arrows; any write except the existing question forms.
- **Decision K4a-1 (recommended, the owner's O1 reading):** *Weekly plan* stays a tab beside *Calendar* until the
  pilot ends.
- **Decision K4a-2 (the owner's O3):** a team training made in the calendar and a training made separately in the
  Builder, with no link between them, are two cards. The remedy is the Builder's *Make an event*, not a guess.

## 3. Back and drop-downs (O5): reproduce first, then fix

An executor reproduces both on the e2e world at 390 and 1280 px, with no code change. For each item the report gives:
reproduced or not, the cause as file:line, and the smallest fix.

- **Back:** from every place the calendar opens (an athlete's Weekly plan, Training Load, the Roster tab, the Builder,
  Settings › Calendar, the event form) and back, for a coach, a club admin and an athlete.
- **Drop-downs that close by themselves:** the Roster tab's reason list (single and bulk, the popover and the phone
  sheet), the calendar's filters and selects, the event form, the question step and the Training Load filter. Each one
  is held open for 30 seconds and scrolled while open.

The calendar stream fixes what is its own in **K4-0**, a small pull request before K4a. The rest (the Roster, Training
Load, app-wide history in `app.js`) goes to the OptiMove manager with the cause and the proposed fix.

## 4. K4b — changing an RPE answer while the question is open (★★, migration v83 or later)

**Rule (O4):**
- The athlete may change their own RPE, duration and note **until the assignment's `closes_at`**, the window the
  coach set when asking. After that the answer is locked.
- The first version covers the calendar question's RPE (external assignments).
- An RPE asked through a Builder training has no window today. It gets the same rule once it has one; that is a
  separate decision.

**Data (recommended option C; the others are listed so that the choice is visible):**
- **C, recommended.** A sanctioned function changes the one `session_feedback` row in place, inside the window. In the
  same transaction it writes the old values into a new append-only history table. The v2 trigger lets the change
  through only under that function's transaction-local marker (the v57 pattern). Every reader stays as it is
  (ADR-004: one row, read live), and `srpe` is a generated column, so it follows. The coach sees "Changed" and the
  history.
- **A.** A correction row that supersedes the old one, with "one current row per assignment". Every reader
  (dashboards, the calendar's counts, Training Load) has to learn to read the current row only. That is wide.
- **B.** A separate table of corrections that the readers merge. Just as wide as A, plus a second source of the
  truth.

**To verify in the contract:**
- that nothing copies the RPE value out of `session_feedback`: the reader list on `f406ee2d` is `calendarQuery.js`,
  `calendarQuestions.js`, `calendarQuestionService.js`, `calendarEventService.js`, `plannedSessionFlags.js`,
  `trainingActivityMaterialize.js` and the routes;
- the window's check under the assignment's lock, which is the order the submit already takes;
- what a dashboard shows for a value that changed.

**The OptiMove manager:**
- **Ownership:** this is Training Load data, so the plan goes to him for approval first.
- **Migration:** it changes no existing row when it is applied, but it lets an existing kind of row change later, so
  it is announced to him in advance.
- **Number:** v83 or later.

**The screen:** on the event card in the athlete's Calendar and on Home, "Your RPE: 7 · Change". The form opens filled
in, with *Save change* and "You can change it until 22:00".

## 5. The Builder's side (proposals; the owner chooses, O6)

Today the Builder's *Make an event* (K2c-2) always makes a **new** event for a session. The day it reads also tells
whether the session is already linked to an event. What is missing is the other case: putting a session's exercises
**into an event that already exists**. For example, the club admin entered "Training 10:00 · Stadium" in the calendar,
and the coach now writes its content. The route exists (`POST /api/calendar/events/:eventId/sessions`, K2a-1b, the one
the calendar's *Link* uses), and it takes only an event the caller manages.

- **P1, recommended (K2c-3, frontend only, no migration):**
  - the *Make an event* panel gets a second path, **Add to an event on this day**: a short list of that day's events
    the coach manages, not cancelled, each with its time and place (for example "Training 10:00 · Stadium", "Match
    17:00");
  - choosing one puts this training (its athletes' sessions of that slot) into that event;
  - choosing nothing keeps today's *Make the event*, with no change for anyone who does not use it;
  - events the coach does not manage (for example the club's) are not offered. One sentence says the club admin can
    link them from the calendar.
- **P2, with P1:** when the day has exactly one event of a training or match type whose time falls in the session's
  slot (AM / PM), the panel **suggests** it first: "This day has 'Training 10:00'. Put these exercises into it?" with
  [Add to it] and [Make a new event]. It is a suggestion, never automatic (O3: no guessing).
- **P3, already planned as K3:** the other direction. An event in the calendar offers *Write the training*, which opens
  the Builder for the event's athletes and day, and the saved training is already inside the event. It suits a coach
  who plans the season in the calendar first (matches, trainings, travel) and writes the content later.
- **P4, later and only an idea:** the Builder's week shows that week's events above the days, read-only ("Match 17:00"
  on Saturday). The days around a match can be marked relative to it (MD-1, MD+1, the usual way of planning load
  around matches), so the coach sees where the lighter and the harder days belong. Its own plan, if the owner wants it.

## 6. Order

1. The current queue: #638 → #643 → FE-D16.
2. **K4-0**: Back and drop-downs, the calendar's part, from section 3's report.
3. **K2c-3** (P1 + P2), if the owner chooses it.
4. The event panel package (no migration): each athlete's RPE and duration in the coach's event panel, the summary
   ("Answered 12/15 · average RPE 6.8") and a clearer athlete click.
5. **K4a**: the athlete's Calendar.
6. **K3** (P3): *Write the training* from an event (the K2c plan, section 3).
7. **K4b** runs in parallel once the OptiMove manager approves it.
