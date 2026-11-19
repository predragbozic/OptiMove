# Central calendar — K2b-2a-2: the coach screens of *Ask athletes* (UI contract)

Status: **proposed, waiting for the calendar manager's GO.** No code is written before the GO.

Written by the executor on 2026-11-18 against `c51a298b` (branch `claude/central-calendar-k2b2a-1`, PR #614: the backend
and migration v81, not merged), with `origin/main` read for K2c-1 (`frontend/central-calendar-links.js`,
`docs/ai/central-calendar-k2c-plan.md` 1.1).

**Authority.** The plan `docs/ai/central-calendar-k2b2-plan.md` is not copied here; this contract links its sections:
3 (what the coach sees), 6 (the 2a-2 slice), 7 and 8 (the owner's decisions; Q9: the Tests form's option first),
9.1.3 (routes and codes), 9.1.11 (rights), 9.1.13 (the GO), 9.1.14 and 9.1.15 (as built). Where the code of #614 and
the plan differ, the code wins and this contract names it.

**Scope.** Frontend screens of the coach (a manager of an event), the club's admin and a platform admin. The athlete's
screens are K2b-2a-3. No migration. Two backend gaps are found (B1, B2 in section 8); they are open questions, not
built here.

Off-limits, not touched: the Imports screen, Source fields and mapping-board screens, `backend/src/sourceMetric*`,
`sourceField*`, `gpexe*`.

---

## 0. What the client can read today (on `c51a298b`) — and what it cannot

| Fact the screen needs | Read today | Who gets it |
|---|---|---|
| The club's switch (on / off, `updatedAt`) | `GET /api/calendar/settings` → `questions: {enabled, revision, updatedAt}` (absent without v81) | the club's admin and a platform admin, in the **club** workspace only |
| A type's `defaultQuestions` | `GET /api/calendar/settings` → `types[].defaultQuestions`, **only while the switch is on** | same |
| The switch, for the event form | **nothing.** `GET /api/calendar/events/types` (`eventFormOptions`) carries neither the switch nor `defaultQuestions` | — (gap **B1**) |
| The switch, for the Tests schedule form | **nothing.** The Tests routes read it only inside `skipDaysOffRefusal` | — (gap **B1**) |
| An event's questions, counts and three name lists | `GET /api/calendar/events/:id/questions` | a manager of the event while the switch is on; the identical 404 for anyone else **and while the switch is off** |
| The card's RPE count | `GET /api/calendar` → the event card's `rpe {asked, submitted, missed}`, folded from `events.external_schedule_id`, which an RPE question sets | as today |
| The card's WELLNESS count | **nothing** (the calendar read does not fold `calendar.event_questions`) | — (question **Q6**) |
| A Tests / TL schedule is calendar-managed | **nothing** in the schedule reads; only the 409 `schedule_managed_by_calendar` on a write | — (question **Q7**) |
| A daily schedule's `skipDaysOff` | Tests schedule reads (`formatScheduleRow` → `skipDaysOff`, absent without v81) | as today |

---

## 1. The Tests schedule form: *Skip days off* (2a-2a)

Files: `frontend/tests-{view,actions,data}.js` (the existing schedule form, `renderTestsScheduleFormHtml` area,
`data-tests-form="create-schedule" | "edit-schedule"`).

### 1.1 When it is shown

All of these:
- the form's recurrence is **Repeat daily** (client `scheduleKind === "daily"`, the server's `recurring`); never for
  *Specific dates* (a bulk of one-time schedules) or a one-time edit;
- the test is WELLNESS (today the only schedulable test; the server refuses `skipDaysOff` for anything else, 9.1.15
  db L4). The client knows the test by its library name only: on a create, the library's schedulable test; on an edit
  or *Schedule again*, the schedule's `testName` (review round 1, LOW-3);
- **the active workspace's club has *Ask athletes* switched on.** The client has no read of that today (section 0).
  Proposed: B1 (section 8). Until B1 exists, the option is **not shown** and nothing is sent.

When the switch read fails or answers off, the option is hidden and `skipDaysOff` is not sent: the schedule keeps
today's behaviour (asked on days off too). A hidden option is never a dead control.

