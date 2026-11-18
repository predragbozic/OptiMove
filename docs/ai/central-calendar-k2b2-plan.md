# Central calendar — K2b-2 plan: *Ask athletes* on an event (D40)

Status: **proposed (2026-11-18).** Q1 is decided (section 6); Q2–Q6 are open. No code, no migration. Written by the
calendar stream's manager against the checked-out code at `946914f4` (`main`, PR #603 merged). No persistent database
was read.

D40 (the owner, 2026-11-02; `docs/ai/central-calendar-k2b-plan.md` section 10 and D40): questions to athletes go **only
through the Tests module**. K2b-2 is *Ask athletes* on an event: a questionnaire from the Tests library is scheduled in
one click for the event's athletes, with a window after the event; the answers live in Tests and show on the event's
card; and the Tests parameters are **mapped into Metrics Core** so the answers reach the Training Load dashboards (no
new registry; `.claude/rules/metrics-core-mapping.md`, ADR-007).

## 1. What the code allows today (read-only discovery, 2026-11-18)

**The Tests module** (migrations `202608220900_tests_v42_*` to `202608300900_tests_v42_phase4_*`, `backend/src/routes/tests.js`):
- **Only WELLNESS can be scheduled.** `POST /api/tests/schedules` and `/schedules/bulk` refuse every other test version
  (`tests.js:22`, `:745-746`), the athlete's form reads WELLNESS's parameters whatever the assignment
  (`tests.js:175-186`), and no route creates or edits a test (`GET /library` marks only WELLNESS `schedulable`). WELLNESS
  is a system test: five 0–10 items, an injury yes / no and a `wellness_total` average.
- **The window is one local day.** A schedule stores wall-clock `opens_time` ≤ `due_time` ≤ `closes_time` on a local date;
  a one-time schedule has `end_date = start_date`. A window across midnight or over several days cannot be expressed.
  Each athlete's window is computed in their own device time zone, falling back to the schedule's.
- **No request key.** `POST /schedules` is one plain transaction; a lost answer and a retry can make two schedules.
- **Targets** are athlete / team / club, the same three shapes as an event's targets. A team's or club's members are
  frozen once per occurrence, when it first materializes on the day.
- **Notifications** are written only when the request carries `notificationRules`; without them the worker sends nothing
  for that schedule. `backend/README-tests-notification-worker.md` says the worker is **not scheduled anywhere** (no
  Render cron). Whether production runs it was not checked.
- **Results:** the calendar already builds a test card with `results {expected, completed, missed}` and folds it into an
  event whose `test_schedule_id` names its schedule (`calendarQuery.js:1035-1055`, `:1218-1227`). `missed` counts the
  assignment status `missed`, which nothing writes for tests; the Tests module derives "missed" from `closes_at`.

**The calendar** (v49, `migrations_v2/202610311000_calendar_v49_events.sql`):
- `calendar.events.test_schedule_id` exists (no foreign key; a trigger checks it), but **only an event of kind `test`**
  may carry one (`:327-331`), and at most one planned event per schedule (`:271-272`). So a questionnaire after a match
  or a training cannot be linked today without a migration.

**Metrics Core** (v27, v34, v53, v63, v74; `backend/src/sourceMetric*`):
- The mapping chain is source field → mapping version → **activation per team binding** → value provenance. An
  activation needs a `source_team_bindings` row, which needs a credential connection to an approved external host; the
  provenance guard needs an open activation and an active binding (v34 `:1300`, `:1483-1610`; v53 `:632-718`). v74's
  "generic source fields" are generic GPEXE fields only.
- So **Tests cannot reach the dashboards through the existing mapping chain** without new Metrics Core schema and changes
  in `sourceMetric*` files, which are off-limits for the calendar stream while the mapping track is active, and which
  belong to the Metrics Core manager's line.
- The dashboards read values by variable whatever wrote them (`trainingLoadDashboardQuery.js`), so once Tests values
  exist as Metrics Core values with their provenance, no dashboard change is needed beyond an entry method.

## 2. The proposed split

- **K2b-2a — *Ask athletes* (the calendar stream):** schedule a questionnaire for an event's athletes in one click, link
  it to the event, show the answers' count on the event's card. Calendar and Tests code, one calendar migration.
