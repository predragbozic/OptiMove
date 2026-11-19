# Central calendar — K4 plan: the athlete's calendar, and changing an answer

Status: **Proposed** (2026-11-19, written against `main` `f406ee2d`). This plan contains no code. The first step is
**K4-0**, which comes from the reproduction described in section 3; it needs the manager's GO before any code. K4a
needs a UI contract and a GO. K4b has the OptiMove manager's approval of its direction, with migration v83 (`202611201200`) and his six conditions (section 4); its contract comes next.

## 0. The owner's decisions (2026-11-19, in the calendar stream's chat)

| | The owner's words | Read as |
|---|---|---|
| **O1** | „Kalendar je ulaz, Weekly plan je sadržaj to je ok, samo da mozemo uci kroz kalendar i da se mozemo vratiti na kalendar lako userfriendly." · „ulaz izlaz lagan i userfriendly" | The athlete's Calendar lists the days. A training opens its exercises in the Weekly plan, and Back returns to the same place in the calendar. |
| **O2** | „i u kalendaru verovatno da se vide i treninzi" · „grupni i ostali dogadjaji" | The athlete's Calendar shows trainings and every event the athlete is part of: team and club events (training, match, travel, meeting, day off, camp, test). |
| **O3** | „Ostaje samo kod sportiste da imamo mozda povezivanje ovih stvari" · „Ako samo kroz builder pravimo na kalendaru ce svakako ocrtava kao i sada sta je zakazano a moguc ulaz u weekly plan, to i funkcionise u trenerovoom kalendaru" | An event linked to a training is **one card** for the athlete too, as it already is for the coach. Coaches create trainings through the Builder's *Make an event*, which links them. Nothing is matched by guessing. |
| **O4** | „mozda mu dati neko vreme za edit svog odgovora … ostaviti neki razuman rok za editovanje odgovora, a to se moze postaviti i unutar vazenja ankete" | The athlete may change their own answer while the question's window is open, from the event in their calendar. |
| **O5** | (reported) „za sada svuda ne funkcioniše to vraćanje back" · drop-downs „brzo se zatvaraju (npr tokom izbora ko nije učestvovao u trening)" | These are bugs. Section 3 deals with them. |
| **O6** | „ne znam jos uvek sta raditi kroz builder da li i tu nekako omoguciti kreiranje dogadjaja ili ne" · „ili da se izabere unutar kog dogadjaja idu vezbe" · „ako se ne izabere da radi kao do sada" · „daj kreativne predloge" | Open: the Builder's side. Section 5 proposes options, and the owner chooses. If nothing is chosen in the Builder, it works as today. |
| **O7** | „make event treba da bude na vrhu sesije odmah pored sesije i da bude vidljivo da se moze kreirati. Osim toga dve sesije mogu biti unutar jednog eventa, npr aktivnosti pre tokom i posle trneinga. zar ne" · „sada ne znam kako to sada srediti" | *Make an event* moves to the session's top line, beside its name, and is clearly visible. One event can hold several sessions of its day (Before, Training, After). The owner leaves the shape to the stream; section 5 is the package. |
| **O8** | „mozda ga skroz izdvojiti kreriati evnets pa onda birati unutar sesije da li prpada kome. daj neko userfrientdly resenje" | The events stand on their own in the Builder's day. Each session chooses the event it belongs to. Section 5 is that design, and it replaces the per-session *Make an event* button. |
| **O9** | „ostali predlozi su dobri i slazem se" · „samo ovo treba na neki bolji nacin resiti" · „na primer iz glavnog kalendara je lako kada ulazimo iz dogadjaa u builder pa kreiramo aktivnosti unutar tog dogadjaja" | The owner agrees with the rest of the plan. The main way is **from the calendar**: open an event, go into the Builder, and create its sessions inside that event (K3, now the main path, section 5.1). The Builder's own events row (5.2) is the way back for a coach who starts in the Builder. |
| **O10** | „ako iz buildera krenemo mi mozemo na primer da imamo dugme kreiranje dogadjaj i da nas odmah odvede u kalendar i da kreiramo dogadjaj kao sto se i sada kreira i da se odmah iz tog dogajdaja ili back dugmetom ako necemo da ga kreiramo vratimo u bulder" · „pa da dole onda biramo dogajdaj za tu sesiju" | From the Builder, **Create event** opens the calendar's own event form. After *Save*, or after Back with nothing made, the coach is back in the Builder, and the session chooses its event below. There is one event form in the app. Section 5.2. |