### 1.2 What it looks like and sends

- One checkbox below the *Opens / Closes* row, before *Recipients*:
  **[✓] Skip days off** — quiet line under it: "Athletes aren't asked on a day when a *Day off* in the calendar
  includes them."
- **Create:** ticked by default (plan 8, Q8). Sent as `skipDaysOff: true | false` in `POST /api/tests/schedules` only
  when the option is shown.
- **Edit of a daily schedule:** the box shows the schedule's `skipDaysOff`. Sent in `PATCH` **only when the coach
  changed it** (the route accepts it on its own or with other fields, 9.1.14). Untouched → not in the body.
- **Switching the recurrence** to *Specific dates* hides the box and drops the field from the body; back to *Repeat
  daily* restores the coach's last choice (default ticked).
- The Tests POST has no `requestKey` today; the option rides on the form's existing write and its existing outcome
  handling. Nothing about the write's idempotency changes in this slice.

### 1.3 Refusals

| Code | Sentence (one plain sentence, one next step) | Then |
|---|---|---|
| `400 skip_days_off_unavailable` | "Skipping days off isn't available for this schedule now. Untick *Skip days off* and save again." | the switch is read again; if it is now off, the box is hidden and unticked, the rest of the form kept |
| `409 schedule_managed_by_calendar` (edit) | "This check-in belongs to a calendar event. Change it on the event." | nothing else (see Q7) |

A daily schedule with `skipDaysOff: true` whose club's switch is off: the box is hidden (the server's materialization
re-checks the switch, so nothing is skipped); its schedule detail shows nothing about it.

---

## 2. Settings → Calendar (2a-2b)

Files: `frontend/calendar-settings-{view,actions,data}.js`. Shown in a club workspace to the club's admin and a platform
admin (the existing tab). Without v81 (`questions` absent from the read) nothing of this section shows.

### 2.1 *Ask athletes* for the club

A section **"Questions for athletes"** at the top of the tab (before *Event types*).

**The club's admin** (no platform admin role): read-only.
- On: "● On — your coaches can ask athletes questions after events." + quiet "Turned on DD.MM.YYYY."
- Off: "○ Off — questions to athletes are not turned on for this club. A platform administrator can turn them on."
- State shown with a glyph and the word, never with colour alone.

**A platform admin in the club's workspace** (which today means also the club's admin: a platform admin reaches a club
workspace only through that club's `club_admin` role, `loadAvailableWorkspaces`). The client knows the platform role
from `state.organization.data.isPlatformAdmin`, the fact Settings → Storage and App health already use; the server
decides again on every write. The same line, then one form:
- **Reason** (`textarea`, required, ≤ 500 characters, 16 px): label "Why are you turning it on?" / "…off?";
- one button: **Turn on for this club** or **Turn off for this club** (the opposite of the state);
- empty reason → the button stays enabled; on press, the field's error "Write a reason." and nothing is sent;
- the write: `PUT /api/calendar/settings/questions` `{requestKey, enabled, reason}`; a fresh key made when sent;
- confirmed → the settings read again; notice "Questions for athletes are now on for this club." / "…now off…"; the
  reason field emptied.

Refusals:

| Code | Sentence |
|---|---|
| `400 invalid_reason` | "Write a reason of at most 500 characters." (on the field) |
| `404` | "This setting isn't available for you here." — the form is removed and the tab read again (the identical 404: the client never says why) |
| `409 try_again` | "The calendar is busy. Nothing was saved; try again in a moment." |
| `409 request_key_reused` | "This could not be sent. Nothing was saved; try again." (a new key next time) |
| `503 outcome_unknown`, no answer, unwritten 5xx | *Result not confirmed* · **Check result** (section 5) |

Turning the switch off does not touch existing questions; a confirmation is not asked (the write is reversible by the
same person with the same form, and the reason records it).

### 2.2 *Questions for athletes* per event type

Only while the switch is on (the read gives `defaultQuestions` then; absent → the row is not shown).

