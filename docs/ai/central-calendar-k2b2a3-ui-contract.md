# Central calendar — K2b-2a-3: the athlete's screens of *Ask athletes* (UI contract)

Status: **proposed** (phase 1, the executor, 2026-11-19, on `main` `caa6b4b5`). No code before the manager's GO.

Authority: the plan `docs/ai/central-calendar-k2b2-plan.md` (3.3 the windows, 3.4 the soft prompt, 6 the 2a-3 slice,
7 the owner's decisions, 9.1.3 the routes, 9.1.6 the notifications, 9.1.11 rights, 9.1.13 / 9.1.14 the GO and as
built) and the coach screens' contract `docs/ai/central-calendar-k2b2a2-ui-contract.md`, whose words the athlete's
screens reuse ("How hard was it?" for RPE, "How are you feeling?" for WELLNESS). Frontend only: no migration, no route,
no backend change (questions Q7–Q8 below ask whether one is wanted later).

---

## 0. What the client can read and write today (PR #614, merged and deployed)

| What | Route | What the client may rely on |
|---|---|---|
| Her open questions | `GET /api/calendar/questions/mine` | `{questions:[{questionId, kind, eventId, eventTitle, eventDay, eventStart, window:{opensAt, closesAt}, form, later}]}`. "Open" = a live question of a planned event of a club whose switch is on, that asks her, **whose window is open now** (`opensAt ≤ now ≤ closesAt`), and whose assignment is `pending` / `open` (not answered). The read makes the day's occurrence and her assignment first (A1), so `form` always carries an id. Sorted by `opensAt`, then id. `[]` for anyone who is not an athlete in her athlete workspace, while the switch is off, and without v81. `Cache-Control: no-store`. |
| `form` | (same) | `{kind:'rpe', externalAssignmentId}` or `{kind:'wellness', assignmentId}`. |
| `later` | (same) | `true` once she pressed *Later* for that question (any device, any earlier app session). |
| *Later* | `POST /api/calendar/questions/:questionId/later` `{requestKey}` | 200 `{postponement:{questionId, at}}` (also on a replay of the same key, `replayed: true`, and after a verified lost COMMIT, `verifiedAfterCommitError: true`); 404 (not hers, unknown, switch off); 409 `question_not_open`, `try_again`, `request_key_reused`; 503 `outcome_unknown`. |
| The notification | `public.app_notifications` via `GET /api/notifications` | `type` `calendar_question_asked` (or `calendar_question_moved` after a move), `entity_type 'calendar_event'`, `entity_id` = the event, `metadata {eventId, questionId, kind}`, title "Your coach has a question", body e.g. "How did Training go? Answer from 18:00 on 21.11." Written when the coach asks, usually **before** the window opens. |

What the read does **not** give: a question whose window has not opened yet, nor one that has closed or was answered
(both are simply absent). The client therefore cannot tell "not open yet" from "closed" (Q3). Daily Tests WELLNESS
schedules are **not** in this read: it lists calendar event questions only (`calendar.event_questions`); a daily
WELLNESS keeps its existing Home card (Q4).

---

## 1. The module and the reads

A new frontend domain, as `.claude/rules/frontend.md` asks:
- `frontend/athlete-questions-data.js` — the read, the slice, the *Later* write, the session memory, the minute tick;
- `frontend/athlete-questions-view.js` — the prompt and the Home card (pure template strings);
- `frontend/athlete-questions-actions.js` — Answer now / Answer / Later / Escape, the notification's open path.

**The slice** `state.athleteQuestions = {status: 'idle'|'loading'|'ready'|'hidden', rows: [], contextKey, notice}`.
`rows` is an **explicit pick** of each answer row (`questionId, kind, eventTitle, eventDay, eventStart, opensAt,
closesAt, formKind, formId, later`), as `athleteHomeEventRows` does: a field the server adds later never reaches the
screen, and `eventId` is not kept.

**When it is read** (`loadAthleteQuestions`), and only then:
1. once per app open in an athlete workspace (the first entry into Home after sign-in, a page load or a switch into an
   athlete workspace);
2. on every return to Home (`loadAthleteHome` in `app.js` adds it to its `Promise.all`, beside
   `loadAthleteHomeEvents`);
