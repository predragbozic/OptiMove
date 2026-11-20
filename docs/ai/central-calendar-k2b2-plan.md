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

- **Known limit (accepted in K2b-2a-1 review round 1):** a skip is not reversed. If a covering question is removed or
  moved, or a Day off is cancelled, after the day's daily WELLNESS assignment was made as skipped, that day's daily
  WELLNESS stays skipped. The coach can ask WELLNESS on the event again; the refusal rule allows it once the daily one
  is cancelled.

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
    the writer lock, the event row `FOR NO KEY UPDATE` (round 1; it was `FOR UPDATE`), the right decided again on the locked row, the request and change
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
- Its UI contract, the manager's GO (2026-11-19) and what was built: `docs/ai/central-calendar-k2b2a3-ui-contract.md`
  (sections 12 and 13). Frontend only, no backend change.

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
- **The legal basis: stated by the owner (2026-11-18).** Asked whether the legal basis for asking athletes, minors
  included, blocks switching it on, the owner answered „Slobodno bez problema sa tim" and, asked what that referred to,
  „Na to". This is the owner's own assessment, not a legal confirmation, as with O10 of the import line. The club's
  switch stays off until a platform admin turns it on for a club with a reason, after the screens are built.

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

## 9. K2b-2a-1 — the owner's order and the manager's GO (2026-11-18)

- **The owner's order** (in the calendar manager's session, 2026-11-18): „Odobravam pisanje migracije
  migrations_v2/202611191000_calendar_v81_athlete_questions.sql". The prefix `202611191000` is unique on `main`
  `9351bcc0`, and the mapping line confirmed it plans no file with it.
- **Two phases:**
  1. The executor writes **9.1, the technical contract** of K2b-2a-1 in this section: the migration's objects, its
     explicit dependencies, the lock order, the commands and reads with their codes, the Tests change, the
     notifications, the preflight / post-check / rollback, and the test plan. The manager reviews it and gives a GO.
  2. Only then the code: the migration, its runbook, the backend and the tests, as one draft pull request (★★).
- **Rules agreed with the mapping line** for two lines that write migrations in parallel:
  - **No position assumed:** the preflight, post-check and rollback name the migrations this one depends on, and never
    assume it is the last by name. v75 and v78–v80 may or may not be recorded when it is applied.
  - **A narrow rollback guard:** the rollback refuses on a later migration only if that migration touches `calendar.*`
    or `tests.*`.
  - **The Tests function:** the package names the md5 of the Tests function body this migration replaces, so the
    OptiMove manager can read it read-only on production before the owner's merge order.
  - **The ★★ path:** the OptiMove manager's gate and the independent review on the frozen head, then the owner's order
    naming the file, then the preflight the same day, then the merge.

### 9.1 The technical contract of K2b-2a-1 (the executor, 2026-11-18; waiting for the manager's GO)

Written against `origin/main` `9351bcc0`-line code as checked out on this branch (`5e7660b0`). The md5 values below were
read on a disposable database built by the calendar fixture's migration list (`calendarMigrations()`, Tests v42 through
v76), not on any persistent database. **Deviations from sections 2–8 are marked ⚑** and listed again in 9.1.12 for the
GO.

#### 9.1.1 The file and its dependencies

- **File:** `migrations_v2/202611191000_calendar_v81_athlete_questions.sql`. The prefix `202611191000` is unique on
  `origin/main` (checked when this section was written; checked again before the file is committed, and on the merge
  tree before the merge, per `migrations.md`).
- **It depends on (the preflight checks each is recorded, with its checksum):**
  - `202610311000_calendar_v49_events.sql` and `202611011900_calendar_v51_settings.sql` (the calendar);
  - `202608240900_tests_v42_phase1_scheduling_execution.sql`, `202608260900_tests_v42_occurrence_generation_lock_fix.sql`
    and `202608300900_tests_v42_phase4_assignment_timezone_window.sql` (the Tests schedules and the function replaced);
  - `202609011000_training_load_v4_external_scheduling.sql` and `202609011100_training_load_v5_unified_result_source.sql`
    (the external schedules and `session_feedback.external_assignment_id`);
  - the v54 body of `calendar.lock_event_writer` (users first; LO-2), by md5.
- **⚑ It requires the Tests schema.** The shared GPEXE fixture list (`backend/tests/_gpexe-disposable-db.mjs`,
  `GPEXE_TEST_MIGRATIONS`, 93 suites) carries v49 and v51 but no Tests schema, so v81 is **not** added to it; it is added
  only to the calendar fixture (`calendarMigrations()`, which carries Tests v42). Because the Tests schema is then always
  present where v81 runs, v81 uses **real foreign keys** to `tests.test_schedules` / `tests.test_assignments` (the plan's
  "trigger-checked like v49" was for the fixture without Tests).
- **No position assumed.** The preflight, post-check and rollback never compare v81 with "the last migration". They
  report, for information only, whether v75 and v78–v80 are recorded.

#### 9.1.2 The migration's objects

All new tables refuse TRUNCATE (`calendar.refuse_truncate`), and every guard raises `23514` with a fixed message (and a
`constraint` name where the service maps it). `set local lock_timeout = '5s'` at the top.

1. **`calendar.club_question_settings`** — the club switch (plan 3.1, Q7):
   `club_id uuid primary key references public.clubs on delete restrict`, `enabled boolean not null`,
   `reason text not null` (`calendar.multiline_text_ok(reason, 500)`), `revision integer not null check (revision >= 1)`,
   `updated_by_user_id uuid not null references public.users`, `updated_at timestamptz not null default now()`.
   - Guard: an insert has revision 1; an update keeps `club_id` and bumps `revision` by exactly one; no delete.
   - **No row = off.** `calendar.questions_enabled(p_club_id uuid) returns boolean` (stable SQL:
     `coalesce((select enabled …), false)`) is the one definition the service and the triggers read.
   - **The change log reuses v51's pair** (`calendar.settings_requests` / `settings_changes`): their operation and kind
     CHECKs gain `questions_switch`; `settings_changes` gains `subject_club_id uuid references public.clubs on delete
     restrict`, `subject_kind` gains `club`, the subject-shape CHECK gains the `club` branch (only `subject_club_id`
     set), a partial unique index `(subject_club_id, revision)`; `basis` stays `platform_admin` / `club_admin` (the
     service writes only `platform_admin` here).
   - `calendar.settings_changes_before_insert()` is `create or replace`d with one more branch (`club`: the switch row's
     club and revision). **md5 precondition: `75ed99731f6d61d19a8f0c2e473fedd1`.**
   - The audit pairing at COMMIT: a deferred constraint trigger `club_question_settings_need_change` (as v51's
     `team_settings_need_change`).