- In each type's editor (the existing type form), one group after *Expected* (`defaultExpects`):
  **Questions for athletes**: two checkboxes **RPE** and **WELLNESS** (none ticked = none; both = both). Quiet line:
  "New events of this type start with these questions ticked. Coaches can change them per event."
- In the type list row, a quiet suffix: "Asks RPE", "Asks WELLNESS", "Asks RPE and WELLNESS"; nothing when none.
- Sent in the existing `PATCH /api/calendar/settings/types/:typeId` as `defaultQuestions: ["rpe"|"wellness", …]`
  **only when changed**, with the existing `expectedRevision` and key rules of that form.
- Who: the club's admin and a platform admin (the existing `type_update` rule, 9.1.11).

| Code | Sentence |
|---|---|
| `409 questions_off` | "Questions for athletes are not turned on for this club." — the settings read again; the group disappears; the rest of the type's change is **not** saved (the whole PATCH was refused): "Nothing was saved. Save again without the questions." |
| `400 invalid_questions` | "Nothing was saved. Try again." |
| the type form's existing codes | unchanged |

---

## 3. The event form (2a-2b)

Files: `frontend/central-calendar-event-form.js` (pure form state, request builder, HTML), `central-calendar-actions.js`,
`central-calendar-data.js`.

### 3.1 When the section shows

Only when the form knows the owner club's switch is on (B1: `GET /api/calendar/events/types` → `questions.enabled`),
and for an edit only when the event's questions were read (`GET …/questions` answered 200). Otherwise the section is
not shown and `questions` is **never** sent (absent on create = the server applies the type's defaults itself while on;
absent on PATCH = no change).

### 3.2 What it looks like