The Weekly plan screen does not change (K0 D5). It stays its own tab beside Calendar until the pilot shows whether it
is still needed (section 2, decision K4a-1). The Builder's side (O6, O7) is section 5.

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

## 4. K4b — changing an RPE answer while the question is open (★★, migration v83, `202611201200`)

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
- **Number:** v83, `202611201200` (given by him on 2026-11-19).

**The OptiMove manager's approval (2026-11-19):**

He agreed with option C. The migration is **v83, with the prefix `202611201200`**. The contract must meet his six
conditions:

1. **Who may change, and until when.** Only the athlete changes their own row, and only while the assignment is open
   (`closes_at`).
   - The database checks this under the lock, not only the service.
   - The race between a change and the assignment's close has a defined outcome in both orders, with a test.
2. **The history.**
   - It is append-only: who, when, the old values and the basis.
   - It is written in the same transaction as the change.
   - The v2 trigger lets a change through only under the transaction-local marker the sanctioned function sets (the
     v57 pattern).
   - The marker never outlives its transaction. A raw session that sets it is refused by a deferred guard that checks
     that the history row of the change was written in the same transaction (the v35 lesson).
3. **The coach is told.**
   - A read the coach already uses carries a mark that the answer changed: at least a boolean and the time of the
     last change.
   - Dashboards keep reading only the current value, with no duplicate rows.
   - The contract checks every reader of `session_feedback` (weekly, calendar, analysis, the dashboard query,
     `canonical_activity_results`) and confirms that none caches or sums the history.
4. **What may change.**
   - Only the RPE, and what the athlete entered in that answer themselves.
   - Not the duration, and nothing that came from the coach or an import. Whether the external form's duration is the
     athlete's own entry is settled in the contract.
   - A `requestKey`. The same value writes no history row.
5. **The migration.**
   - It changes no existing row.
   - The rollback refuses once a history row exists.
   - It is a ★★ package, with apply → rollback → re-apply rehearsed, also on a database built from the production
     schema snapshot.
   - PostgreSQL 17 stays NOT RUN until the owner runs it locally.
6. **Info-hiding.**
   - Another athlete's row and a missing row give the same answer.
   - A closed question gives a stable sentence.

**The screen:** on the event card in the athlete's Calendar and on Home, "Your RPE: 7 · Change". The form opens filled
in, with *Save change* and "You can change it until 22:00".

## 5. The Builder and the event, both ways (O6–O9)

**What exists today.**
- The Builder's *Make an event* (K2c-2) always makes a **new** event for one session.
- The button sits low in the session's settings, and it is grey with "Save the plan first, then make the event." until
  the plan is saved. The owner did not find it (a screenshot, 2026-11-19).

**What the server already allows** (read on `f406ee2d`):
- An event holds sessions of **any slot of its days** (`judgeSessionsForLink` checks only the day, the target and a
  link to another event). So Before, Training and After of one day can be one event.
- The create takes a list (`sessions.logicalSessionIds`).
- An existing event takes more sessions through `POST /api/calendar/events/:eventId/sessions` (K2a-1b, the
  calendar's *Link*), only for an event the caller manages.

### 5.1 K3: from an event into the Builder, the main path (O9)

```
Calendar › Mon 12.10 › ● Training 10:00 · Stadium  ›  [Plan the training]
                                                        │
Builder ────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│ Planning: ● Training 10:00 · Stadium · Mon 12.10 · 18 athletes │
│ Sessions you add on this day go into this event. [Back to calendar] │
└────────────────────────────────────────────────────────────────┘
MONDAY 12.10   + Before training   + Training   + After training
```

1. **The button in the calendar.** The event's panel (the coach's calendar) offers **Plan the training** while no
   session is linked. Once sessions are linked, it offers **Open the training**.
2. **The Builder opens inside the event.**
   - It opens on the event's day, for the event's athletes, with a band at the top: the event's colour, title, time,
     place and number of athletes, and **Back to calendar**.
   - Every session added on that day belongs to the event and wears its colour. Before, Training and After go in one
     event (O7).
   - A session can be taken out of the event with one tap ("Not in this event").
3. **Save.** One press saves the plan and links its sessions to the event. A failed or unconfirmed save links nothing,
   and says so. Back and *Back to calendar* return to the event (K4-0).
4. **Which plan opens.** This is the hard part, and its discovery comes first:
   - the event's athletes share a weekly plan of that week → that plan opens;
   - none of them has one → a new weekly plan of that week for all of them (one Builder batch);
   - mixed → the panel names who already has a plan and offers the choice.

   The Builder's week model and the return context get their own contract (the K2c plan, section 3).