2. **`calendar.event_types.default_questions text[]`**, nullable, CHECK `calendar.questions_ok(default_questions)`
   (null, or distinct values of `rpe` / `wellness`). **⚑ Null means "follow `default_expects`"**: the read and the
   create derive `{rpe}` when `'rpe' = any(default_expects)`, else `{}`. So Training and Match ask RPE and every other
   seeded type nothing (Day off included, plan 3.2) **without rewriting a system row** (v51's guard makes the system set
   final, and a club copy's update needs a revision bump and a change row). A club's type takes an explicit list through
   its own `type_update` (an empty list included). Like the label, it is not frozen by use.
3. **`calendar.event_questions`** (**⚑ one table for both kinds, instead of the plan's `event_questionnaires`**, so RPE
   and WELLNESS share the window, the status, the history and the postponements):
   - `id uuid pk`, `event_id uuid not null references calendar.events on delete restrict`,
     `kind varchar(10) check (kind in ('rpe','wellness'))`,
     `external_schedule_id uuid references training_load.external_schedules on delete restrict`,
     `test_schedule_id uuid references tests.test_schedules on delete restrict`,
     shape: `rpe` ⇔ only `external_schedule_id`, `wellness` ⇔ only `test_schedule_id`;
   - the window: `window_kind check in ('after_event','next_morning','custom')`, `window_date date not null`,
     `opens_time time not null`, `closes_time time not null`, CHECK `opens_time < closes_time` (one day, plan 3.3);
   - `created_by_user_id`, `created_at`, `ended_at`, `ended_by_user_id`,
     `end_reason check in ('removed','closed_early','event_cancelled','moved','replaced_by_sessions')`, the three null
     together or set together; `replaces_question_id uuid references calendar.event_questions` (a move ends the old row
     with `moved` and inserts a new live one);
   - **one live question per event and kind:** unique partial index `(event_id, kind) where ended_at is null`; a schedule
     is named by at most one question row ever: unique partial indexes on each schedule column;
   - guard (before insert / update): an insert is live, its event is `planned`, its event's owner club has the switch on
     (`questions_enabled`), its schedule's owner (`owner_scope` + id) equals the event's owner, the schedule is
     `one_time` on `window_date` with `opens_time` / `closes_time` equal to the row's, a `wellness` schedule's
     `test_version_id` is the active WELLNESS version, and the event row is written in the same transaction
     (`written_in_this_transaction`, so v49's `events_need_change` requires the audit); an update only ends a live row
     once (every other column write-once); delete refused.
   - `calendar.events.external_schedule_id` stays the RPE link the card reads: an RPE question sets it and clears it
     when it ends (the existing `events_one_planned_per_external_schedule` index still holds).
4. **`calendar.question_postponements`** — *Later* (plan 3.4): `id`, `question_id references calendar.event_questions`,
   `athlete_id references public.athletes`, `performed_by_user_id references public.users`, `request_key uuid not null`,
   `created_at`; unique `(performed_by_user_id, request_key)` (the row is its own request record). Append-only. Insert
   guard: the user is the athlete's own `athletes.user_id`, the question is live, and the athlete has an assignment of
   the question's schedule whose window is open now and that is not answered.
5. **`calendar.day_off_assignment_skips`** (⚑ new, not named in the plan; the record of plan 8's two effects):
   `assignment_id uuid primary key references tests.test_assignments on delete restrict`, `event_id references
   calendar.events`, `athlete_id`, `reason check in ('skipped','cancelled')`, `created_at`. Append-only. `skipped`: the
   Tests function made the day's assignment as `cancelled` because a Day off reaches the athlete; `cancelled`: a Day off
   command cancelled an open, unanswered one.
6. **The runner's operations:** `calendar.event_requests.operation` and `event_changes.kind` CHECKs gain
   `ask_question`, `remove_question`, `move_question` (the questions carried by `create` / `update` use those ops' own
   names). The widened `varchar(20)` holds them.
7. **`tests.test_schedules.skip_days_off boolean not null default false`** (existing schedules keep today's behaviour;
   the form ticks it by default, plan 8). CHECK: true only for `schedule_kind = 'recurring'` with `freq = 'daily'`.
8. **`tests.materialize_test_assignments_for_occurrence(uuid)`** — `create or replace`, **md5 precondition
   `2d961f5acd6c6309baa51de868773ba4`** (the phase-4 body; refused with `23514`-style `raise` if the live body differs).
   (Round 1b: its md5 after is `ef7e1093ca427ba0bf2f2bab120ba14f`, and v81 also replaces
   `training_load.materialize_external_assignments_for_occurrence` behind md5 `8410bf7298d6b3d5e4aea6dfb94e1a18`; see
   9.1.15, round 1b.)
   The new body is the phase-4 body plus one step, between the snapshot and the insert:
   - only when the schedule has `skip_days_off` and its owner club (club, or the team's club) has the switch on;
   - after the occurrence's `FOR UPDATE`, take `pg_advisory_xact_lock_shared(hashtextextended('calendar.day_off:' ||
     club || ':' || scheduled_date, 0))`;
   - an eligible athlete reached on `scheduled_date` by a planned event of kind `day_off` owned by the same club or one
     of its teams (the calendar's audience rule: an athlete target, or a team / club target with **membership on the
     day**, `calendarAccess.js` `membershipOnDaySql` written once as SQL function `calendar.athlete_reached_on_day(
     p_event_id, p_athlete_id, p_day)`) gets her assignment inserted as **`cancelled`** with a `skipped` row in
     `calendar.day_off_assignment_skips`; the others are inserted as today.
   - Why a `cancelled` row and not "no row": a snapshotted athlete with no row stays a candidate date for ever in
     `tests.resolve_current_target_dates` (`from_outstanding_snapshot`); the row closes it, and `cancelled` is already
     terminal, counted as *skipped* by the Tests overview and left out by the notification worker.
   - md5 of the new body: given in the phase-2 report.
   No other Tests or Training Load function is replaced.

#### 9.1.3 The commands and reads

All under `requireAuth`; the active workspace decides (`calendarEventAccess.js`). "The 404" is the identical
`404 {error: "notFound"}` of the event routes. Every write takes `requestKey` (uuid) and, for an event, `expectedRevision`.

| Method and path | Who | Body | Codes |
|---|---|---|---|
| `POST /api/calendar/events/:eventId/questions` (`ask_question`) | the event's writers (v49 bases) | `requestKey, expectedRevision, kind, window: {kind, date?, from?, to?}` | 200; 400 `invalid_question` / `invalid_window` / `window_one_day`; 404; 409 `event_changed`, `event_cancelled`, `question_already_asked`, `rpe_from_sessions`, `rpe_already_linked`, `wellness_already_scheduled`, `wellness_not_available`, `try_again`, `request_key_reused`; 503 `outcome_unknown` |
| `POST …/questions/:questionId/remove` (`remove_question`) | same | `requestKey, expectedRevision` | 200 (`removed` or `closed_early`); 404; 409 as above |
| `POST …/questions/:questionId/move` (`move_question`) | same | `requestKey, expectedRevision, window` | 200; 400; 404; 409 `questions_answered` and as above |
| `POST /api/calendar/events` / `PATCH …/:eventId` | as today | + optional `questions: [{kind, window}]` (create: the list; absent = the type's defaults when the switch is on; update: the desired list, diffed into ask / remove / move) | as today + the codes above; 409 `questions_off` when `questions` is sent and the switch is off (⚑ not 404: the event itself is readable) |
| `GET /api/calendar/events/:eventId/questions` | a manager of the event | — | 200 `{questions:[{id, kind, window, status, counts:{asked, answered, later, notAnswered}, answered:[{athleteId, name}], later:[…], notAnswered:[…]}]}`; the 404 for anyone else and while the switch is off |
| `PUT /api/calendar/settings/questions` (`questions_switch`) | platform admin in the club's workspace | `requestKey, enabled, reason` | 200; 400 `invalid_reason`; 404 for everyone else; 409 `try_again`, `request_key_reused`; 503 |
| `GET /api/calendar/settings` | as today | — | + `questions: {enabled, updatedAt}` for the club's admin and a platform admin; types carry `defaultQuestions` only while on |
| `PATCH /api/calendar/settings/types/:typeId` | as today | + optional `defaultQuestions: []` | as today; 409 `questions_off` when sent while off |
| `GET /api/calendar/questions/mine` | an athlete (her own) | — | 200 `{questions:[{questionId, kind, eventTitle, eventDay, eventStart, window:{opensAt, closesAt}, form:{kind:'rpe', externalAssignmentId} or {kind:'wellness', assignmentId}, later: bool}]}`; open = window open now, not answered, live question, switch on; `[]` for anyone else |
| `POST /api/calendar/questions/:questionId/later` | the athlete | `requestKey` | 200; 404 not hers / unknown / switch off; 409 `question_not_open`; replay of the same key → the saved answer |
| Tests `POST /api/tests/schedules` / `PATCH` | as today | + `skipDaysOff` | 400 `skip_days_off_unavailable` when true and the schedule is not daily or its club's switch is off |
| Tests `PATCH` / `DELETE` / pause; TL external-schedule `PATCH` / pause / resume / cancel / schedule-again | as today | — | **⚑ new:** 409 `schedule_managed_by_calendar` for a schedule a live question names (it changes only through its event) |

- **The window** (plan 3.3), in the event's `timezone`, on the event's last day `L = coalesce(end_day, day)`:
  `after_event` = `L`, from `end_time` (18:00 when the event has no `end_time`, O2) to 23:59; `next_morning` = `L + 1`, 07:00–12:00; `custom` = a date in `[day, L + 1]`, `from < to` on
  that date (else `window_one_day`, "Answers can be collected within one day for now."). An `after_event` whose end is
  23:59 or later is `invalid_window`.
- **The schedules a question writes** (through the extracted helpers, 9.1.7): `one_time`, `start_date = end_date =
  window_date`, `opens_time` / `closes_time` from the window, `due_time` null, the event's `timezone`, owner = the
  event's owner, targets = the event's targets (athlete / team / club, copied), `status active`. RPE:
  `event_name` = the event's title, no notification rules. WELLNESS: the active WELLNESS version.
- **Messages** to a coach or an athlete are one plain sentence, no code or id; the codes are for the client.

#### 9.1.4 The lock order and the transaction

- **Every question write runs in `runCalendarCommand`** (`calendar.event_requests`, or `settings_requests` for the
  switch), so it has the requestKey replay after the locks, the request + change pair required at COMMIT, the 15 s
  bounded COMMIT and *Result not confirmed* (`503 outcome_unknown`). *Later* is its own small transaction (its row is
  the request record) with the same bounded COMMIT.
- **The one order** (calendar → Training Load → Tests → the Day off locks), all taken in `prepare` / at the start of
  `apply`, **before the first write**:
  1. `calendar.lock_event_writer` (v54: users first, role, owner team / club `FOR SHARE`), then the event row
     `FOR NO KEY UPDATE` (the runner's `prepare`; **corrected in review round 1**, it was `FOR UPDATE`, 9.1.15 H1);
  2. `calendar.club_question_settings` of the owner club `FOR SHARE` (the switch read once, held);
  3. the event's live `calendar.event_questions` `FOR NO KEY UPDATE`, ordered by id (corrected in round 1, as step 1);
  4. Training Load: the linked `external_schedules` row `FOR UPDATE` → its `external_schedule_occurrences` `FOR UPDATE`
     (id order) → its `external_assignments` `FOR UPDATE` (id order), then the `session_feedback` read ("answered");
  5. Tests: the linked `test_schedules` `FOR UPDATE` → `test_schedule_occurrences` `FOR UPDATE` → `test_assignments`
     `FOR UPDATE` → `test_assessments` `FOR SHARE` (id order each);
  6. only for a command that makes or moves a planned *Day off* (create, an update of its days or type): the
     exclusive `pg_advisory_xact_lock('calendar.day_off:<club>:<day>')` for each day of its span, ascending, then the
     open, unanswered `test_assignments` it cancels `FOR UPDATE` (id order).
  - The Tests side takes schedule (`FOR SHARE`, `ensureCurrentOccurrence`) → occurrence (`FOR UPDATE`) → the shared
    advisory lock (step 6's key) → inserts. **Corrected in review round 1:** the claim that neither can deadlock the
    other was wrong while steps 1 and 3 were `FOR UPDATE`: the materialization's skip row has real foreign keys to the
    event and the question, whose checks take `FOR KEY SHARE` on rows the command held `FOR UPDATE` while it waited for
    the key the materialization held (probe R3, a `40P01`). With `FOR NO KEY UPDATE` those checks never wait on the
    command, so a Day off and a materialization serialize on the day's key alone: a Day off committed first is seen by
    the next statement of the materialization; a materialization committed first leaves rows the Day off then sees.
  - A lock refusal (`55P03` after 15 s) or `40P01` is `409 try_again`, nothing written.
- **Proof required (the rule of PR #346):** a test records the SQL each question command sends and asserts no locking
  clause after the first write, and the order of steps 1–6.

#### 9.1.5 One RPE channel, never WELLNESS twice, cancel and move

- **RPE (plan 2.1):** an event with a live planned-session link answers `rpe_from_sessions` to an RPE ask (and its
  create / type default skips RPE silently, saying so in the answer's `questionsSkipped`); an event whose
  `external_schedule_id` was set by `set_schedule` (not by a question) answers `rpe_already_linked`. `attach_sessions`
  / `align_sessions` on an event with a live RPE question: nobody answered → the question ends `replaced_by_sessions`,
  its schedule is cancelled and the link cleared in the same command; somebody answered → `409 rpe_already_answered`
  ("Athletes have already answered this event's RPE. Remove the session link or keep the event's own RPE.").
  "Answered" = a `session_feedback` row with `external_assignment_id` of the schedule.
- **WELLNESS never twice on a day (plan 8):** an ask (or a move) of WELLNESS on `window_date` answers
  `wellness_already_scheduled` ("Today's WELLNESS already covers this day.") when an active Tests schedule of the
  WELLNESS version, owned by the same club or one of its teams, covers that date (one-time on it, or daily over it) and
  its targets resolve to an athlete the event reaches — except a daily schedule with `skip_days_off` when the event is
  a *Day off* (it skips that day). The reverse (a daily schedule created over a day that already has an event's
  WELLNESS) is **not** guarded in 2a-1 (open question O3).
- **Cancel (plan 3.5):** `cancel` ends every live question `event_cancelled` and cancels their schedules
  (`status = 'cancelled'`, the module's own cancel), answers stay.
- **Move:** an `update` that changes `day`, `end_day`, `start_time`, `end_time` or `timezone` of an event with live
  questions: nobody answered any → each question is moved (old row `moved`, its schedule cancelled, a new schedule and
  row with the window recomputed; a `custom` date outside the new `[day, L + 1]` → `invalid_window`); somebody answered
  → `409 questions_answered` ("Athletes have already answered this event's questions."). `move_question` is the same
  for one question's window.
- **Remove:** unanswered → `removed`, schedule cancelled; answered → `closed_early`, schedule cancelled, answers stay.
- **A Day off made after the assignments exist** (create of a `day_off` event, or an update that turns an event into
  one or widens its days): in the same command, the open, unanswered (`pending` / `open`, no assessment) WELLNESS
  assignments of `skip_days_off` schedules of the same club, whose `local_scheduled_date` is in the span and whose
  athlete the event reaches, become `cancelled` with a `cancelled` skip row. A Day off cancelled or moved away restores
  nothing already cancelled (terminal); a day whose assignments do not exist yet comes back by itself.

#### 9.1.6 The notifications

- `public.app_notifications`, written **in the command's transaction** (as `notifyPlanAssignments`), one per athlete
  of the recipients below:
  - `calendar_question_asked` on ask (and on create / update that asks): title "Your coach has a question", body e.g.
    "How did Training go? Answer after 18:00 today." (the window in the event's time zone), `entity_type 'calendar_event'`,
    `entity_id` the event, metadata `{eventId, questionId, kind}`, dedupe `calendar:v1:question_asked:<questionId>:<athleteId>`;
  - `calendar_question_moved` on a move: dedupe `calendar:v1:question_moved:<newQuestionId>:<athleteId>`.
  - Nothing on remove or cancel (the open item disappears from her list).
- **The recipients (the manager's A2):** the event's audience on the question's `window_date` (the calendar's audience
  rule, membership on that day), each athlete with a `user_id`.
- The realtime `notifications_changed` event is sent **after the COMMIT** only: `runCalendarCommand` gains an optional
  `afterCommit(out)` hook, called once the COMMIT answered (and on the verified-after-commit-error path), never on a
  replay.

#### 9.1.7 The extracted helpers

- `backend/src/testsScheduleWriter.js`: `insertScheduleRow`, the targets insert and the WELLNESS defaults, moved out of
  `routes/tests.js`; `POST /api/tests/schedules` and the calendar both call it.
- `backend/src/externalScheduleWriter.js`: the external schedule, targets and (empty) rules insert of
  `POST /api/training-load/external-schedules`, and its cancel statement.
- A test creates a schedule through each module's own route and through a calendar question with the same input and
  compares the rows (every column but ids and timestamps).

#### 9.1.8 Preflight, post-check, rollback (`docs/runbooks/`, after `calendar-settings-v51.md`)

- `calendar-questions-v81.md`, `-preflight.sql`, `-postcheck.sql`, `-rollback.sql`.
- **Preflight** (read-only, block by block): the dependencies of 9.1.1 recorded with their checksums; v81 not recorded;
  no v81 object; the md5 of `tests.materialize_test_assignments_for_occurrence`, `calendar.settings_changes_before_insert`
  and `calendar.lock_event_writer` as named; the Tests schema present; v75 / v78–v80 recorded or not (information); a
  quiet moment (no idle transaction, no lock wait on `calendar.*` / `tests.*`).
- **Post-check:** v81 recorded once with the file's sha256; every object, CHECK, index and trigger, enabled; the two new
  md5s; zero rows in the new tables, no switch row, no `skip_days_off = true`; system types' `default_questions` null.
- **Rollback** (forward-only once used): refuses if any row exists in `club_question_settings`, `event_questions`,
  `question_postponements`, `day_off_assignment_skips`, any `skip_days_off = true`, any request / change of the new
  operations; refuses if a migration recorded after v81 **has `calendar` or `tests` in its file name** or if the two
  replaced function bodies no longer have v81's md5 (a later migration touched them); otherwise restores the phase-4 and
  v51 bodies (checked by md5 after), the CHECKs, drops the column, the tables, functions and the migration row.
  Rehearsed on a disposable database: apply → rollback → identical `calendar` / `tests` catalog → apply again.

#### 9.1.9 Not in 2a-1

The screens (2a-2, 2a-3); push; the workers' schedule; a window across midnight; questionnaires other than WELLNESS;
Metrics Core. **The fix** of plan 5 (`missed` on a folded Tests card from the window's close) is in 2a-1, in
`calendarQuery.js`.

#### 9.1.10 The test plan

One new suite `backend/tests/central-calendar-k2b2-questions.test.mjs` (calendar fixture, real app over HTTP), and
`central-calendar-k2b2-migration.test.mjs` (the migration, its md5 gate and rollback):
1. the migration applies on the fixture list (no v78–v80 there) and on one with every `migrations_v2` file through
   v77 (all present on `main`); the md5 gate refuses a changed body; the rollback restores the catalog exactly and
   refuses for each refusal condition; the preflight and post-check blocks return the expected values;
2. every basis (platform admin, club admin, team coach, private coach → 404, athlete, another club, revoked role) on
   every command and read; the identical 404 while the switch is off;
3. the switch: platform admin only, reason required, the change row, the replay;
4. requestKey replay, another body → `request_key_reused`, a lost COMMIT (verified and unknown) on ask and *Later*;
5. the schedules equal to the modules' own create routes (9.1.7);
6. RPE's one channel (all four branches of 9.1.5); WELLNESS never twice (with and without a Day off);
7. cancel, move (answered / unanswered, custom out of range), remove (removed / closed early);
8. late joiners (a member added after the snapshot is not asked; one who left before it is not);
9. *Later*: only her own, only open, the replay;
10. the notifications written in the same transaction (a forced failure after them leaves none), the dedupe, the
    realtime only after COMMIT;
11. the counts and the three lists;
12. the Day off: skipped at materialization (with the `skipped` row), cancelled by a later Day off (only open,
    unanswered, same club, reached on the day), a Day off cancelled before the day brings it back, the switch off or
    `skip_days_off` false changes nothing; a concurrent Day off and materialization (both orders) end consistent with
    no `40P01`;
13. the recorded SQL lock order (9.1.4);
14. the Tests and TL routes refuse a calendar-managed schedule;
15. the `missed` fix.
- Plus: `--filter central-calendar`, the `tests-*` and `training-load-external-*` suites, `--preset backend-fast`
  compared with a clean `origin/main`.
- **Mutations** (each restored by copying the file back): the switch check in the event-question guard; the owner match;
  the one-live index; the postponement's own-athlete check; the day-off skip's switch / flag / same-club / on-day
  conditions; the advisory lock in the function and in the command; the answered checks of move / remove / attach; the
  replay's hash compare; the notification's transaction (moved after COMMIT).
- **Review triggers met:** 1 (a migration) and 4 (transactions, lock order, idempotency); trigger 2 in part (rights on
  the new routes), so `code-reviewer`, `db-reviewer`, `security-reviewer`, the independent review and the owner's
  external review (plan section 6).

#### 9.1.11 Rights summary

- Ask / remove / move / panel: the event's writers by v49's bases, on the locked row, only while the owner club's switch
  is on; a private coach's event has no club → the 404.
- The switch: an active platform admin in the club's workspace; the club's admin reads it.
- Type defaults: the club's admin and a platform admin (as `type_update`).
- An athlete: her own open questions and her own *Later*; nothing about another athlete.

#### 9.1.12 Deviations from sections 2–8, and open questions for the GO

- ⚑1 `calendar.event_questions` for both kinds instead of `event_questionnaires` (WELLNESS only); RPE still sets
  `events.external_schedule_id`.
- ⚑2 `default_questions` null = derived from `default_expects`; no seed rewrite.
- ⚑3 v81 needs the Tests schema; real FKs; not in `GPEXE_TEST_MIGRATIONS`.
- ⚑4 `calendar.day_off_assignment_skips` and the skip as a `cancelled` assignment row.
- ⚑5 `409 questions_off` (not 404) for `questions` / `defaultQuestions` inside an existing command while the switch is
  off.
- ⚑6 Tests and TL routes refuse a calendar-managed schedule (`schedule_managed_by_calendar`).
- ⚑7 The Day off effect is limited to schedules and events of the **same club** (a team's club included); a private
  coach's or another club's Day off never skips a club's WELLNESS.
- **O1:** is ⚑5 acceptable, or should those commands ignore the field while off?
- **O2:** the `after_event` window when the event has a start but no end: 18:00 as plan 3.3 says (proposed), not the
  start time.
- **O3:** the reverse of "never twice" (a daily WELLNESS schedule created over a day that already has an event's
  WELLNESS): 2a-1 does not guard it; the proposal is a later step (Tests form warning) — or should the Tests create
  route refuse it now?

#### 9.1.13 The manager's GO (2026-11-18)

Recorded verbatim (the calendar manager's message to the executor, GO on 9.1 at `96458cb5`):

> **GO for K2b-2a-1** on 9.1 at `96458cb5`, with the decisions below.
>
> Deviations:
> - ⚑1 one `calendar.event_questions` table for both kinds, RPE still setting `events.external_schedule_id`: **accepted**.
> - ⚑2 `default_questions` null = derived from `default_expects`, no seed rewrite: **accepted**.
> - ⚑3 v81 needs the Tests schema, real FKs, only in the calendar fixture list: **accepted**. Confirm in the report that every suite that applies v81 has the Tests schema.
> - ⚑4 the skip as a `cancelled` assignment plus a skip row: **accepted, with a renamed table** (see O3): `calendar.question_assignment_skips`, `reason in ('day_off', 'day_off_cancelled', 'covered_by_event')`. In the report, prove that a `cancelled` insert passes every Tests CHECK and trigger, and that the Tests overview, the notification worker and `resolve_current_target_dates` treat it as you describe (tests, not reading).
> - ⚑5 `409 questions_off` inside existing commands while the switch is off: **accepted** (O1). Its message is one plain sentence: "Questions for athletes are not turned on for this club."
> - ⚑6 `schedule_managed_by_calendar` on the Tests and TL edit, pause, resume, cancel, delete and schedule-again routes: **accepted**. The manual *Remind* routes (Tests `POST /schedules/:id/remind`, TL `POST /external-schedules/:id/remind`) stay **allowed**, since they change nothing of the schedule; pin that with a test. The message: "This question belongs to a calendar event. Change it on the event."
> - ⚑7 the Day off effect only within the same club (a team's club included): **accepted**.
>
> Open questions:
> - **O2:** without an end time, `after_event` opens at the **later of 18:00 and the event's start time**, and closes at 23:59. If that start is 23:59 or later → `invalid_window`.
> - **O3:** guard it **now, at materialization**. A daily WELLNESS assignment is made `cancelled`, with a `covered_by_event` skip row, when:
>   - the schedule is of a club whose switch is on;
>   - the athlete has, on that date, a live event WELLNESS question whose event reaches her (by the same audience rule as the Day off).
>
>   This holds whatever `skip_days_off` says, so one day never asks WELLNESS twice in either order. The ask (and a move) of an event WELLNESS question takes the same exclusive `calendar.day_off:<club>:<day>` key for its `window_date`, so it serializes with materialization. Rename the key if you like, but keep one key per club and day. Test it in both orders and concurrently, with no `40P01`. Removing an event's WELLNESS before its day brings the daily day back by itself, because it is not materialized yet; test that too.
>
> Two additions:
> - **A1:** `GET /api/calendar/questions/mine` must make sure the day's occurrence and her assignment exist for each question whose window is open. Use the same on-demand generation athlete Today already does: Tests `ensureCurrentOccurrence`, and the TL occurrence generation. Otherwise `form.assignmentId` / `externalAssignmentId` can be missing exactly when she opens the app. Test that a fresh day returns usable form ids.
> - **A2:** the notification's recipients are the event's audience on the question's `window_date` (membership on that day), each with a `user_id`. Say so in 9.1.6.
>
> Everything else in 9.1 stands. When phase 2 is green, send the report as the brief says. Include the migration's sha256 and the md5 before and after of every replaced body, because the OptiMove manager reads them read-only on production before the owner's merge order.

Consequences for 9.1 (the executor): the skip table of 9.1.2 item 5 is `calendar.question_assignment_skips` with the
three reasons above; the per-club, per-day key is renamed `calendar.wellness_day:<club>:<day>` (one key per club and day,
taken by the Day off command, the WELLNESS ask / move and the materialization).

#### 9.1.14 As built (the executor, phase 2): what differs from 9.1 and 9.1.13

- **One more dependency:** Training Load v7 (`202609020900_..._v7_external_schedule_notification_rules.sql`): an RPE
  question writes the schedule's three worker rules, all off, as the module's own create route does. The preflight
  checks it, and the calendar fixture (`backend/tests/support/calendar-fixture.mjs`) now applies v7 too.
- **The RPE schedule's shape is the module's own one-time shape:** `end_date` null (POST /external-schedules writes
  none for a one-time schedule); the guard accepts null or the window's day.
- **WELLNESS never twice, as built:** an ask or move is refused when an athlete the event reaches on that day already
  has a non-cancelled WELLNESS assignment of a schedule of the same club (not of a cancelled schedule), or another live
  event WELLNESS question of the club on that day reaches one of the same athletes. A daily (or one-time, not
  question-linked) schedule not yet materialized for the day is not a conflict: its materialization makes the day
  `cancelled` with `covered_by_event` (O3).
- **What moves a question:** a change of the event's day, end day, start, end, time zone **or targets** (the schedules
  copied the targets). Nobody answered: moved; somebody answered: `409 questions_answered`.
- **Switch turned off after asking:** cancel, remove and the panel keep working for what exists (the panel and the
  three question commands are the 404 while off); an event move then ends its unanswered questions `removed` instead
  of asking again.
- **Defaults on create:** the type's questions are asked with the *After the event* window. A default that cannot be
  asked (RPE with a schedule set by hand, a window that does not fit, WELLNESS already covering the day) is skipped and
  named in the answer's `questionsSkipped`; a question sent explicitly is refused instead.
- **The Tests PATCH** takes `skipDaysOff` on its own or with another change (the same rule as the create).
- **The fix of plan 5:** `central-calendar-k1a.test.mjs` test 13 asserted the old behaviour (an open assignment past its
  window was "missing"); it now asserts `missed`, as the accepted plan says.
- **Table name:** `calendar.question_assignment_skips`, reasons `day_off`, `day_off_cancelled`, `covered_by_event`;
  the advisory key is `calendar.wellness_day:<club>:<day>` (`calendar.wellness_day_key`).
- **One more helper function** than 9.1 named: `calendar.event_audience_on_day(event, day)` (the recipients of A2, the
  WELLNESS check).
- **B1 (the manager's decision, after the ★★ GO; no migration):** `GET /api/calendar/events/types` (`eventFormOptions`)
  adds `questions: { enabled }`, the switch of the club it already resolves (the owner club, or the team's club; false
  for a private coach, the platform or without v81; nothing else of the switch), and on each type `defaultQuestions`
  (`typeQuestions`, the value a create without `questions` asks) only while it is on. `listEventTypes` is unchanged.
  Test 34; mutations C1 (another club's switch), C2 (`defaultQuestions` while off), C3 (on without a club). The pinned
  key list of `central-calendar-k2b-settings` test 0c gains `questions` (asserted off there, with no type defaults).
- **Tests full edit decides skip_days_off from the resulting kind; found by the 2a-2a code review** (HIGH: a daily
  schedule with `skip_days_off` edited to *Specific dates* broke v81's CHECK, a 500; MEDIUM: one_time → daily with
  `skipDaysOff: true` was judged on the stored kind, always 400). A toggle-only PATCH is unchanged; a full edit sets
  `skip_days_off` in its own UPDATE with `schedule_kind` (true only for a daily result with the switch on, else
  `400 skip_days_off_unavailable` with nothing written; not sent: kept for a daily result, else false). Test 35;
  mutations D1 (the reset dropped), D2 (judged on the stored kind), D3 (a separate statement before the UPDATE).

#### 9.1.15 Review round 1 (2026-11-18, on `d638b478`): every item and what was done

**HIGH**
- **H1, 40P01 (probe R3, reproduced by the independent review).** Fixed by the manager's option (1): the runner's event
  row lock (`calendarEventService.js`, `prepare`) and the live questions (`calendarQuestions.js`, `lockLiveQuestions`)
  are `FOR NO KEY UPDATE`. Why it is safe:
  - every event command still serializes on the event row: `FOR NO KEY UPDATE` conflicts with itself, with
    `FOR UPDATE` and with `FOR SHARE`, so two commands on one event wait for each other exactly as before;
  - what it no longer blocks is `FOR KEY SHARE`, the lock a foreign key check of another transaction takes (the skip
    row of a materialization, a question, a target). An event's key (its id) never changes (no command and no trigger
    updates it) and an event is never deleted (v49's `events_no_delete`), so nothing that relied on the lock needed
    the key to be stable against a concurrent key change; the same holds for `event_questions` (no delete trigger,
    only the end columns change);
  - the v51 triggers that lock the event row `FOR UPDATE` (`event_selected_fields_guard`) run inside an event
    command, after its own `FOR NO KEY UPDATE`: an upgrade in the same transaction. It can wait for a materialization
    that holds `FOR KEY SHARE` on the event, but that materialization waits for nothing the command holds (when the
    command has taken the day key exclusive, the materialization has not reached its skip row yet), so it is a wait,
    not a cycle;
  - the reads of the calendar take no lock; the settings commands do not lock events.
  - Test 21 reproduces R3 (a Day off widened by a PATCH held at a gate right after its row lock, while the day's
    materialization takes the key shared and writes its skip row), the WELLNESS ask on a Day off, the WELLNESS move
    while a `covered_by_event` row references the moved question, and the reverse order (the command held at its
    COMMIT, the materialization waiting on the key): no `40P01`. Mutations R1 (event row back to `FOR UPDATE`) and R2
    (questions back to `FOR UPDATE`) fail it.
  - **Also closed (found while writing this):** cancelling a Day off, or moving its days, now takes the exclusive day
    keys of its old span (a type change from Day off too), so a materialization never skips on a Day off that is being
    cancelled or moved at that moment. Test 30 records the keyed days before the first write; mutations R18 (cancel)
    and R19 (the move's old span) fail it.
- **H2, two RPE channels.** `PATCH` with `externalScheduleId` (another schedule or `null`) while an RPE question is
  live answers `409 rpe_from_question` ("This event already asks athletes for RPE. Remove that question first.");
  the database twin `calendar.events_rpe_question_link` (a `BEFORE UPDATE` trigger on `calendar.events`) refuses an
  `external_schedule_id` that differs from the live RPE question's schedule (the commands end the question before they
  change the link). Test 22 (8b): X and `null`, the link and the question unchanged, and the raw write refused.
  Mutation R4 (the twin removed) fails it; R3 (the service check removed) is equivalent, because the twin then gives
  the same answer.

**MEDIUM**
- **M1, stale athlete targets.** `calendar.athlete_member_of_owner_on_day(scope, club, team, athlete, day)` (new): an
  athlete target counts only while she is a member of the event's owner (the owner team for a team event, the owner
  club for a club event) on that day, by the calendar's membership-on-the-day rule. `athlete_reached_on_day` uses it
  (so the notifications, the panel, the Day off and `covered_by_event` all do), and the schedule's athlete targets are
  written only for those athletes (`askableTargets`). Nobody left: `409 no_athletes` ("Nobody on this event can be
  asked on that day."); a type default with nobody to ask is skipped. Test 23. Mutations R5, R6.
- **M2, no day key on ending a WELLNESS question.** The `window_date` of every WELLNESS question being ended (remove,
  a move's old day, an update) joins the exclusive key set, ascending and de-duplicated; a cancel takes the keys of its
  live WELLNESS questions. Test 29 (the recorded SQL: the key before the first write). Mutations R7, R8.
- **M3, check-in links.** `cancelTestSchedule` revokes the schedule's active `tests.test_access_links` with
  `revoked_by_user_id`, as the module's DELETE does. Creating a link on a calendar-managed schedule stays allowed.
  Test 24 (12b). Mutation R9.
- **M4, missing proofs.** (a) test 25: realtime 0 calls when `beforeCommit` throws, exactly the athletes' users after
  an ask, 0 on a replay (a test seam `testHooks.emitRealtime`); mutation R12. (b) test 26: a team period that starts on
  the window's day is notified, one that ended before it is not; mutation R14. (c) test 26: a late joiner is not asked
  and not counted. (d) test 27: an athlete of two clubs with the other club's WELLNESS that day is still asked;
  mutation R13. (e) test 28: Remind answers 200 with `notifiedCount` 1 and the assignment `notified`, for both
  modules. (f) test 28: *Later* while the switch is off is 404. (g) test 28: `wellness_not_available` (the fixture
  archives the WELLNESS version, then restores it with the Tests module's freeze trigger off on the disposable
  database only).

**Decisions applied**
- The skip is not reversed: a known limit, recorded in 3.5 and in the runbook.
- While the switch is off, `remove_question` keeps working for the event's writers; ask and move stay 404 (test 28,
  mutation R10).
- A Day off for a past day cancels only assignments whose window has not closed (`closes_at > now()`); a past day
  stays missed (test 28). The filter sits in the candidate lock and again in the cancel: R11 (the cancel's filter
  only) is equivalent while the candidate lock filters; R11b (both removed) fails test 28.
- Recorded with no code: deviation 4 (a change of targets is a move, refused once answered); notifications go to the
  audience known at ask time (a later joiner is asked in the app but not notified); a PATCH of `skip_days_off` takes no
  day key.

**LOW**
- db L1: the migration checks in its first `do` block that its eight dependencies are recorded by name and the
  repository's checksum (test 2; mutation R17).
- db L2: `.gitattributes` binds `docs/runbooks/calendar-questions-v81*.sql` to `eol=lf`; `migrations_v2/**` was already
  covered.
- db L3: the rollback also checks `calendar.lock_event_writer`'s md5, and a "later" migration is later by name **or**
  by `applied_at` (the runner's column) (test 3; mutations R15, R16).
- db L4: `skipDaysOff` with a non-WELLNESS test is refused by the Tests route (`400`, the route accepts WELLNESS only;
  test 28). Rules the database does **not** enforce (service or function only):
  - the skip table: that the event is a Day off, or the question covers that day, and that it reaches the athlete on
    the assignment's day (the materialization and the Day off command are its only writers; the database checks the
    reason / question shape, the athlete and that the assignment is `cancelled`);
  - the window: what *After the event* / *Next morning* / *Custom* mean (from the event's end, 07:00–12:00 the next
    day, the event's days or the day after); the database checks one day (`opens_time < closes_time`) and that the
    schedule is exactly the question's window;
  - `skip_days_off` for WELLNESS only, and the switch on when it is set (the route; the materialization re-checks the
    switch every time); the database checks daily-only.

**Round 1b (2026-11-18, on `43b8ca93`): the narrow re-reviews' one MEDIUM and one LOW**
- **MEDIUM (security; M1 was closed only at ask time).** An athlete target who passed `askableTargets` at the ask and
  whose membership ended before the window's day was still asked on that day: the module resolvers
  (`tests.resolve_schedule_target_athletes`, `training_load.resolve_external_schedule_target_athletes`) list her
  without a membership check, `ensureCurrent*` made her assignment, and `calendar.question_open_for` checked only that
  the assignment existed. Fixed in three places:
  1. `calendar.question_open_for` also requires `calendar.athlete_reached_on_day(event, athlete, q.window_date)`
     (so the *Later* route and its database guard `question_postponements_open` refuse her);
  2. `ASKED_SQL` (`calendarQuestionService.js`) keeps only athletes the event reaches on the question's `window_date`:
     the panel's lists and counts, `/questions/mine`'s candidates and *Later*'s "hers" check;
  3. the materializations make **no assignment** (not a `cancelled` one) for an athlete a live question's event does
     not reach on the question's day: `tests.materialize_test_assignments_for_occurrence` (md5 after:
     `ef7e1093ca427ba0bf2f2bab120ba14f`) and, newly replaced by v81 behind its own md5 precondition,
     `training_load.materialize_external_assignments_for_occurrence` (v4 body `8410bf7298d6b3d5e4aea6dfb94e1a18` →
     `a700c67786e79af8c03aae0b2d4a5fc3`). Why none rather than `cancelled`: a `cancelled` row is final and would show
     as a cancelled assignment in the Tests and Training Load views with no reason row explaining it; no row keeps the
     decision live (a membership restored the same day, or backdated, is asked at the next materialization), and the
     service filter alone would not stop the module's own answer form, which works from the assignment. The rollback
     restores the v4 body and checks both md5s; the preflight and post-check show it.

  Test 23b: (A) her periods end before the day, after the ask and before any occurrence: `/mine` empty for her, *Later*
  404 for both kinds, `counts.asked` 1 for both, no RPE or WELLNESS assignment (also after calling both modules'
  materializations again). (B) a backdated end after her assignments were made: `/mine` empty, `question_open_for`
  false for her and true for the one who stays, the raw postponement refused by `question_postponements_open`, *Later*
  404, not counted. Mutations B1 (the `question_open_for` condition), B2 (`ASKED_SQL`), B3 (the Tests filter) and B4
  (the Training Load filter) each fail it; B6 (the rollback's Training Load md5 check) and B7 (the migration's v4 gate)
  fail migration tests 3 and 2.

  **Known limit (B):** an assignment made while she was a member stays answerable on that day through the module's own
  form (the Tests or Training Load route, out of this piece); the calendar no longer offers, counts or postpones it.
  Only a backdated membership change reaches this state, since an assignment is made on its own day.
- **LOW (db): the club rule of `athlete_member_of_owner_on_day`.** For a club event, an athlete target counts through a
  `club` period of the owner club or a `team` period of one of its **active** teams, as `calendarAccess.js` does (it
  accepted any period with the club's `club_id`). Test 23c; mutation B5.
- **Recorded, no change:** the insert-side twin of `events_rpe_question_link` (db LOW-1: no command can insert an event
  with an RPE question already live); the *Later* replay before the ownership re-check (security LOW: the replayed
  answer is her own immutable record).
- **LOW (the RPE twin's insert side; the independent re-check and the db-reviewer).** `events_rpe_question_link` guarded
  only an UPDATE of `calendar.events`; a raw sequence in one transaction (end the RPE question → point the event at X →
  insert a live RPE question on Y) still left two channels. `event_questions_guard` now requires, for an RPE insert,
  `new.external_schedule_id` = the event's `external_schedule_id` (`23514`, constraint `event_questions_rpe_link`); the
  ask and create paths write the link before the question. Test 22 runs the raw sequence; mutation B8 fails it.
- **LOW (test 21's gate).** The gate sat right after the event-row lock, before the live-question lock, so reverting
  the questions to `FOR UPDATE` failed only test 15 (the SQL text). The gate now wraps the command's first day-key
  query, after both locks: R2 (questions back to `FOR UPDATE`) now fails tests 15 and 21, as R1 does.
- **NIT.** The comment at the top of `calendarEventService.js` and plan section 2 (around line 170) now say the event
  row is locked `FOR NO KEY UPDATE`.
- **After the independent ★★ GO on `c51a298b` (tests only):** LOW-1 is closed by test 31 (*Later*'s key reused with
  another body → `409 request_key_reused`, nothing written; mutation L1 fails it). INFO-2 is closed by test 32: each
  pre-v81 body (Tests phase 4, md5 `2d961f5a…`; Training Load **v4**, the only file that defines it, md5 `8410bf72…`) and
  each v81 body is created under another name from its file and proven by md5; on ordinary schedules (club, team and
  athlete targets, a joiner and a leaver; Training Load with the switch on and off, the WELLNESS schedule with the switch
  off, since with it on a live event WELLNESS question of the day covers it by design) both make identical rows. Mutation
  I2 (the test's v81 copy changed) fails it.
- **Test 33 (the manager's addition to INFO-2), the switch ON, in a club of its own:** (1) with no event question
  covering the day, the old and v81 Tests rows are identical and none is `cancelled` (the switch alone cancels nothing);
  (2) with a team event's WELLNESS question covering the day, exactly the athletes that event reaches on the day (the two
  team members and the joiner) are `cancelled` with a `covered_by_event` skip naming that question, nothing else in their
  rows changes, and the club-only athlete and the schedule's own athlete target stay identical to the old body. Mutation
  I3 (the test's v81 copy ignores the event's audience in the covered check) fails it.

### 9.2 RPE one channel for manual references (follow-up "RPE-1"; accepted 2026-11-19, 9.2.10)

**Why.** The independent review of #616 (INFO-1): an event can carry a manually referenced Training Load RPE schedule
(`calendar.events.external_schedule_id`, set by create or PATCH, not by a question) and, at the same time, live links to
planned sessions. Its athletes are then asked RPE twice, against plan 2.1 ("exactly one channel"). #614 holds the rule
only for a question-made schedule (`rpe_from_sessions`, `rpe_already_linked`, `rpe_from_question`). Read on `caa6b4b5`.

#### 9.2.1 What "the sessions are the event's RPE channel" means in the code

#614's definition, reused unchanged: **the event has a live planned-session link** (`Q.hasLiveSessionLinks`: a row of
`calendar.event_session_links` with `ended_at is null`), or, in a create, the command links sessions (`sessionsLinked`).
The session's own flags (`rpe_enabled`, `training_load_enabled`; the read's `asksRpe`) are **not** part of it.

- **Why not the flags (O1).** The flags change outside the calendar's locks: the Builder, the quick toggles, and the
  calendar's own align, which turns RPE on for every linked session of an event that expects RPE. A rule on the flags
  would be stale the moment a coach ticks RPE in the Builder. A rule on the link holds whatever the flags say. It also
  matches plan 2.1 ("when the event has planned sessions linked, its RPE is theirs") and #614.
- **A manual reference:** `events.external_schedule_id` is set and no live RPE question of the event names that
  schedule. A question-made schedule keeps #614's paths (`rpe_from_question`, and the attach's `replaced_by_sessions`).

#### 9.2.2 Every path where the two meet

| # | Command | State before | Answer | Where the check sits |
|---|---|---|---|---|
| 1 | `POST /events` (create, #616) | the body names `externalScheduleId` **and** `sessions` | `409 rpe_from_sessions`, nothing written | after the unlocked session read and `allLinkable` (an unavailable id still answers `session_not_available` first), **before** the plans' `FOR SHARE` locks; no lock of its own |
| 2 | `PATCH /events/:id` | the body sets `externalScheduleId` to a schedule other than the stored one (not `null`), and the event has a live session link | `409 rpe_from_sessions`, nothing written | right after `lockQuestionState` (beside #614's H2 check), under the event row lock; before `planQuestions` and the first write |
| 3 | `POST /events/:id/sessions` (attach) | the event has a manual reference | `409 rpe_already_linked`, nothing written | right after the live-question check, under the event row lock; **before** the unlocked session read and the plans' locks |
| 4 | `POST /events/:id/sessions/align` | the event has a manual reference **and** `expects` contains `rpe` (the align would turn RPE **on**) | `409 rpe_already_linked`, nothing written | after the event row lock, before the plans' locks |

- **Not refused:**
  - a PATCH that clears the reference (`externalScheduleId: null`) or leaves it as it is;
  - a detach;
  - an align that turns RPE **off** (`expects` without `rpe`), because it only reduces;
  - a create with only one of the two.
- **The way out for the coach** is always open: clear the reference (PATCH) or detach the sessions. The calendar never
  cancels or clears a manual reference by itself. Unlike a question's schedule, it is not the calendar's: a coach made
  it in Training Load, and other events may name it.
- **Path 1 is decidable from the body alone.** It still answers inside the command (409, after the session check), not
  as a 400 of validation. A refused request's key is therefore never stored, as for every other 409 of the runner.

#### 9.2.3 The refusal codes (no new code)

- `rpe_from_sessions`: "RPE comes from the linked sessions." (paths 1 and 2; #614's sentence)
- `rpe_already_linked`: "This event already collects RPE through another schedule." (paths 3 and 4; #614's sentence)

#### 9.2.4 Events already in that state

- **Nothing is rewritten.** No migration, no data fix, no automatic clear.
- **Every other command still works on them:** title, days, targets, a PATCH that keeps the reference, cancel, detach.
  Only paths 2–4 above refuse, and only when they would add or keep growing the second channel.
- **The read:** the manager view already shows both, `externalScheduleId` and `sessionLinks[]` with `asksRpe`. No new
  field is proposed (O2). A hint on the screen ("RPE is asked twice") would be a frontend slice of its own.
- **How many exist:** not known (the production database is not read by the executor). A read-only count the manager
  can run through its connector:

  ```sql
  select count(*) as both_channels
    from calendar.events e
   where e.status = 'planned' and e.external_schedule_id is not null
     and not exists (select 1 from calendar.event_questions q
                      where q.event_id = e.id and q.kind = 'rpe' and q.ended_at is null
                        and q.external_schedule_id = e.external_schedule_id)
     and exists (select 1 from calendar.event_session_links l where l.event_id = e.id and l.ended_at is null);
  ```

  Without v81 (before #614's deploy) the `event_questions` clause is dropped.

#### 9.2.5 A database twin: not proposed (recommendation)

- **Recommended:** a service-level guard only, no v82.
- **Reason 1, every writer serializes on the event row.** Every application write of both halves runs inside the
  event's command, under the event row lock (`FOR NO KEY UPDATE`, `prepare`):
  - `events.external_schedule_id`: create, update, attach's clear, and the question commands;
  - `event_session_links`: create, attach, detach, and cancel's end.

  A check read under that lock cannot race another command of the same event (verified by grep on `caa6b4b5`: no other
  writer of `event_session_links` exists, and no trigger writes either column).
- **Reason 2, a twin would be cross-table and transition-only.** It would need a trigger on both `calendar.events` and
  `calendar.event_session_links`, each reading the other table (a lock-order question of its own). It must also let the
  existing rows of 9.2.4 stand, refusing only the transition. #614's `events_rpe_question_link` is one table against
  rows the same commands write, which is why it was cheap.
- **What a twin would add:** protection against a raw SQL write, which ADR-003's rule already puts outside the contract.
- If the owner wants a twin anyway, it is a migration v82 or later on the owner's order, with its own runbook.

#### 9.2.6 Lock order

Unchanged. No new lock and no new write; each check is a read under locks the command already holds, before its first
write:
- create: writer lock, then the switch / questions (no event row yet), the unlocked session read, **check 1**, the plans
  `FOR SHARE`;
- update: writer lock, event row, switch, live questions, **check 2**, schedules, day keys;
- attach: writer lock, event row, switch, live questions, **check 3**, the plans `FOR SHARE`;
- align: writer lock, event row, **check 4**, the plans `FOR SHARE`, the sessions `FOR UPDATE`.

#### 9.2.7 Tests and mutations

Tests: one new test file, or tests in `central-calendar-k2b2-questions.test.mjs`, through the routes.
- **Path 1:** a create with `externalScheduleId` and `sessions` gives `409 rpe_from_sessions`. No event, no link and no
  request row is written. With either one alone the create succeeds (201).
- **Path 2:**
  - on an event with a live link, a PATCH to another schedule gives `409 rpe_from_sessions`, and the row is unchanged;
  - `null` clears it (200);
  - the same id, or a title-only PATCH on an event already in both states, succeeds (200).
- **Path 3:** an attach to an event with a manual reference gives `409 rpe_already_linked`, no link, and the plans are
  not locked (the recorded SQL has no `FOR SHARE` of `plans.plans`). After a PATCH to `null`, the attach succeeds.
- **Path 4:**
  - an align with `rpe` in `expects` and a manual reference gives `409 rpe_already_linked`, and no flag changes;
  - an align without `rpe` succeeds;
  - an event that is question-made (no manual reference) aligns as before.
- **#614's paths unchanged:** the question replaced by sessions, `rpe_from_question`, and a create with `sessions` plus
  a type default RPE that is skipped.
- **The recorded SQL of paths 1–4 (test 36b, after the code review's LOWs):** each check comes before the first write
  and takes no plan or session lock; a create with an unavailable session id still answers `session_not_available`
  first.

Mutations, each must be killed:
- each of the four checks removed;
- path 2 refusing on a `null` value;
- path 3 refusing a question-made schedule (the live-question exception removed);
- path 4 refusing an RPE-off align.

#### 9.2.8 Reviews

- **`code-reviewer`** on the whole diff.
- **No `db-reviewer`:** no migration, no new lock, no new write, no change to a transaction's statements other than
  refusals before the first write. If the GO wants a twin (9.2.5), `db-reviewer` comes in with the migration.
- **The independent review and the gate:**
  - the guard relies on the event row lock serializing two writers, which is trigger 4's subject (concurrency);
  - recommended: ★★ (the independent review and the manager's gate), even though no lock changes.

#### 9.2.9 Open questions for the GO (with the executor's recommendation)

- **O1, the definition:** any live session link (#614's), not the session flags. Recommended: the link (9.2.1).
- **O2, the read:** no new field for an event already in both states. Recommended: none in this slice.
- **O3, align:** refuse only an RPE-**on** align when a manual reference exists. Recommended: yes. Refusing every align
  would also block the reduction that helps resolve the state.
- **O4, the twin:** none; a service guard only. Recommended: no v82 (9.2.5).
- **O5, the count of existing events (9.2.4):** for the manager to run read-only, if the number matters for the order.

#### 9.2.10 The manager's GO (2026-11-19)

GO on 9.2 at `bbeeb2f3`, every recommendation accepted:
- **O1:** the live link is the channel, not the flags, consistent with #614 (an RPE question is already refused on any
  event with a live link, whatever the flags say).
- **O2:** no new read field.
- **O3:** only an align that turns RPE on is refused.
- **O4:** no DB twin and no v82, for the reasons in 9.2.5.
- **O5:** the OptiMove manager runs the read-only count; it is information only and blocks nothing.

Reviews: `code-reviewer` on a frozen head with the full packet, then the independent review and the OptiMove manager's
gate (★★, trigger 4). The manager opens the pull request.

### 9.3 A question's Tests schedule folds into its event (follow-up "Q-FOLD"; accepted 2026-11-19, 9.3.9)

**Why.** Found in the browser check of #625. When a coach asks WELLNESS on an event, the question's Tests schedule
appears in the calendar as its own "Scheduled test" card next to the event. An RPE question does not do this: it sets
`events.external_schedule_id`, and the read folds that schedule's day card into the event card. WELLNESS has no such
link, because `events.test_schedule_id` belongs to a `test`-kind event (v49) and the question's schedule is named only
by `calendar.event_questions.test_schedule_id`. Read on `912d669c`.

#### 9.3.1 What the read does today (`backend/src/calendarQuery.js`, `readCalendar`)

- **Test cards** come from two sources:
  - **Assignments** (`readTestAssignmentRows`), whatever the schedule's status. A cancelled schedule or occurrence
    gives `cancelled: true`.
  - **Projection** of schedule days that have no assignment yet (`readTestScheduleRows`), only for
    `status = 'active'`.
- **The fold of a referenced schedule** happens in the event-card loop, for `events.external_schedule_id` and
  `events.test_schedule_id`. The event card takes the schedule card's counts and per-athlete states, and the schedule
  card is deleted. It folds only:
  - for a **planned** event;
  - for a viewer who is **not the athlete** (the athlete's own request stays beside her reduced event card, plan
    section 5);
  - when **every** athlete of the schedule card is among the event card's athletes (otherwise `scheduleFold: separate`);
  - on a **day the event card is emitted for this viewer**: the loop runs over `eventDays` only (D16: a folded thing
    never disappears into a card that is not shown).
- **A question's WELLNESS schedule today, by question status.** The schedule is one-time, on `window_date`:
  - **live:** active. A projected card before the day, an assignment card on it. Shown, and this is the reported card.
  - **moved / removed / closed early / event cancelled:** the schedule is `cancelled`.
    - No projected card.
    - An assignment card only if the day's assignments were already made (on or after `window_date`), shown
      **cancelled**. For a closed-early question it carries the answers that came in.
- **`window_date` is not always an event day.** *After the event* is the event's last day, but *Next morning* is the
  day after and *Custom* may be the day after. On such a day there is **no event card**.
- **The athlete's calendar test card has no action.** In `frontend/central-calendar-view.js` a `test` card opens the
  panel only; no button leads to the Tests form. She answers through the Tests module and Home (K2b-2a-3, in progress).

#### 9.3.2 Which schedules fold (recommendation)

Every Tests schedule that **any** row of `calendar.event_questions` names (`kind = 'wellness'`, live or ended, whatever
`end_reason` is), **on its `window_date`, under the event card of the same event and day**, when that card is emitted
for this viewer.
- **Live:** folds. This is the case reported.
- **Ended** (`removed`, `moved`, `closed_early`, `event_cancelled`): folds too. Their card is a cancelled leftover of
  the event's own question, and the panel already accounts for it (ended questions are listed with `closed_early` /
  `event_cancelled`).
- **The event cancelled:** folds as well, unlike RPE's "a cancelled event folds nothing". The reason given there (the
  schedule keeps collecting) does not hold: cancelling the event cancels the question's schedule.
- **No "every athlete is listed" condition.** That rule protects the numbers moved onto the event card, and here no
  number moves (9.3.4). An athlete the question asked who is not on the card's list is still in the panel (the question
  lists who was asked).
- **A `window_date` without an event card** (*Next morning*, a *Custom* day after the event): the card **stays**, as
  today. Folding it would hide it on a day where the event does not appear (D16). This is open question **Q1**.

#### 9.3.3 Which viewers (recommendation)

Every viewer: managers, readers and the athlete (D21). This differs from RPE, where the athlete keeps her own request
card, because:
- her WELLNESS card has no action (9.3.1); she answers on Home and in Tests;
- one card per event on her day is the goal.

If K2b-2a-3 later makes the calendar card her way to the form, this is revisited (**Q2**).

#### 9.3.4 What the fold changes in the answer

- The test card is not emitted. **Nothing is added to the event card**: no count and no `scheduleFold.test` (which
  stays the `test`-kind event's own). D14 and contract 4.4 of K2b-2a-2 stand: one count per card, and the panel shows
  the question's answers as today.
- **Day summaries and statuses** are computed after the fold from the remaining cards, so a day with only the event
  plus its folded WELLNESS now counts one card. Its status comes from the event card, as for an RPE fold.
- **Filters** (club, team, athletes, kinds) are unchanged. With `kinds` without `event`, no event card is emitted, so
  the test card stays (D16). With `kinds` without `test`, there is nothing to fold.

#### 9.3.5 The SQL

- **One read per request**, in `readCalendar` after the test cards are built and before the event-card loop:

  ```sql
  select q.test_schedule_id, q.event_id, q.window_date
    from calendar.event_questions q
   where q.kind = 'wellness' and q.test_schedule_id = any($1::uuid[])
  ```

  `$1` is the schedule ids of the test cards already built. It is run only when there is at least one, and behind
  `select to_regclass('calendar.event_questions') is not null`, as `calendarQuestionService.js` does. Without v81 it
  returns nothing and the read is unchanged.
- **In the event-card loop:** for each emitted event day, the test cards whose schedule a question of this event names
  with `window_date` equal to that day are deleted (`cards.delete(`test:${scheduleId}:${day}`)`). There is no read per
  card.
- **Rights:** none involved. The query reads only ids of cards the viewer already gets, and it decides only to remove
  one of them.

#### 9.3.6 Tests and mutations

Tests (a new test in the k2b2 suite, through `GET /api/calendar`):
- A WELLNESS question (*After the event*, today) gives **one** card on the day, the event, for a manager, a reader and
  the athlete. No `test` card, no WELLNESS count on the event card, and its `scheduleFold.test` is `null`.
- **Ended:** removed, closed early (with an answer) and the event cancelled each give one card, the event (cancelled
  for the last).
- ***Next morning*:** the test card stays on the next day (no event card there).
- **Unchanged:**
  - an RPE question folds as before;
  - a `test`-kind event's own `test_schedule_id` folds as before, with `scheduleFold.test`;
  - a plain Tests schedule with no question keeps its card;
  - `kinds=test` without `event` keeps the card.
- **Day summary:** the day counts one item.

Mutations, each must be killed:
- the fold removed;
- folding on a day without an event card;
- folding a schedule no question names;
- folding only live questions;
- folding only for coaches.

#### 9.3.7 Scope and reviews

- **No migration and no frontend change.** The frontend renders what the read emits. The panel's question list
  (K2b-2a-2) is unchanged.
- **Reviews:** `code-reviewer`. This is not ★★: no lock, write, transaction or rights change, so none of the five
  external-review triggers applies.

#### 9.3.8 Open questions for the GO (with the executor's recommendation)

- **Q1:** on a `window_date` without an event card (*Next morning*), keep the test card (D16). Recommended: keep. The
  alternative, hiding it, leaves the coach no card for that day.
- **Q2:** fold for the athlete too, unlike RPE, because her calendar test card has no action. Recommended: yes.
- **Q3:** ended questions fold, and a cancelled event folds too. Recommended: yes.
- **Q4:** no coverage condition, since no number moves. Recommended: yes.

#### 9.3.9 The manager's GO (2026-11-19)

GO on 9.3 at `23d6064e`, all four recommendations accepted:
- **Q1:** a `window_date` with no event card keeps its test card (D16).
- **Q2:** the athlete folds too. Her WELLNESS card has no action, and K2b-2a-3 (PR #633) does not make the calendar
  card her way to the form; she answers through the Home card and the prompt.
- **Q3:** ended questions and a cancelled event fold as well.
- **Q4:** no coverage condition. The question's targets are the event's own, copied, and they move with the event.

Added to 9.3.6: one test that a reader's and an athlete's answer gains no new key (the fold only removes a card), and
that the athlete's card allowlist (D21) is unchanged. Review: `code-reviewer` on a frozen head (not ★★).

#### 9.3.10 As built

- `readQuestionTestFolds` (`calendarQuery.js`) does the one read of 9.3.5. The event-card loop deletes
  `test:<schedule>:<day>` for the questions of that event and day, for every viewer and every event status.
- **The read runs only when `kinds` contains `event`.** This is 9.3.4's "with `kinds` without `event` the test card
  stays", which the loop alone would not give: `kinds` is applied only when the days are assembled, after the loop.
  Mutation F6 removes the guard and fails test 37.
- **Observed, not changed:** the existing RPE and `test`-event folds delete the referenced schedule's card in the same
  loop without that guard. A request with `kinds=external` (no `event`) therefore omits an RPE schedule that a planned
  event folds, while a linked session stays (`foldsLinks` requires `event`). This predates Q-FOLD and is recorded for
  the manager.
  Closed by 9.4 (BE-FOLLOWUPS, item 3).
- **Test 37:**
  - one card for a manager (the club's admin), a reader (the team's coach) and the athlete, for a live question, and
    for removed, closed-early and cancelled-event questions, each on a team of its own (WELLNESS is never asked twice
    on a day);
  - with `kinds=test` the card stays;
  - *Next morning* keeps its card, in a window that also holds the event's day;
  - no new key on the event card, and the athlete's D21 allowlist exactly as before;
  - RPE and a plain schedule unchanged. The `test`-event fold stays covered by `central-calendar-k2a-events`.
- **Mutations:** F1–F5 of 9.3.6 and F6 (the `kinds` guard), all killed.

### 9.4 Backend follow-ups (2026-11-19)

Backend only, no migration, `code-reviewer` only. The manager decided all three items, so there was no contract round.
Branch `claude/central-calendar-backend-followups` from `origin/main` `b08cfb7f`.

1. **#614 LOW-1, the refusal order in the Tests full edit** (`backend/src/routes/tests.js`).
   - Before: a full edit from daily to `one_time` that sent `skipDaysOff: true`, on a daily schedule that already had an
     occurrence, answered `400 skip_days_off_unavailable` before the more fundamental `409 recurring_has_occurrence`.
   - Now: the skip decision runs after the `recurring_has_occurrence` block. Both are reads or locks, and nothing is
     written before either.
   - Test 38 of `central-calendar-k2b2-questions.test.mjs`: that body answers 409 `recurring_has_occurrence`, and the
     row is unchanged.
2. **#614 LOW-2, the toggle path checks the stored rule** (`skipDaysOffRefusal`).
   - The toggle path now passes the stored `recurrence_rule`. A `recurring` row whose `freq` is not `daily` answers
     `400 skip_days_off_unavailable`, where before it reached v81's CHECK `test_schedules_skip_days_off_daily` as a 500.
     Only a raw write can make such a row.
   - A create and a full edit write the daily rule themselves, so they do not pass it.
   - Test 39: a raw-written weekly row refuses `{skipDaysOff: true}` with a 400, and `skip_days_off` stays false. Turning
     it off still answers 200, and a daily row still toggles on.
3. **Q-FOLD's recorded gap, the `kinds` guard of the existing folds** (`backend/src/calendarQuery.js`).
   - Before: the RPE (`external_schedule_id`) and test-event (`test_schedule_id`) folds ran without checking `kinds`. A
     `kinds=external` request therefore dropped an RPE schedule card that a planned event folds, although no event
     card was emitted (against D16).
   - Now: `folds` also requires `kinds.has("event")`, the guard Q-FOLD's own fold uses.
   - **This reverses a recorded "by design" behaviour.** The K2a plan's LOW 1 (the owner's external review of PR #298)
     and the K2a-2 plan's note said that with `kinds=external` alone the folded card is not shown. The screen never
     sends `kinds` (K2a-2 plan), so only API callers see the change.
   - Test 10 of `central-calendar-k2a-events.test.mjs` pinned the old behaviour and is updated. `kinds=external` keeps
     the RPE card with its own counts, and `kinds=test` keeps the test-event schedule card. With `event` in `kinds`
     (`event`, `external,event`, `test,event` and the default), the folds behave as before.
   - The K2a plans' entries (`central-calendar-k2a-plan.md` sections 7 and K2a-2's row,
     `central-calendar-k2a-2-plan.md`) are marked superseded by this section (`code-reviewer`'s LOW).
   - The screen still filters its chips in the browser over the folded answer (`frontend/central-calendar-view.js`),
     so with only *RPE requests* on, a folded RPE card is not shown there. That would be a small frontend task of its
     own; it is not part of this one.
   - **FE-D16, as built (branch `claude/central-calendar-fe-d16`, frontend only):** while the chosen types are only
     kinds other than *Events* (no event type either), the screen also reads the range with `kinds=<chosen>` (in the
     chips' order) under its own cache key, and draws the cards and the open panel from that answer; the unfiltered
     read stays (the teams, the workspace, the events of the link suggestions, the chips' counts; a chosen kind
     counts what it shows). The panel's athletes are read with the same `kinds`. Choosing *Events* or an event type,
     or *All types*, goes back to the unfiltered answer without a request; a panel whose card the new answer does not
     hold closes quietly (a refresh keeps its "no longer on this day" note); a failed refresh of the kinds read over
     cards on screen says so. Tests: `central-calendar.actions` FE-D16, FE-D16b, FE-D16c and FE-D16d; e2e
     `central-calendar-kinds-fold.test.mjs` (1280, 390, 375 and 360 px). The follow-up tests (branch
     `claude/central-calendar-fe-d16-tests`): FE-D16e (a late kinds answer is dropped), FE-D16f and FE-D16f2 (a voided
     kinds read is read exactly once more, never a third time), FE-D16g (a types change never closes a panel over an
     open form, also from the cache; `central-calendar-events.actions`, whose fake now honours `kinds`), and the two
     pins below. Known limits (`code-reviewer`'s LOWs, recorded):
     - kinds mode shows a panel only for a card it shows: an event created while only *RPE requests* is chosen gets
       its "created" line, but no open panel (its card is filtered out). Pinned by FE-D16h
       (`central-calendar-events.actions`): a fix changes that test on purpose;
     - with an event type chosen next to *RPE requests* the read stays unfiltered, so a request folded into an event
       of another type shows nowhere. A fix is a `kinds=external,event` read with the type filter in the browser, or a
       server-side event-type filter; not part of FE-D16. Pinned by FE-D16i (`central-calendar.actions`): a fix changes
       that test on purpose.

Mutations: one per item, each killed (the executor's report has the details).