A group **"Ask athletes"** after *Expected*:
- **[✓] RPE — "How hard was it?"**
- **[ ] WELLNESS — "How are you feeling?"**
- under each ticked kind, **When to ask**, three radio choices (one `fieldset`, 44 px rows):
  - **After the event** — quiet: "18:00–23:59 on Sat 21.11." (from the form's own day / end day / times, plan 3.3 and
    the GO's O2: from the end time; without an end, from the later of 18:00 and the start; on the last day);
  - **Next morning** — quiet: "07:00–12:00 on Sun 22.11.";
  - **Custom** — a date picker limited to the event's days and the day after, and *From* / *To* times (16 px inputs);
    under it, always: "Answers can be collected within one day for now."
- RPE when the event has linked trainings (edit only; the manager view's `sessionLinks` live): the RPE box is disabled
  with "RPE comes from the linked trainings." (the server's `rpe_from_sessions`), never offered.
- A live question that athletes already answered (the panel read's `counts.answered > 0`): its kind and window are
  shown locked with "Athletes have already answered, so this question can't change here." Unticking it is allowed (it
  becomes *closed early* on the server: answers kept), with the line "Removing it stops new answers; the answers given
  stay."

### 3.3 Defaults and what is sent

- **Create:** the box of each kind in the chosen type's `defaultQuestions` is pre-ticked with *After the event*.
  Changing the type re-applies the new type's defaults **only while the coach has not touched the section** (the same
  rule the form uses for `expects` today).
- **Create, section untouched:** `questions` is **not sent**; the server asks the type's defaults with *After the
  event* and skips what cannot be asked (9.1.14, `questionsSkipped`). **Section touched:** `questions:
  [{kind, window}]` is sent explicitly (an explicit list is refused instead of skipped). (Q3.)
- **Edit:** the section starts from the live questions of the read. `questions` (the whole desired list) is sent only
  when the coach changed a box or a window; otherwise not sent. Changing the event's day, time, time zone or targets
  without touching the section sends no `questions`: the server moves the live questions itself, or refuses with
  `questions_answered` (9.1.14).
- `window` on the wire: `{kind: "after_event"}`, `{kind: "next_morning"}`, `{kind: "custom", date: "YYYY-MM-DD", from:
  "HH:MM", to: "HH:MM"}`.
- **Client checks before sending** (the server stays authoritative): custom `from < to` → field error "The end time
  must be after the start time. Answers can be collected within one day for now."; custom date outside the event's
  days and the day after → "Choose one of the event's days or the day after."; *After the event* on an event ending at
  23:59 → "The event ends too late to ask after it the same day. Choose *Next morning* or *Custom*."

### 3.4 After the save

- `questionsSkipped` non-empty → a notice under the saved event: "Saved. RPE wasn't asked: it can't be asked for this
  event." / "…WELLNESS wasn't asked: this day's WELLNESS already covers it." (by kind; plural "RPE and WELLNESS weren't
  asked"). The panel's section explains the state (section 4).
- `dayOffCancelled > 0` (a Day off made or widened) → "N open WELLNESS check-ins on these days were cancelled." (N=1:
  "1 open WELLNESS check-in…").

### 3.5 Refusals of the event form (create and PATCH), one sentence and one next step

Shown in the form's existing error area (`role="alert"`); the form stays open with the coach's input.

| Code | Sentence |
|---|---|
| `rpe_from_sessions` | "RPE comes from this event's linked trainings. Untick RPE, or unlink the trainings first." |
| `rpe_already_linked` | "This event already collects RPE through another request. Untick RPE." |
| `rpe_from_question` | "This event already asks athletes for RPE. Remove that question first." |
| `wellness_already_scheduled` | "Today's WELLNESS already covers this day. Untick WELLNESS, or choose another day." |
| `wellness_not_available` | "The WELLNESS check-in isn't available right now. Untick WELLNESS to save." |
| `questions_answered` | "Athletes have already answered this event's questions, so its day, time and athletes can't change. Keep them, or remove the answered questions first." |
| `question_already_asked` | "This event already asks this question. The event was read again." (re-read) |
| `window_one_day` | "Answers can be collected within one day for now. Choose an end time after the start time." |
| `invalid_window` | "This time to ask doesn't fit the event. Choose *Next morning* or *Custom*." |
| `invalid_question` | "Nothing was saved. Try again." |
| `no_athletes` | "Nobody on this event can be asked on that day. Check the event's athletes, or untick the questions." |
| `questions_off` | "Questions for athletes are not turned on for this club." — the section is removed (types read again); the coach saves again without it |
| `event_changed` | the existing sentence and re-read |
| `try_again` | "The calendar is busy. Nothing was saved; try again in a moment." |
| `request_key_reused` | "This could not be sent. Nothing was saved; try again." (a new key next time) |
| `503 outcome_unknown`, lost answer | the form's existing *Result not confirmed* · *Check result* (same path, body, key) |

No code, id or server sentence is shown to a coach or club admin (frontend.md, Interaction principles).

---

## 4. The event panel, for a manager (2a-2b)

Files: `frontend/central-calendar-view.js` / `-event-details.js` (the panel), `-actions.js`, `-data.js`; a small pure
module `frontend/central-calendar-questions.js` (window words, sentences, list grouping), as K2c-1's
`central-calendar-links.js`.

### 4.1 What is read, and when

- `GET /api/calendar/events/:id/questions` **once per open panel** of an event card with `canManage: true` (planned or
  cancelled), **only when B1 says the switch is on** for the workspace's club (no read when off or unknown: avoids a
  404 per panel).
- Read again when the card's `revision` moves (the K2c-1 rule) and after every confirmed question write.
- **Never per card**, never for a reader, never in the athlete workspace.
- A 404 → the section is not shown (no message: the identical 404 is never explained). A failure → the section shows
  "The questions could not be read." with **Try again**.

### 4.2 The section "Questions for athletes"

After the details and the K2c-1 "Trainings and activities" section, before *Edit* / *Cancel event*.

Per question (RPE first, then WELLNESS):
- the head line: **RPE · 3/18 answered** (glyph ✓ when all answered) and the window in words: "After the event,
  18:00–23:59 today" / "Next morning, 07:00–12:00 on Sun 22.11." / "21.11., 09:00–11:00";
- status words when not live: "Closed early — the answers given stay." (`closed_early`), "Event cancelled — the
  answers given stay." (`event_cancelled`);
- three folded lists (`<details>`; the first non-empty of *Not answered yet* open by default):
  **Answered (3)**, **Later (2)**, **Not answered yet (13)** — names only, sorted as the server sends; an empty list
  shows "Nobody." Names appear **only here** (never on a card, a notice or a tooltip);
- for a live question, two buttons: **Move time** and **Remove question**.

Then, while the event is planned and a kind is not asked yet: **Ask RPE** / **Ask WELLNESS** (one button per kind not
live; hidden for RPE when the event has linked trainings, with the line "RPE comes from the linked trainings."). Ask
opens the same *When to ask* choice inline (3.2) and **Ask athletes** sends it. (Q4.)

Empty (no question and none can be asked, e.g. a cancelled event without questions): the section is not shown.

### 4.3 The writes

| Act | Route | Body |
|---|---|---|
| Ask | `POST /api/calendar/events/:id/questions` | `{requestKey, expectedRevision, kind, window}` |
| Move time | `POST …/questions/:questionId/move` | `{requestKey, expectedRevision, window}` |
| Remove | `POST …/questions/:questionId/remove` | `{requestKey, expectedRevision}` |

- *Move time* opens the *When to ask* choice inline with the current window selected; **Save time** sends.
- *Remove question*: a `confirm()` (it is not reversible by the same act: a removed question is asked again as a new
  one, and an answered one closes): unanswered — "Remove the RPE question? Athletes won't be asked."; answered —
  "Stop the RPE question? 3 answers are kept; nobody else can answer." After a confirmed remove, the notice is
  "Removed." or "Closed. The answers given stay." (from the re-read status).
- `expectedRevision` = the open card's `revision` (the manager view's when newer), as K2c-1.

Refusals (section `role="alert"`, under the row that sent):

| Code | Sentence |
|---|---|
| `questions_answered` (move) | "Athletes have already answered, so this time can't change. Remove the question to stop it." |
| `rpe_from_sessions` | "RPE comes from the linked trainings, so it can't be asked here." |
| `rpe_already_linked` | "This event already collects RPE through another request." |
| `wellness_already_scheduled` | "Today's WELLNESS already covers this day. Choose another day." |
| `wellness_not_available` | "The WELLNESS check-in isn't available right now." |
| `question_already_asked` | "This question is already asked. The event was read again." (re-read) |
| `window_one_day` | "Answers can be collected within one day for now. Choose an end time after the start time." |
| `invalid_window` | "This time doesn't fit the event. Choose another one." |
| `no_athletes` | "Nobody on this event can be asked on that day." |
| `event_changed` | "This event was changed meanwhile. The calendar was read again: try again." |
| `event_cancelled` | "This event is cancelled, so nothing can be asked." (re-read) |
| `404` | "This question isn't available any more." (re-read; the section disappears if the read is 404) |
| `try_again` | "The calendar is busy. Nothing was saved; try again in a moment." |
| `request_key_reused` | "This could not be sent. Nothing was saved; try again." |
| `invalid_*`, other | "Nothing was saved. Try again." |

### 4.4 The card

- An RPE question sets the event's `external_schedule_id`, so the card's existing **"RPE x/y"** (D14, one count per
  card, `central-calendar-view.js` `centralCalendarCountLabel`) already counts it. **Nothing changes on the card for RPE.**
- WELLNESS has no card count (the calendar read does not fold questions). Proposed: keep D14's one count; WELLNESS is
  only in the panel (Q6).
- The panel's existing gap note "RPE is expected, but nothing attached to this event asks the athletes for it yet."
  (`GAP_NOTES.rpe`) gains, when B1 says the switch is on and the coach manages the event, the next step: "Use *Ask
  RPE* below." (no new read: the card already knows `expects` and `rpe`).

---

## 5. The rules for every write (all three screens)

As K2c-1 (`docs/ai/central-calendar-k2c-plan.md` 1.1.5) and the Settings → Calendar writes:
- **A fresh `requestKey`** per act, made when it is sent; a refused act's key is never reused.
- **One control at a time:** while a write is in flight or not confirmed, every other write control of that screen
  (the section's buttons, *Edit*, *Cancel event*, the type form's Save, the switch) is disabled; a double click sends
  one request.
- **Lost answer** (no answer, the 90 s bound, `503 outcome_unknown`, an unwritten 5xx): "The result is not confirmed."
  with **Check result**, which sends the **same** path, body and key. A check answered with a code the server gives only
  after reading its request record settles it as "Nothing was saved" with the code's sentence; `try_again` or another
  lost answer keeps it not confirmed (the existing `checkNoteText` lines).
- **Leaving** with a write in flight or not confirmed: the calendar's uncertain-writes memory
  (`rememberUncertainWrite`, a new mode `question`, its calendar line "Check the question for “<event title>”") and
  Settings' `calendarSettingsMayBeLeft`; both count for `beforeunload`.
- **Confirmed** (200, or 200 with `verifiedAfterCommitError`): the calendar cache dropped and the calendar read again
  (`settleAndReload`), the event's questions read again, the settings read again for Settings writes; a notice line
  (`role="status"`): "RPE asked. Athletes will be notified." / "Time moved. Athletes will be notified." / "Removed." /
  "Closed. The answers given stay."
- No id, code or server sentence in any rendered text.

---

## 6. Mobile

- 360 / 375 / 390 px and 1280 px; the panel is the bottom sheet below 1024 px (unchanged).
- Every checkbox, radio row and button ≥ 44 × 44 px (`min-height: 44px`, checked across the cascade's `!important`
  blocks); `date`, `time` and `textarea` inputs 16 px at every width.
- The three name lists wrap (`overflow-wrap: anywhere`), no horizontal scroll in the sheet; buttons full width at ≤ 390
  px, on the right of the row above.
- The *When to ask* choice is a vertical radio list on a phone (no segmented control that clips at 360 px).
- The Tests form's checkbox sits in the existing scroll area of the form, above the sticky actions.

---

## 7. Test plan

**Suites (JSDOM, the real view / data / actions, a fake fetch that keeps the routes' contracts — the questions read
answers 404 while the fake's switch is off and for a non-manager, as the real route):**
- `frontend/tests/tests-skip-days-off.actions.test.mjs` (2a-2a): shown only for daily + switch on; hidden for specific
  dates and when the switch read fails or says off; ticked by default; create sends `skipDaysOff: true` / `false`;
  edit sends it only when changed; recurrence switch drops it; `skip_days_off_unavailable` → the sentence, the switch
  re-read, the box hidden; `schedule_managed_by_calendar` → its sentence.
- `frontend/tests/calendar-settings-questions.actions.test.mjs` (2a-2b): the club's admin read-only; a platform admin's
  form (reason required, one PUT, the exact body, a new key per press); the 404 removes the form; lost answer → Check
  result with the same key; `defaultQuestions` only while on, sent only when changed; `questions_off` → the sentence
  and the group gone.
- `frontend/tests/central-calendar-questions.actions.test.mjs` (2a-2b): defaults pre-ticked; the window words for each
  choice and for an event without an end (the later of 18:00 and the start); custom checks; untouched create sends no
  `questions`, touched sends the list; edit sends the desired list only when changed; `questionsSkipped` and
  `dayOffCancelled` notices; every code of 3.5 and 4.3 → its sentence; the panel read once per open panel and again on
  a revision move, never per card, never for a reader; the counts and the three lists; Move / Remove / Ask bodies;
  answered → the confirm text; lost answer → same path, body, key; leave guards; one control at a time; a scan of the
  rendered HTML for UUIDs and codes.

**Mutations** (each must fail a test): show the Tests option for specific dates; send `skipDaysOff` on an untouched
edit; untick the Tests default; send `questions` on an untouched create or edit; reuse a refused act's key; a new key
on Check result; settle a check on `try_again`; read `…/questions` per card (or for a reader); show the switch form to
the club's admin; drop the `confirm()` on Remove; show a name list on the card.

**Then:** the whole `--preset frontend-fast` on the head and on a clean `origin/main` worktree (the Frontend PR gate:
every file failing on the head but not on main is a NO-GO); `npm --prefix frontend run build`; `git diff --check`; the
browser check through `npm run e2e:demo` (Chromium, invented data) at 360, 375, 390 and 1280 px: the switch turned on
by the platform admin, a type's default, an event created with RPE pre-ticked, the panel's counts after an athlete
answers and one chooses *Later*, Move and Remove, the Tests form's option; no horizontal overflow, no JS error.

**Reviews:** `code-reviewer`, `ux-design-reviewer`, `mobile-qa` (plan section 6), the independent review; plus
`security-reviewer` for B1 if it is built in this stream (it widens who learns the switch's state).

---

## 8. Open questions for the manager (each with my recommendation)

1. **B1 — the switch for the event form and the Tests form.** No read gives a team coach (or a club coach's event
   form) the switch or the types' `defaultQuestions`. **Recommend:** an additive field on the existing
   `GET /api/calendar/events/types` (`eventFormOptions`): `questions: {enabled}` for the catalog owner's club (false for a
   private coach), and `defaultQuestions` per type while on. The Tests form reads that same route for the switch (cheap,
   already allowed to every coach workspace). Put it in **#614 before its merge** (one narrow backend delta, no
   migration, one test), so 2a-2 stays frontend-only; otherwise it is a backend part of 2a-2a with `code-reviewer` +
   `security-reviewer`.
2. **B2 — none needed for the panel:** `GET …/questions` is enough. Confirm that a 404 there hides the section silently,
   and that the panel reads it only when B1 says on.
3. **Defaults on create: omit `questions` when the section is untouched** (the server asks the defaults and skips what
   cannot be asked, named in `questionsSkipped`), and send the list only when the coach changed it. **Recommend: yes** —
   a default that can't be asked then never blocks saving an event.
4. **Ask from the panel** (not only through *Edit*). **Recommend: yes**, reusing the form's *When to ask* choice; it is
   the plan's `ask_question` command and the shortest path after the event is saved.
5. **Remove asks a `confirm()`** (it is not reversible by the same act). **Recommend: yes**, with the answered count in
   the question when it closes early.
6. **The card's WELLNESS count:** none (D14 keeps one count per card; RPE already counts). **Recommend: no WELLNESS
   count on the card in 2a-2**; the panel has it.
7. **Calendar-managed schedules in Tests and Training Load screens:** their reads don't say so, so a coach sees *Edit*,
   *Pause*, *Cancel* there and gets `409 schedule_managed_by_calendar`. **Recommend:** in 2a-2 only the sentence "This
   question belongs to a calendar event. Change it on the event." on those refusals (Tests schedule screen and the TL
   external-schedule screen); hiding the controls needs a read field (`managedByCalendar`) and is a later small step.