- **K2b-2b — Tests answers into Metrics Core (the Metrics Core line, not the calendar's):** a design for an internal
  source (Tests) in the mapping chain, or an estimates-style provenance of its own; it needs the Metrics Core manager's
  contract and the owner's decision, and it touches `sourceMetric*`. The calendar stream does not build it; K2b-2a
  works without it, and the answers stay in Tests until it exists.

## 3. K2b-2a, as proposed

- **Who:** whoever may manage the event (`eventWriteBasis`), in the event owner's workspace. The schedule's owner is the
  event's owner (the existing `scheduleBelongsToOwner` rule), its targets are the event's targets.
- **Where:** in the event's panel, for a planned event that has targets (not *Day off*): **Ask athletes**. One form:
  the questionnaire (today WELLNESS only, named as the Tests library names it) and *When* (Q3). One confirmation line
  names how many athletes will be asked. One button.
- **The write:** one calendar command with a `requestKey`, through the calendar's one runner (`calendarCommandRunner.js`:
  the writer lock, then the event row `FOR UPDATE`, the right decided again on the locked row, the request and change
  rows, the bounded COMMIT). In that transaction: the Tests schedule row, its targets and its notification rules
  (invitation and one reminder), through a helper extracted from `routes/tests.js` (`insertScheduleRow`, the targets, the
  rules) so both modules write the same rows; then the event's link. A lost answer is *Result not confirmed* · *Check
  result* with the same key, never a second schedule.
- **The link (★ migration, v79 or later):** a new table `calendar.event_questionnaires` (event, test schedule, who, when),
  one live questionnaire per event, trigger-checked like v49's reference (the shared fixture has no Tests schema), with
  its audit row; v49's `test_schedule_id` of a `test` event keeps its meaning (the test the event *is*). The numbers
  agreed with the Metrics Core line (2026-11-18): v75 is reserved (dashboards D2a), v77 is PR #608 (computed variables),
  v78 is its zone-with-condition step; the calendar takes v79 or later, checked against `origin/main` and the 12-digit
  prefix rule when the file is written, and only on the owner's order naming the file.
- **Afterwards:**
  - the event's card and panel: "Questions: 3 of 18 answered" for a manager (a count, never a name on the card; the panel
    lists who answered for a manager, as the test card does); the athlete sees nothing new on the calendar card (D21),
    and answers in Tests as today;
  - `missed` on the folded card is derived from the window's close, as the Tests module does (a fix in `calendarQuery.js`);
  - the event cancelled → its questionnaire's schedule cancelled in the same transaction; the event's day changed →
    the schedule moves with it while nobody has answered, otherwise the change is refused with one sentence (Q5);
  - *Remove questions* while nobody has answered.
- **Tests:** disposable databases through the T1 runner (rights for every basis and the identical 404, the request-key
  replay and a lost COMMIT, the schedule's rows equal to a `POST /schedules` with the same input, cancel and move,
  late joiners, the count), mutations on the guards, the frontend suite through the real handlers, the frontend PR gate,
  a browser check at 360 / 375 / 390 / 1280 px on the real server with a disposable database.
- **Reviews:** `code-reviewer`, `db-reviewer`, `security-reviewer` (a write across two modules' tables), `ux-design-reviewer`,
  `mobile-qa`; the fresh independent review; the owner's external review (triggers 1 and 4: a migration, a transaction
  with idempotency).
- **Slices:** K2b-2a-1 the migration and the backend command (★); K2b-2a-2 the screen.

## 4. What K2b-2a leaves out

- Questionnaires other than WELLNESS (they need the Tests module's authoring and execution, a Tests track).
- A window across midnight or over several days (a Tests schema change).
- Push notifications while the Tests worker is not scheduled (Q6).
- Any Metrics Core or dashboard change (K2b-2b).

## 5. Risks

- The Tests module writes rows the calendar now creates: a later Tests change to `insertScheduleRow` must keep the
  extracted helper as the one writer (a test pins both call sites to the same rows).
- A team's members are frozen at the day's first materialization (the Tests rule): an athlete added later that day is
  not asked. The calendar's membership-on-the-day rule agrees for the day itself.

## 6. Decisions for the owner

- **Q1 — the split: decided.** The calendar builds K2b-2a only (*Ask athletes* and the answers' count on the card), and
  *answers in the dashboards* (K2b-2b) stays with the mapping line, after its computed variables. Decided by the OptiMove
  manager (the Metrics Core line) on 2026-11-18, to whom the owner handed the coordination („to iskomuniciraj sve sa
  rukovodiocem optimove").
- **Q2 — the questionnaires:** WELLNESS only for now (recommended; it is the only schedulable test), or wait for Tests
  authoring first.
- **Q3 — when the athletes answer:** two choices in the form, *After the event* (from the event's end, or 18:00 without
  an end time, until 23:59 the same day) and *Next morning* (07:00–12:00 the next day) (recommended); or one fixed window.
- **Q4 — which events:** every planned event with athletes except *Day off* (recommended), or only trainings and matches.
- **Q5 — changes after asking:** cancelling the event cancels the questions; moving it moves them while nobody has
  answered, otherwise the move is refused (recommended); or questions never move.
- **Q6 — notifications:** the Tests worker is not scheduled per the repository; until it is, athletes see the questions
  in the app (Athlete Home, Tests) but get no notification. Scheduling it (a Render cron job) is the owner's
  infrastructure decision; K2b-2a works either way.