3. after an answer: the RPE form's and the WELLNESS form's successful submit call one exported
   `athleteQuestionsAnswered()` (a one-line hook in each module's submit success path), which reads again;
4. after a *Later* has settled (200, 404 or `question_not_open`);
5. when a question notification is opened (section 5).

Never per render, never on the minute's tick. One read in flight at a time per context (a second call while one runs
reuses it). A generation counter and the context key (account + workspace, `currentUserWorkspaceContextParts()`) drop
a late answer of another account or workspace, or one that started before a reset (`resetAthleteQuestions()` on a
workspace switch and on sign-out, as `resetAthleteHomeEvents`). No `view-cache.js` entry: the answer changes with the
clock and with every answer, so it is not cached (the same reason `loadTrainingLoadAthleteToday` is not).

**A failed read** (any status, a lost answer, a throw): `status: 'hidden'`, `rows: []`; no prompt, no card, no error
line, no *Try again*. The next read (Home again) tries again.

**The minute's tick** (as K2b-1d3's `athleteHomeEventsTick`): while Home is open, every 60 s the rows are filtered
again by `closesAt > now` with no request; when the visible set changed, only the card's section is replaced in place
(a registered section painter), never the whole of Home, so an open RPE form keeps its focus and keyboard. A prompt
that is open and whose last question closed is closed by the same tick (focus to Home's heading). The tick stops when
Home is left and on a reset.

---

## 2. The soft prompt (plan 3.4)

### 2.1 When it shows

All of these, checked after each read of section 1 (items 1 and 2 only; never after an answer, a *Later* or a
notification open):
- the athlete workspace (`isAthleteMode()`), and the active tab is **Home**;
- at least one row that is **promptable**: open now (`closesAt > now`), `later === false`, and not yet prompted in this
  app session (2.4);
- nothing else is on top: no RPE form (`state.trainingLoad.rpeForm`), no Training Load athlete overlay, no Tests form,
  no other `[role="dialog"][aria-modal="true"]`, no leave-guard question, and the notification panel is closed;
- the app was not opened through a notification click or another deep link in this same step (section 5 wins).

If a condition fails, the prompt is not queued: the card at the top of Home carries the questions, and the next read
(on the next return to Home) checks again.

### 2.2 What it looks like

A dialog over the whole screen: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` its title,
`aria-describedby` its first line. Below 760 px a full-screen sheet; from 760 px a centred panel (max 480 px wide) on a
dimmed backdrop. The page behind does not scroll.

**One question** (the usual case):

> **Your coach has a question**
> How hard was it? — **Training** · Sat 21.11. 17:00
> Answer by 23:59 today.
>
> [ **Answer now** ] (primary, full width on a phone)
> [ Later ] (secondary)

**Several questions** (Q1, the recommendation): one sheet, one row per promptable question, earliest `closesAt`
first, at most 3 rows and "and N more on Home" under them:

> **Your coach has 2 questions**
> How hard was it? — Training · Sat 21.11. · Answer by 23:59 today.   [ **Answer** ]
> How are you feeling? — Training · Sat 21.11. · Answer by 23:59 today.   [ **Answer** ]
>
> [ Later ] (secondary; *Later* for every question shown)

The words:
- the kind: RPE → "How hard was it?", WELLNESS → "How are you feeling?" (2a-2's own lines);
- the event: its title (or "Event" when empty), then the day as K2b-1e's day word ("Today", "Tomorrow", else
  "Sat 21.11.") and `eventStart` when present;
- the time to answer, from `closesAt` in the device's time: "Answer by 23:59 today." / "Answer by 12:00 tomorrow." /
  "Answer by 12:00 on Sun 22.11."; when less than 60 minutes remain: "Answer in the next 25 minutes."
- no count of teammates, no coach name, no id or code (section 7).

It never locks the app: Escape, *Later* and the backdrop tap close it; the schedule and every tab stay reachable
behind it.

### 2.3 Accessibility

- On open: focus on **Answer now** (or the first **Answer**); the element focused before is remembered.
- A focus trap: Tab / Shift+Tab cycle inside the dialog.
- **Escape = Later** (the same write as the button). The backdrop tap = Later.
- On close by *Later*: focus to the card's heading at the top of Home ("Questions from your coach"). On close by
  *Answer*: the form takes the focus as it does today.
- The dialog's lines are text, not `role="alert"`; the screen reader reads the title and the first line on open.
- Every button ≥ 44 × 44 px; the text wraps (`overflow-wrap: anywhere`) for a long event title.

### 2.4 At most once per app session

- **App session** = the page's life in memory: a page load, sign-in or a switch into an athlete workspace starts a new
  one; sign-out and a workspace switch end it (`resetAthleteQuestions()`).
- A set `promptedIds` (in memory, never in storage) holds every question the prompt has **shown**, whatever closed it
  (*Answer*, *Later*, Escape, the backdrop, the tick). A question in it is never prompted again in that app session;
  the card still lists it.
- A question with `later === true` (pressed in an earlier session or on another device) is never prompted; the card
  lists it.
- So: after *Later* the prompt does not come back in the same app session (the plan); after a page reload, a question
  she pressed *Later* on does not come back either (the server's `later`), while one she only closed with *Answer* and
  did not finish may be prompted once more.
- A question whose window opens while the app is already open is prompted at the next return to Home, once (Q2).

---

## 3. Answer now / Answer

The same path from the prompt, the Home card and a notification (section 5). It closes the prompt (the question stays in
`promptedIds`), writes nothing to `/later`, and opens the existing form with the id from `form`:

| `form.kind` | Entry point (existing, `frontend/app.js`) | What it does today |
|---|---|---|
| `rpe` | `openTrainingLoadAssignment(form.externalAssignmentId)` | switches to Home, `loadAthleteHome()`, then `openExternalAssignmentFromNotification(id)` (`training-load-actions.js`): reads Training Load's athlete Today (and the weekly overlay if not found), then `openRpeFormForSessionId(id)` opens the RPE form of that external assignment. |
| `wellness` | `openTestAssignment(form.assignmentId)` | switches to Tests, `openAssignment(id, renderTests)` (`tests-actions.js`): `loadWellnessForm(id)` and the WELLNESS form; a refusal is Tests' own sentence "Could not open this check-in." |

These are the very handlers the RPE and WELLNESS notifications use today (`handleNotificationAction`'s
`openTrainingLoadAssignment` / `openTestAssignment`), so no new form entry point is written.

One gap is closed in the questions module, not in Training Load: `openRpeFormForSessionId` does nothing when the
assignment is not found or already rated. After `openTrainingLoadAssignment` returns, when no RPE form is open for that
id, the questions module shows the notice "This question has closed." at the top of Home (`role="status"`) and reads
again.

**After the answer:** each form's success path calls `athleteQuestionsAnswered()` (section 1, item 3): the read runs
again, the answered question is gone from the card on the next paint, and it never prompts again (it is also in
`promptedIds`). If the athlete leaves the form without answering, the question stays on the card.

---

## 4. Later

- **One `POST /api/calendar/questions/:questionId/later` per question shown**, each with a fresh `requestKey`
  (`crypto.randomUUID()`), made when it is sent. With several questions in the sheet, one request each, in sequence.
- **At once, locally:** the prompt closes, the rows get `later: true`, and the question is in `promptedIds`. The athlete
  never waits for the answer.
- **The answers:**

  | Answer | What the client does |
  |---|---|
  | 200 (also `replayed`, `verifiedAfterCommitError`) | done; reads again (section 1, item 4) |
  | 404 | the row is dropped quietly; reads again |
  | 409 `question_not_open` | the row is dropped quietly; reads again |
  | 409 `try_again`, 503 `outcome_unknown`, no answer, a 5xx, a throw | **counts as done locally** (the row keeps `later: true` and stays in `promptedIds`); no *Check result*, no retry, no read |
  | 409 `request_key_reused` | cannot happen (a fresh key per send); handled as `try_again` |

- **Never shown as an error.** *Later* has no failure sentence for the athlete: the worst case is that the coach's panel
  does not list her under *Later* and she is prompted once more in a later app session.
- No leave guard and no `beforeunload` for a *Later* in flight (it blocks nothing; a lost one is the worst case above).

---

## 5. The notification click

`frontend/notifications.js` gains one row kind:
- `isCalendarQuestion = (row.type === 'calendar_question_asked' || row.type === 'calendar_question_moved') &&
  row.entity_type === 'calendar_event' && row.metadata?.questionId`;
- its action `notification-open-calendar-question`, with `data-question-id` (from `metadata.questionId`), and the hint
  line "Answer" under the body (as "Open RPE" / "Open check-in");
- the handler: mark read (`markReadBeforeLeaving`), close the panel, then `handlers.openCalendarQuestion(questionId)`.

`openCalendarQuestion(questionId)` (the questions module, wired in `app.js`):
1. the leave guard first (it is in `NAVIGATING_NOTIFICATION_ACTIONS`, as the other opening rows);
2. switch to Home (`state.activeTab = 'athlete-home'`, `loadAthleteHome()`), which reads `/questions/mine`; the prompt is
   **not** shown for this read (2.1, the last condition);
3. the question is in the rows and open → section 3 (Answer now) at once;
4. it is not (answered, closed, not open yet, or the read failed) → the notice at the top of Home, `role="status"`:
   "This question isn't open right now." (Q3), and Home stays.

A row of another type keeps its behaviour. A coach never receives this notification (the recipients are athletes,
9.1.6); a row with a missing `metadata.questionId` stays `notification-read`.

---

## 6. The Athlete Home card

- **Where:** at the very top of Home's section, right after the header and before the WELLNESS card
  (`renderAthleteHomeHtml`: `renderAthleteQuestionsCardHtml(state.athleteQuestions)` as its second line).
- **When:** while at least one row is open (`closesAt > now`); otherwise nothing is drawn (no empty state, no heading).
  `hidden` / `idle` / `loading` draw nothing either (no "Loading" line: the card simply appears).
- **What:**

  > **Questions from your coach** (h3, `id="athleteQuestionsTitle"`, `tabindex="-1"`)
  > How hard was it? — Training · Today 17:00 · Answer by 23:59 today.   [ **Answer** ]
  > How are you feeling? — Training · Today 17:00 · Answer by 23:59 today.   [ **Answer** ]

  One row per open question, in the read's order (by `opensAt`), every row (no *Show more*: a day has at most a few).
  A row with `later: true` is drawn the same (no "Later" marker: the athlete needs only the next step). The
  **Answer** button is the row's one action (section 3); `aria-label` "Answer: How hard was it? Training, Today".
- **Gone:** after an answer (the next read), or when the window closes (the minute's tick, section 1).
- The notice line of sections 3 and 5 ("This question has closed." / "This question isn't open right now.") is drawn at
  the top of this slot, even when there is no row, and is cleared at the next read.

---

## 7. What an athlete never sees (D21)

No teammate's name or count, no "3/18", no coach's name, no question id, assignment id, event id, schedule id, code or
server sentence, in any rendered text, `aria-label` or `title`. Ids live only in `data-*` attributes of the buttons
(as the WELLNESS card's `data-assignment-id` today). The test of section 9 scans the rendered HTML of the prompt, the
card and the notices for every id and code of the fake's answers.

---

## 8. Mobile

- 360 / 375 / 390 px and 1280 px. No horizontal scroll at any width (the long-title case included).
- The prompt below 760 px: a full-screen sheet (`position: fixed; inset: 0`), its content padded by
  `env(safe-area-inset-top/right/bottom/left)`; the buttons in a bottom bar above the home indicator
  (`padding-bottom: max(16px, env(safe-area-inset-bottom))`); the body's scroll locked while it is open. From 760 px a
  centred panel.
- Every button ≥ 44 × 44 px, checked across the cascade's `!important` blocks (`.compact-button` is smaller in places;
  the new classes set their own `min-height: 44px`). Text ≥ 16 px for the question line.
- No input of its own (no iOS zoom risk). The forms it opens are the existing RPE and WELLNESS forms: the browser check
  verifies on 390 px that the RPE form's duration input and Save are not covered by the on-screen keyboard (iOS
  Safari's visual viewport), and that the WELLNESS sliders and Save are reachable. A finding there is recorded and
  reported, not fixed in this slice unless the prompt caused it.
- The Home card's rows: the question line and the **Answer** button stack on ≤ 390 px (button full width), side by side
  from 760 px.

---

## 9. Test plan

**Suites (JSDOM, the real view / data / actions and the `app.js` wiring where the existing Home suites already load
it; a fake fetch that keeps the routes' contracts — `/questions/mine` answers only open, unanswered questions of the
athlete and `[]` for a coach or while the fake's switch is off; `/later` answers 409 `question_not_open` for a closed
one and replays the same key):**
- `frontend/tests/athlete-questions.actions.test.mjs`:
  - prompt shown on the first Home entry with one open question; not shown for `later: true`, for a coach workspace,
    with `[]`, after a failed read, with an RPE form / Tests form / other dialog open, after a notification open;
  - once per app session: closed by Later, Escape, backdrop or Answer → not shown on the next Home entry; shown again
    after a reset (sign-out / workspace switch) unless `later`;
  - several questions: one sheet, one **Answer** per row, *Later* sends one POST per row with distinct keys;
  - Later: the prompt closes before the POST answers; 200 → read again; 404 / `question_not_open` → row dropped and
    read again; `try_again` / 503 / a thrown fetch → no error text, row kept with `later`, no second POST;
  - Answer now RPE → `openTrainingLoadAssignment(externalAssignmentId)`; WELLNESS → `openTestAssignment(assignmentId)`;
    RPE not found → the notice "This question has closed.";
  - the card: drawn only with open rows; gone after `athleteQuestionsAnswered()` and the read; the minute's tick drops a
    row whose `closesAt` passed with no request and replaces only its section (an open RPE form keeps focus);
  - the read count: one per Home entry, none per render or tick; a late answer after a workspace switch is dropped;
  - the pick: an extra field of the answer (`eventId`, an unknown key) never reaches the HTML;
  - D21 scan: no id or code of the fake in the rendered HTML, `aria-label`s or notices;
  - accessibility: `aria-modal`, focus on the primary on open, Tab cycles inside, Escape = Later, focus to the card's
    heading after Later.
- `frontend/tests/notifications-calendar-questions.test.mjs`: both types render the *Answer* hint and the new action
  with the question id; another `entity_type` or no `metadata.questionId` stays `notification-read`; the click marks
  read, closes the panel, opens the form for an open question, and shows "This question isn't open right now." for one
  the read does not list.
- The existing suites that touch the hooks stay green: `athlete-home.render`, `athlete-home-events.actions`,
  `notifications-tests-module`, `notifications-training-load`, the Tests and Training Load athlete form suites.

**Mutations** (each must fail a test): the `later === false` condition of 2.1; the `promptedIds` add; the
"nothing else on top" check; Escape not mapped to Later; a fresh key replaced by a constant; `question_not_open` treated
as kept; the lost-answer branch showing an error; the pick widened to the whole row; the tick filter on `closesAt`
removed; the notification handler skipping the read.

**The Frontend PR gate** (`testing-evidence.md`): the whole `--preset frontend-fast` on the head and on a clean
`origin/main`; a file failing on the head only is a NO-GO. The production build and `git diff --check`.

**Browser check** (`npm run e2e:demo`, a disposable database): a platform admin turns the club's switch on (Settings →
Calendar, with a reason); a coach makes an event for the athlete's team today and asks RPE and WELLNESS with a *Custom*
window around now; then as the athlete at 360, 375, 390 and 1280 px: the prompt on opening, Later, the card, Answer
now for RPE (the form, the keyboard over the duration field on 390), Answer for WELLNESS, the card gone after both, the
notification click (open and, after the window, closed), no horizontal scroll, no JS error. Screenshots in the PR.

**Reviews** (plan section 6): `code-reviewer`, `ux-design-reviewer`, `mobile-qa`, then the fresh independent review.

---

## 10. The files the code will touch

| File | Change |
|---|---|
| `frontend/athlete-questions-data.js` (new) | the slice helpers, the read, `athleteQuestionsAnswered`, the *Later* write, `promptedIds`, the tick, the reset |
| `frontend/athlete-questions-view.js` (new) | the prompt, the Home card, the notice, the time-to-answer words |
| `frontend/athlete-questions-actions.js` (new) | Answer / Later / Escape / backdrop, the focus trap, `openCalendarQuestion` |
| `frontend/state.js` | `athleteQuestions` slice and its empty state |
| `frontend/athlete-home.js` | the card's slot at the top |
| `frontend/app.js` | the read in `loadAthleteHome`, the prompt mount after it, action routing (`athlete-questions-*`), Escape in the keydown handler, `openCalendarQuestion` for `handleNotificationAction`, the reset on workspace switch and sign-out |
| `frontend/notifications.js` | the `calendar_question_asked` / `_moved` row kind and its handler |
| `frontend/training-load-actions.js` | one call of `athleteQuestionsAnswered()` in `submitRpeForm`'s success path |
| `frontend/tests-actions.js` | one call of `athleteQuestionsAnswered()` in the WELLNESS submit's success path |
| `frontend/styles.css` | the prompt sheet / panel, the card, the safe areas, 44 px |
| `frontend/tests/athlete-questions.actions.test.mjs`, `frontend/tests/notifications-calendar-questions.test.mjs` (new) | section 9 |
| `docs/ai/central-calendar-k2b2-plan.md` | 2a-3 "as built" after the GO and the code |

Not touched: `backend/**`, `migrations_v2/**`, `frontend/training-load-simple-*`, `frontend/training-load-analysis-*`,
the Imports / Source fields / mapping-board screens.

---

## 11. Open questions for the manager (each with my recommendation)

1. **Several open questions: one sheet with a list, or one prompt per question?** Recommend **one sheet** (2.2): the
   usual pair is RPE and WELLNESS of one event, and two prompts in a row would be the nagging the owner ruled out.
   One question keeps the plan's exact *Answer now* / *Later*; two or more show one **Answer** per row and one *Later*
   for all.
2. **"At most once per app session" — per app session or per question?** Recommend **per question per app session**
   (2.4): a question whose window opens while the app is open (opened at 17:00, window from 18:00) is prompted once at
   the next return to Home; a question already prompted, or with `later`, never again in that session. The
   alternative (one prompt per app session at all) would hide an RPE question that opens later the same evening.
3. **The notification click before the window opens.** The notification is written when the coach asks and says
   "Answer from 18:00 on 21.11."; `/mine` lists only open questions, so a click before 18:00 cannot be told from a
   closed one. Recommend the neutral sentence **"This question isn't open right now."** for both (the notification row
   itself already says when it opens), instead of "This question has closed.", which would be false before the window.
   "This question has closed." stays for the RPE form that is not found after *Answer now* (section 3).
4. **Daily Tests WELLNESS in the prompt?** `/questions/mine` returns **calendar event questions only**; a daily Tests
   WELLNESS is not in it, so it does not prompt and keeps its existing Home card (plan 3.4: the prompt is for calendar
   questions). Recommend keeping it so in 2a-3.
5. **The same assignment on two Home cards.** An event's WELLNESS assignment also counts in Home's existing WELLNESS
   card (`/api/athlete-home`'s `wellness`), and an event's RPE assignment can appear in Training Load's Session feedback
   card. Recommend, frontend only: the WELLNESS card is not drawn when its `count` is 1 and its `assignmentId` is a
   question's `form.assignmentId` (one comparison); the Session feedback card is left as it is (it lists every session
   to rate and its rated state; hiding one row there would change Training Load's own card). Alternative: leave both
   cards as they are and accept the double line.
6. **The prompt only on Home.** Recommend showing it only while Home is the active tab (2.1), never over another tab the
   athlete opened herself (Weekly plan, Tests, a program) — the app opens on Home, so "on opening the app" is covered,
   and the card carries the rest.
7. **A backend change for upcoming questions?** Not needed for 2a-3. A later read of questions whose window has not
   opened (for "Opens at 18:00" on the card and an exact sentence on an early notification click) would be a backend
   change of `myOpenQuestions`; recommend recording it as a follow-up, not building it now.
8. **Any other backend change?** None found: the read gives every field the screens need, the *Later* route covers the
   write, and the notification's metadata names the question. Recommend no backend change in 2a-3.
9. **A Playwright scenario in `e2e/`?** Recommend the manual browser check of section 9 for this slice, and a scenario
   (switch on → coach asks → athlete prompt → Later → card → Answer) as its own small follow-up, since the e2e seed has
   no club with the switch on yet.