8. **`expects` and questions:** ticking RPE in *Ask athletes* does not tick *Expected: RPE*, and the reverse. **Recommend:
   keep them independent** in 2a-2 (the type defaults already pair them: Training and Match expect and ask RPE).
9. **Who sees the switch section in Settings:** the read gives `enabled` and `updatedAt`, not who or why. **Recommend:**
   show the state and date only; the reason stays in the change log (no new read).

## 9. Slicing (recommendation)

- **2a-2a — the Tests form's *Skip days off*** (plan Q9: first). Small: `tests-{view,actions}.js`, one suite. It needs
  B1 to know the switch; if B1 lands in #614, 2a-2a is frontend-only and can merge right after #614's deploy.
  Reviews: `code-reviewer` + `mobile-qa` (a checkbox in an existing form; light regime).
- **2a-2b — Settings → Calendar, the event form and the panel.** One PR (they share the window words and the
  sentences module); `code-reviewer`, `ux-design-reviewer`, `mobile-qa`, the independent review.

**Recommend: yes, two PRs in this order**, with B1 added to #614 before its merge.

## 10. The manager's GO (2026-11-18)

GO on the contract at `3c04ca7c`, with these decisions (the calendar manager's message to the executor):

1. **B1 goes into #614** (the K2b-2a-1 executor adds it). The shape the screens code against:
   - `GET /api/calendar/events/types` gets a top-level `questions: { enabled: boolean }`: `true` only when the
     workspace owner's club (or the team's club) has the switch on; `false` for a private coach, the platform, or no
     club; nothing else of the switch is sent.
   - Each type gets `defaultQuestions: [...]` only while the switch is on: exactly what a create without `questions`
     would ask. While off, the key is absent.
