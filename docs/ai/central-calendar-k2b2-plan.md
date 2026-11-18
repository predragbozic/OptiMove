# Central calendar — K2b-2 plan: *Ask athletes* on an event (D40)

Status: **accepted by the owner (2026-11-18)**, with every decision of section 7 and section 8 („ostalo se slažem",
after the owner's own answers on Q2–Q4, Q6 and Q8). The code starts with K2b-2a-1, and its migration is written only on
the owner's order naming the file (section 4). No code, no migration in
this document. Written by the calendar stream's manager against `main` `946914f4`. No persistent database was read.

D40 (the owner, 2026-11-02; `docs/ai/central-calendar-k2b-plan.md` section 10 and D40): questions to athletes go only
through existing question channels, never through a new registry. K2b-2 is *Ask athletes* on an event.

## 1. What the code allows today (read-only discovery, 2026-11-18)

**RPE outside a plan: the Training Load external schedules** (`migrations_v2/202609011000_training_load_v4_external_scheduling.sql`
and v6–v8; `backend/src/routes/trainingLoad.js`):
- `training_load.external_schedules` is "an RPE session scheduled outside any Weekly plan": a label, its targets
  (athlete / team / club), occurrences per date, one assignment per athlete with that athlete's own window
  (`opens_at` / `due_at` / `closes_at` in their device time zone).
- `POST /api/training-load/external-schedules` creates one in one transaction. It has **no request key**, so a retried
  POST makes a second schedule, and it sends **no notification**.
- The athlete answers through `POST /api/training-load/external-assignments/:id/rpe`. The value goes into
  **`training_load.session_feedback`** with `source = 'scheduled_external'`, the one RPE / sRPE table of ADR-004, and
  the activity is materialized in the same transaction.
- **The calendar already links it:** `calendar.events.external_schedule_id` (v49, a real foreign key, one planned event
  per schedule, **no kind restriction**), checked by `checkScheduleRefs`. The calendar read folds the schedule's
  `rpe {asked, submitted, missed}` into the event's card, and the card shows "RPE x/y" (`central-calendar-view.js:325`).
  No screen sets the link today; only the API accepts it.
- **`expects: ['rpe']`** (the default of the *Training* and *Match* types) asks nobody by itself. With no channel, the
  panel says "RPE is expected, but nothing attached to this event asks the athletes for it yet." When planned sessions
  are linked and aligned, their `rpe_enabled` follows it, and planned RPE is answered through `POST /sessions/:id/rpe`
  into the same `session_feedback`.

**The Tests module** (`202608220900_tests_v42_*` to `202608300900_tests_v42_phase4_*`, `backend/src/routes/tests.js`):
- **Only WELLNESS can be scheduled.** `POST /api/tests/schedules` refuses any other version, and the athlete's form reads
  WELLNESS's parameters. The library holds WELLNESS (an athlete self-report: fatigue, sleep, soreness, stress, mood 0–10,
  injury yes / no, a total) and FMS (coach-measured movement tests and a battery), with no column telling a
  self-report from a coach measurement.
- **The window is one local day** (`opens_time` ≤ `due_time` ≤ `closes_time` on a date; a one-time schedule has
  `end_date = start_date`).
- **No request key** on `POST /schedules`. Team and club members are frozen once per occurrence, at its first
  materialization on the day.
- An event may carry `test_schedule_id` (v49) **only if it is of kind `test`**: the test the event *is*.

**Notifications:**
- `public.app_notifications` is the app's in-app notification (recipient, type, title, body, entity, metadata,
  `dedupe_key` with a partial unique index). `type` is free text, so a new type needs no migration.
- A plan's publish writes its notifications **inside the plan's transaction** (`notifyPlanAssignments`,
  `routes/builder.js:179-212`) and sends the realtime event after the COMMIT. The frontend shows an unknown type as a
  plain row and refreshes on `notifications_changed`.
- **Neither worker is scheduled:** neither the Tests notification worker nor the Training Load one runs on a cron
  (`backend/README-tests-notification-worker.md`, `README-training-load-notification-worker.md`). So nothing invites or
  reminds athletes today unless a coach presses *Remind*.

**Metrics Core:** the mapping chain (activation per team binding → value provenance) needs an external binding, so Tests
answers cannot reach the dashboards through it. That stays with the mapping line (Q1).