### 5.2 K2c-3: from the Builder, for a coach who starts there (O8, O10)

It replaces K2c-2's inline *Make an event* panel. The app keeps **one** event form, the calendar's.

```
Builder · MONDAY 12.10.2026                                   MD-1
Events:  [● Training 10:00 · Stadium]          [Create event →]
──────────────────────────────────────────────────────────────
Before training · Mobility & stability   Event: [Training 10:00 ▾]
Training · Main session                  Event: [Training 10:00 ▾]
After training · Recovery                Event: [ No event     ▾]
```

1. **The day's events row.**
   - It sits right under each day's label: that day's events for this plan's athletes, as chips (the type's colour
     and icon, the time, the place).
   - The Builder reads the week once when it opens a weekly plan, through `GET /api/calendar` with this plan's
     athletes and `kinds=event`.
   - Pressing a chip opens that event in the calendar, and Back returns to the Builder.
2. **Create event →** takes the coach to the calendar's own event form, already filled in:
   - the day, the type (Training), the title (the session's name) and the time (the session's time, if it has one);
   - the plan's athletes as the targets.

   A band says "Creating an event for the Builder · Monday 12.10 · [Back to the Builder]". Then:
   - **Save** makes the event the usual way, places and questions included, and returns to the Builder.
   - **Back**, or *Back to the Builder*, makes nothing and returns to the Builder.
   - On return, the new event is already chosen for the session the coach started from, if they started from a
     session. The coach can change that.
3. **Each session's line** carries **Event: [ … ▾ ]** (O10, "dole onda biramo događaj za tu sesiju"):
   - it lists the day's events the coach manages, and *No event*;
   - choosing an event links the session (`POST /api/calendar/events/:eventId/sessions`);
   - choosing *No event* ends the link (the calendar's existing *Unlink*);
   - the chosen event's colour shows on the session's line.
4. **Several sessions in one event (O7).** Before, Training and After simply choose the same event.
5. **No dead end before Save.**
   - If the plan is not saved, *Create event →* and the selector ask once: "This plan isn't saved yet. Save it (the
     athlete will see it) and continue?", with [Save and continue] and [Cancel].
   - The save is the Builder's own *Save and finish*. Its outcome is waited for, and a failed or unconfirmed save
     goes nowhere.
6. **An event the coach does not manage** (for example the club's match) shows as a chip with a lock. In the selector
   it is listed but cannot be chosen, with one sentence: "Linked by the club's admin from the calendar."
7. **One RPE channel per event.**
   - The event's chip says where its RPE comes from ("RPE: Training · Main session").
   - The server's existing refusals read as the sentences of #643.
8. **Nothing chosen = as today.** A session with *No event* is a training in the plan and its own card in the
   calendar, exactly as now.
9. **The two directions are the same pattern.** K3 goes from the calendar into the Builder with a band and *Back to
   calendar*. K2c-3 goes from the Builder into the calendar's form with a band and *Back to the Builder*. Back (K4-0)
   carries both.

**For the athlete (K4a):** the event is one card with its time and place, and *Open training* opens that day in the
Weekly plan, where Before, Training and After stand in their order.

**Contract and reviews.** K3 and K2c-3 share the band and return pattern, and each gets a UI contract and the manager's GO before code. The reviews are `code-reviewer`,
`ux-design-reviewer` and `mobile-qa`. The browser checks run at 390 and 1280 px, and the Frontend PR gate applies.

**Later, still options:**
- **P4**, later: the events row makes it possible to offer the day label (the Builder already has one, "e.g. MD-1,
  Match day") as MD-1 / MD+1 from the calendar's match. The owner decides.

## 6. Order (the owner agreed, O9)

1. The current queue: #638 → #643 → FE-D16.
2. **K4-0**: Back (the app-wide fix, now being built; the OptiMove manager gates it) and the calendar's part of the
   drop-downs once reproduced.
3. **The Builder and the event:**
   - **K3** (5.1): discovery and contract first;
   - **K2c-3** (5.2), with it or right after it. It reuses K3's band and the calendar's form.
4. **K4a**: the athlete's Calendar.
5. The event panel package (no migration): each athlete's RPE and duration in the coach's event panel, the summary
   ("Answered 12/15 · average RPE 6.8"), and a clearer athlete click.
6. **K4b** runs in parallel. Its direction is approved (section 4), and its contract comes next.