2. **Panel read: yes.** Only when `questions.enabled` is true and the card says `canManage`; a 404 hides the section
   silently.
3. **Untouched create: yes.** No `questions` sent; the list only when the coach changed the section. The
   `questionsSkipped` notice stays.
4. **Ask from the panel: yes.**
5. **Confirmations follow the Interaction principles** (`.claude/rules/frontend.md`), rendered as an **inline step**
   (one sentence, two buttons), **never a native `confirm()`** (K2c-1's Align pattern). This replaces 4.3's `confirm()`:
   - **Remove / Stop a question:** unanswered — "Remove the RPE question? Athletes won't be asked." **Remove
     question** / **Keep it**; answered — "Stop the RPE question? 3 answers are kept; nobody else can answer." **Stop
     question** / **Keep it**.
   - **The event form:** a save that would close an answered question early (the coach unticked it) shows the same
     inline step before sending.
   - **The club switch:** one inline step after the reason: "Turn on questions for athletes for this club? Its coaches
     can then ask athletes after events." / "Turn off questions for athletes for this club? Coaches can't ask new
     questions; the answers given stay." **Turn on** (or **Turn off**) / **Cancel**. (This replaces 2.1's "a
     confirmation is not asked".)
   - **A type's `defaultQuestions`:** no extra step; it rides the type form's Save.
   - The mutation "drop the confirmation" targets these inline steps.
6. **No WELLNESS count on the card: yes.**
7. **The split: yes.** In 2a-2 only the sentence on `409 schedule_managed_by_calendar`: the Tests schedule screen
   (2a-2a) and the TL external-schedule screen (2a-2b). For TL only its refusal-sentence mapping, its file named in the
   report first; `frontend/training-load-simple-*` and `frontend/training-load-analysis-*` are not touched.
   `managedByCalendar` is a later step.
8. **`expects` and Ask stay independent: yes.**
9. **State and date only: yes.**

**Slicing: two PRs.**
- **2a-2a** = branch `claude/central-calendar-k2b2a-2`: this contract plus the Tests *Skip days off* option and its
  suite. Light regime: `code-reviewer` + `mobile-qa`, at most one narrow re-review; "light regime" in the PR body.
- **2a-2b** = branch `claude/central-calendar-k2b2a-2b`, stacked on 2a-2a: Settings, the event form and the panel; full
  reviews.

**Base:** code 2a-2a against B1's shape now; when the manager sends #614's new head (main merged in, plus B1), merge it
with `git merge --no-edit origin/claude/central-calendar-k2b2a-1` (no rebase). The browser check and the Frontend PR
gate run after that merge. `styles.css` and `state.js` are shared: calendar- or tests-prefixed selectors only, and any
shared part of `state.js` touched is named. The executor does not open the PR.

**During 2a-2b (the manager's GOs of 2026-11-19):**
- **4.1, deviation:** the panel learns B1 from the shared, per-workspace cached `/events/types` read. It is the event form's
  own cache, read on the first open of a manager's event panel in a club or team workspace. It is dropped on a workspace
  change and after every Settings → Calendar write, the switch's included. A failed or lost read is not kept: that panel
  shows no section and no message, and the next panel open reads it again. It is never read per card, for a reader, or
  in the athlete workspace.
- **4.2 and 4.3, decided:** on an answered question the button reads **Stop question**, as its step does; an unanswered one
  keeps **Remove question**. A command's result or refusal is drawn in the row that sent it (`role="status"` for a
  result, `role="alert"` for a refusal), and beside that kind's *Ask* when no row holds it (an *Ask* refused, a question
  removed). Only a section-wide read ("The questions could not be read.") stays under the section's title. The coach UI
  keeps **WELLNESS**, the name the coach sees in Tests.
- **Known limit:** turning the club's switch off hides the questions in the panel; live questions keep their window, and
  a coach who must stop one turns the switch back on first.
- **7, the TL screen:** in `frontend/training-load-actions.js`, only the external-schedule form's save and the Pause /
  Resume / Cancel call read `409 schedule_managed_by_calendar` as "This RPE request belongs to a calendar event. Change it
  on the event."; every other refusal keeps today's handling.