## 2. The shape: one feature over the two existing channels

*Ask athletes* adds no question store of its own. An event's question is always one of these two:
- **RPE**, through a Training Load external schedule linked by the existing `calendar.events.external_schedule_id`. The
  answer lands in `session_feedback` as today (ADR-004), and the card's existing "RPE x/y" counts it.
- **A Tests questionnaire** (today WELLNESS), through a Tests schedule linked by a new calendar link table (section 4),
  because v49 keeps `test_schedule_id` for the test a `test` event *is*. The answers stay in Tests.

The calendar writes those rows in its own command, through helpers extracted from `routes/trainingLoad.js` and
`routes/tests.js`. Both modules' create routes and the calendar therefore write the same rows, and a test pins that.

### 2.1 RPE without two places for one answer (the owner's point 2)

An event's RPE comes from **exactly one** channel:
- **Linked planned sessions:** when the event has planned sessions linked (K2a-1b), its RPE is theirs, as today: the
  athletes answer the session (`rpe_enabled`), and *Ask athletes* does not offer RPE ("RPE comes from the linked
  sessions").
- **Its own external schedule:** otherwise *Ask athletes* creates one RPE external schedule for the event's athletes and
  day, linked through `external_schedule_id`.
- **Linking a planned session to an event that already asks for RPE:**
  - while nobody has answered, the event's RPE schedule is cancelled in the same transaction and the sessions take over;
  - once someone has answered, the link is refused with one sentence ("Athletes have already answered this event's RPE.
    Remove the session link or keep the event's own RPE.").
- An athlete is therefore never asked twice for one event's RPE, and every RPE answer is one `session_feedback` row.

## 3. What the coach and the athlete see

### 3.1 Turned on per club, off by default (the OptiMove manager's standing note)

- The answers describe the athletes' state, minors included, and the legal basis is still open with the owner. So *Ask
  athletes* exists only where it is turned on: a switch **per club, off by default**. While it is off, nothing of it
  shows and the commands answer the identical 404.
- **Who turns it on** is the owner's decision (Q7). The recommendation is a platform admin, in Settings → Calendar of
  that club's workspace, with a reason, recorded; the club's admin sees the state.

### 3.2 Default questions per event type (Q4, the owner's point 2)

- **Settings → Calendar → Event types** gets a *Questions for athletes* choice per type: none, RPE, WELLNESS, or both.
- The proposed defaults follow `default_expects`: **Training and Match: RPE**; Test, Travel, Meeting and Camp: none;
  **Day off: none by default**. The coach may still add questions to a *Day off* event if he wants (the owner,
  2026-11-18: „ja mogu i da stavim na day off ako hoću").
- A new event takes its type's questions, pre-ticked in the form. The coach adds or removes them per event, before or
  after saving.

### 3.3 When the athletes answer (Q3, the owner's point 1)

- Three choices in the form:
  - **After the event:** from the event's end time (18:00 without one) until 23:59 the same day;
  - **Next morning:** 07:00–12:00 the next day;
  - **Custom:** a date (the event's days or the day after) and a from–to time.
- **Custom stays inside one day for now,** with the sentence "Answers can be collected within one day for now." A window
  across midnight needs a Tests and Training Load schema change, which is a later step.
- A multi-day event asks on its last day (After the event) or the day after (Next morning).

### 3.4 The athlete: a soft prompt, never a locked app (the owner's point 3)

- **At the moment of asking:** an in-app notification for every athlete asked, written in the same transaction as the
  question. Its type is `calendar_question_asked`, with a dedupe key per event, question and athlete, for example
  "Your coach asks how the match went. Answer after 20:00 today." It is never a push notification for now (Q6).
- **When the athlete opens the app** while a question is open (its window is open and it is not answered):
  - **the prompt:** the questionnaire comes first, over the whole screen, with the primary button **Answer now** and a
    secondary **Later**;
  - **Answer now** opens the existing form: the Tests WELLNESS form, or the RPE form of the external assignment;
  - **Later** is recorded with the time;
  - **after that:** the prompt does not come back during the same app session. The question stays at the top of Athlete
    Home until it is answered or its window closes;
  - **no lock:** the app is never locked, and the schedule is always visible. A strict "Required to continue" is not
    built.
- **The coach** sees, in the event's panel:
  - the counts ("RPE 3/18", "WELLNESS 2/18");
  - three lists of names: who answered, who chose *Later*, who has not answered yet;
  - the counts on the card, as "RPE x/y" today. Names appear only in the panel, for whoever may manage the event.

### 3.5 Changes after asking (Q5, the manager's recommendation, waiting for the owner)

- **The event is cancelled:** its questions are cancelled in the same transaction. The schedules are cancelled, nobody
  is asked any more, and the answers already given stay.
- **The event's day or time changes:**
  - while nobody has answered, the questions' window moves with it;
  - once someone has answered, the change is refused with one sentence ("Athletes have already answered this event's
    questions.").
- **Remove a question:** allowed while nobody has answered it. Afterwards it is closed early instead, and the answers
  stay.

## 4. The data (★ one calendar migration, v81 or later)

The numbers were agreed with the Metrics Core line (2026-11-18, its correction of the same day):
- v75 is reserved for the dashboards' D2a;
- v77 (PR #608, computed variables part 1), v78 (computed variables part 2), v79 (ratio and difference) and v80 (zone with
  a condition) are the mapping line's;
- the calendar takes **v81 or later**. The proposed file is `migrations_v2/202611191000_calendar_v81_athlete_questions.sql`
  (the prefix is unique on `main` `2d4e6d7e`). The number is checked against `origin/main` and the 12-digit prefix rule when the
  file is written, and the file is written only on the owner's order naming it.

The migration, in the `calendar` schema:
- **the club switch:** `calendar.club_question_settings` (club, on / off, who, when, reason), with its change log;
- **the type's defaults:** `calendar.event_types.default_questions` (`text[]`, values `rpe` / `wellness`, checked; the
  system types seeded from `default_expects`; empty for `day_off`, where a coach may still ask per event). It is exempt from v51's "the meaning is frozen" rule,
  like the label;
- **the Tests link:** `calendar.event_questionnaires` (event, Tests schedule, who, when; one live link per event and test
  version). It is trigger-checked like v49's reference, because the shared test fixture has no Tests schema;
- **the *Later* record:** `calendar.question_postponements` (event, question, athlete, when). It is append-only, and an
  athlete writes only her own row;
- the request and change rows of the calendar's runner, for the new operations.

## 5. The commands and reads

- **Ask / remove / move:**
  - one calendar command per change, with a `requestKey`, through the calendar's one runner (`calendarCommandRunner.js`:
    the writer lock, the event row `FOR UPDATE`, the right decided again on the locked row, the request and change
    rows, the bounded COMMIT);
  - in that transaction: the external or Tests schedule rows (targets = the event's targets, owner = the event's
    owner), the link, and the in-app notifications;
  - a lost answer is *Result not confirmed* · *Check result* with the same key, never a second schedule.
- **Create and edit of an event:** they carry the questions, which run the same steps inside the event's own command.
- **The athlete's open questions:**
  - one read for the prompt and Athlete Home: her open questions of events, each with its kind, the event's title and
    time, the window and the link to its form;
  - only her own; nothing about another athlete.
- **The athlete's *Later*:** one small write with a `requestKey`, refused for a question that is not hers or not open.
- **The coach's panel:** the counts and the three name lists, for a manager of the event only. For everyone else it is
  the identical 404, as the panel's athlete list today.
- **The fix:** `missed` on a folded Tests card is derived from the window's close, as the Tests module does.

## 6. Slices, tests and reviews

**K2b-2a-1 (★, migration and backend):**
- **Contents:** the migration of section 4; the commands and reads of section 5; the extracted helpers; the
  notifications; the fixes.
- **Tests:**
  - every basis, and the identical 404 while the club's switch is off;
  - the request-key replay and a lost COMMIT;
  - the schedules equal to their module's own create route with the same input;
  - RPE's one channel (section 2.1);
  - cancel, move, remove;
  - late joiners;
  - *Later* only for her own;
  - the notifications in the same transaction;
  - the counts.
- **Gates:** mutations on the guards; the T1 runner on disposable databases.

**K2b-2a-2 (coach screens):**
- Settings → Calendar: the type's *Questions for athletes*, and the club's switch for whoever Q7 names;
- the event form and the panel: the questions, the window choices, the counts and the three lists.

**K2b-2a-3 (athlete screens):** the soft prompt on opening the app, the top of Athlete Home, and the notification's
link.

**Reviews:**
- `code-reviewer`, `db-reviewer` and `security-reviewer` for 2a-1;
- `code-reviewer`, `ux-design-reviewer` and `mobile-qa` for 2a-2 and 2a-3;
- the fresh independent review on each;
- the owner's external review for 2a-1 (trigger 1, a migration; trigger 4, transactions and idempotency);
- browser checks at 360 / 375 / 390 / 1280 px on the real server with a disposable database.

**Not in K2b-2a:**
- questionnaires other than WELLNESS (Tests authoring and execution, a Tests track);
- a window across midnight;
- push notifications and scheduling the workers;
- any Metrics Core or dashboard change (K2b-2b, the mapping line).

## 7. The owner's decisions (2026-11-18) and what is still open

- **Q1, the split: decided.** The calendar builds K2b-2a. *Answers in the dashboards* (K2b-2b) stays with the mapping
  line, after its computed variables.
- **Q2, the questionnaires: decided** („Upitnici koji se nalaze u listi testova ili listi OptiMove (RPE) bi trebalo da
  mogu da se nađu unutar Ask athletes"). Offered now: **RPE** (the existing Training Load channel) and **WELLNESS** (the
  one questionnaire Tests can schedule). Any other Tests questionnaire appears once Tests can schedule it, with no
  calendar change.
- **Q3, the window: decided.** After the event, Next morning, and Custom inside one day for now (3.3).
- **Q4, which events: decided** („Ask athletes može da stoji kao default u nekim događajima, a da se u nekim omogući").
  Defaults per type in Settings → Calendar; Training and Match ask for RPE by default; Day off has none by default but
  may be asked on (3.2).
- **Q5, changes after asking: decided** as recommended (3.5).
- **Q6, notifications: decided.** The in-app notification only, as when a plan is published; no push for now (3.4).
- **The soft prompt: decided** (3.4). The strict variant is not built.
- **Q7, who turns it on: decided.** A platform admin, per club, recorded with a reason, as for the import switch. It
  stays off everywhere until then.

## 8. Daily WELLNESS that skips days off: an option of the Tests schedule (K2b-2c; the owner, 2026-11-18)

The owner: „takodje moze da se desi da ja zakazem wellness svaki dan anketu osim day off i da bude validna u periodu
nekom", and then: „moze da preskoci a ja mogu i da stavim na day off ako hocu. Inace wellnes vec postoji u testovima i
tamo neko zakazivanje vec postoji".

- **Where:** WELLNESS is scheduled where it is scheduled today, in Tests → Schedule, with the existing *daily* kind (a
  period from – to and a window each day). There is no second calendar form for it.
- **The new option** on that form: **Skip days off**, ticked by default. Unticked, the athletes are asked on days off
  too.
- **Live, from the calendar:** an athlete is not asked on a day when a planned *Day off* event of the calendar reaches
  her. That uses the calendar's own audience rule (the event's targets and membership on the day), decided when that
  day's assignments are made.
  - A *Day off* added later, before the day's assignments exist, therefore removes that day's question.
  - A *Day off* added after the assignments exist cancels the open, unanswered assignments of the athletes it reaches.
    That happens in the *Day off*'s own command; an answered one stays.
  - A *Day off* cancelled before the day's assignments exist brings the day back.
- **The data:**
  - a `skip_days_off` flag on `tests.test_schedules`;
  - the Tests function that makes a day's assignments, reading `calendar.events` (`CREATE OR REPLACE` with an md5
    precondition).
  - It goes in the same migration as section 4 (v81 or later), if built together.
- **Never twice on one day:** on a day when an athlete already has a WELLNESS from a daily schedule, an event of that
  day does not offer WELLNESS ("Today's WELLNESS already covers this day"). Its RPE stays.
- **The club switch** of 3.1 covers it, off by default, as do the athlete's prompt and Athlete Home card of 3.4, and the
  coach's view of who answered, chose *Later* or has not answered (in Tests, and on the calendar's Tests card).
- **Q8, decided by the owner:** days off are skipped by default and can be included. Live skipping is the manager's
  recommendation, and the owner did not object.
- **Q9, the order: decided as recommended:**
  1. K2b-2a-1, the backend of both the per-event questions and this option, in one calendar migration;
  2. the coach's screens, the Tests form's option first;
  3. the athlete's prompt.
