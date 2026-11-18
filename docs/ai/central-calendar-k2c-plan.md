# Central calendar — K2c plan: the calendar and the Builder, one click apart

Status: **K2c-1 built, its review rounds fixed (sections 1.2.1 and 1.2.2)**; K2c-2 is planned; K3 is named only. The owner: „Radi redosledom koji
je optimalan" (2026-11-18). Written against `main` `9351bcc0` plus PR #611's head `88b60dde` (K2b-1d3), on which this
branch is stacked because both change the calendar's panel.

## 0. What exists (K2a-1b, merged and deployed)

- The routes, all through the calendar's runner with a `requestKey` (`backend/src/routes/calendarEvents.js:44-48`;
  contract `docs/ai/central-calendar-k2a-plan.md` sections 2 and 4.2):
  - `POST /api/calendar/events/:eventId/sessions` (attach a planned group: a day and its Builder slot);
  - `…/sessions/detach`;
  - `…/sessions/align` (the linked sessions' RPE and Training Load switches follow the event's `expects`);
  - `POST …/activities` and `…/activities/detach`.
- The read already folds a linked planned group into its event (the K1 batch card disappears into the event), and
  reports orphaned links.
- **No screen calls them.** The panel's code names the buttons ("Attach a training", "Attach an activity",
  `central-calendar-view.js`, `renderEventActionsHtml`), but they were never built. The Builder has no calendar action.

## 1. K2c-1 — link in one click from the calendar (frontend only, no migration)

- **The event's panel** (a manager, a planned event):
  - **Suggested trainings:** the planned cards of the event's days whose athletes the event reaches and that are not
    linked yet. They are already in the calendar's answer; nothing new is read from the server. Each has a **Link**
    button that sends one attach.
  - **Linked trainings:** each with **Unlink**. An orphaned link (its Builder session is gone) shows one plain sentence
    and *Unlink*.
  - **Align:** when the event expects RPE and a linked training does not ask for it (or the reverse), one button,
    *Ask RPE in the linked trainings*. It is the align route; nothing changes silently.
  - **Activities:** the same pattern for the day's recorded activities that are not linked, with *Link* and *Unlink*.
- **A planned card's panel** (a manager): *Link to an event*, listing the planned events of that day that reach its
  athletes, each with **Link**. When there is exactly one, it is the primary button.
- **Every write:**
  - a `requestKey`;
  - one control at a time;
  - *Result not confirmed* · *Check result* with the same key after a lost answer;
  - the calendar re-read after a confirmed write;
  - every refusal code as one plain English sentence (no codes or ids for a coach).
- **The Interaction principles** of `.claude/rules/frontend.md`:
  - an explicit confirmation only where a write cannot be reversed by the same person (Unlink reverses Link, so
    neither asks "Are you sure?");
  - 44 px targets;
  - 360 / 375 / 390 px.
- **Not in K2c-1:** the Builder side (K2c-2), and the questions' interplay of K2b-2a-1 (its `rpe_already_answered` refusal
  gets its sentence when K2b-2a-1 is merged).
- **Phases:**
  1. The executor writes the UI contract as section 1.1: the exact panels, the suggestion rule against the read's
     fields, the codes with their sentences, the states, and the test plan.
  2. The manager gives a GO.
  3. The code.
- **Reviews:** `code-reviewer`, `ux-design-reviewer` (a new coach flow), `mobile-qa`, then the fresh independent
  review, then the OptiMove manager's gate.

### 1.1 The UI contract (K2c-1, written 2026-11-18 against `88b60dde` + the plan commit; waits for the manager's GO)

Frontend only. The calendar's own modules (`central-calendar-view.js`, `-actions.js`, `-data.js`); a new small
module `central-calendar-links.js` holds the pure parts (the suggestion rule, the grouping of the linked sessions, the
sentences), so the view and the actions stay in their roles. No backend file, no migration, no new route.

#### 1.1.1 What is read

- **Suggestions come from the calendar answer alone** (`GET /api/calendar`, already in `cal.data`; every kind is read
  whatever the chips show, `centralCalendarUrl` sends no `kinds`). Nothing new is read for them.
- **The linked trainings and activities need the manager view** `GET /api/calendar/events/:id` (K2a-1b,
  `sessionLinks`, `activityLinks`): Unlink sends link ids (`linkIds`) the calendar card does not carry. This is the
  existing read the panel already makes for an event with details (`syncPanelEvent` / `loadPanelEvent`); K2c-1 widens
  its condition from "a manager's card with details" to "a manager's card of a planned (not cancelled) event". One read
  per open panel, re-read when the card's `revision` moves (the existing rule). The details section reads the same
  answer; nothing is read twice.

#### 1.1.2 The suggestion rule (pure, against the read's fields)

For an event card `E` (`kind: "event"`, `canManage: true`, `cancelled: false`) open on its day `D = E.date` (a
multi-day event: the day of the card the coach opened):

- **Suggested trainings** = the cards `P` of the same day with `P.kind === "planned"`,
  `P.links.logicalSessionIds.length >= 1`, and **every** `P.athleteIds` in `E.athleteIds` (the attach is all or
  nothing and refuses a non-target, `athlete_not_targeted`). A linked session folds under its event and is not a
  planned card any more, so a planned card is never linked to an event the coach sees. Order: by the card order of
  the day (the server's `compareCards`).
- **Not offered, counted:** planned cards of `D` that share at least one athlete with `E` but not all — one quiet
  line: "1 more training that day has athletes this event does not include." (plural form for N). Nothing for a
  planned card with no shared athlete.
- **Suggested activities** = the cards `A` of day `D` with `A.kind === "activity"` and at least one `A.athleteIds` in
  `E.athleteIds` (the server needs one targeted participant, `activity_not_targeted`). A linked activity folds under
  its event, so the same reasoning holds.
- What the read cannot see (and the server decides): a plan outside the event owner's tree (`400
  session_not_available`), a session linked to an event the coach does not see (`409 session_already_attached`). Both
  answer with their sentence below and the calendar is read again.

For a planned card `P` open on day `D`:

- **Events to link to** = the event cards of `D` with `canManage: true`, `cancelled: false` and every `P.athleteIds`
  in `E.athleteIds`. Order: by the card order of the day.
- None, while the day has at least one manageable planned event: one quiet line "No event on this day includes all
  of these athletes." No line when the day has no manageable event.

#### 1.1.3 The event's panel (a manager, a planned event)

After the event's facts and details, before *Edit* / *Cancel event*, one section **"Trainings and activities"**
(`<section class="cc-panel-links">`, heading `h4.cc-panel-subtitle`):

1. **Linked trainings** (only when the manager view has session links), one row per group of links with the same day,
   slot and current session name (the links of one Builder batch): the name ("Training" when none), the slot words
   and the athlete count ("Morning · 12 athletes"); a **Unlink** button (`plain-button`) that sends all the group's
   `linkIds`. A renamed group carries "(was “old name”)". **Orphaned** links (state `orphaned`) are one row: "1
   linked training was deleted in the Builder." / "N linked trainings were deleted in the Builder." with **Unlink**.
2. **Align** — only when the card's `alignment.pending > 0` and no write runs: one line and one button.
   - The event expects RPE: "1 linked training does not ask for RPE yet." / "N linked trainings do not ask for RPE
     yet." Button **Ask RPE in the linked trainings**.
   - It does not: "1 linked training still asks for RPE, which this event does not collect." (plural form). Button
     **Stop asking RPE in the linked trainings**.
3. **Suggested trainings** (only when any): heading "Trainings on this day"; per row the planned card's title, slot
   words and athlete count, and a **Link** button (`plain-button cc-panel-button`, the row's primary). Then the
   "not offered" line of 1.1.2 when it applies.
4. **Linked activities**: per `activityLinks` row its name (`visible: true`) or "An activity you cannot open here"
   (`visible: false`), and **Unlink**.
5. **Activities on this day** (only when any suggested): the activity card's title and its "Recorded" count; **Link**.
6. **Empty:** nothing linked and nothing to suggest: one line "No training or activity on this day can be linked to
   this event." (no button; the Builder side is K2c-2).

States of the section:

- **Loading** the manager view: the suggestions and the Align row show at once (they come from the card); the linked
  parts show "Loading linked trainings…" (`role="status"`).
- **Error** of the manager view: "Linked trainings could not be loaded." with **Try again** (the existing panel read's
  retry); the suggestions stay usable (Link needs no link id).
- **A cancelled event** or a **reader** (`canManage` false): no section at all (a cancel ended the links, K2a-1b; a
  reader gets nothing to act on). The athlete workspace never gets it.
- **In flight:** the clicked button reads "Linking…" / "Unlinking…" / "Updating…" and every button of the section,
  plus *Edit* and *Cancel event*, is disabled (one control at a time); `aria-busy="true"` on the section.

#### 1.1.4 A planned card's panel (a manager)

When 1.1.2 gives at least one event: a section **"Link to an event"** after the status, before *Open in Training
Load*:

- exactly one event: one primary button **Link to “<event title>”** (`primary-button`), under it the event's time and
  type in a quiet line;
- several: one row per event (title, time, type) with **Link** each.

After a confirmed link the planned card folds under the event and leaves the day: the panel opens the event's card of
that day (`event:<id>:<D>`) with the notice line "Linked to “<event title>”." and focus on its Close (a sheet) or its
card. If the event card is not in the new answer (a filter, another change), the panel closes with the same notice.

#### 1.1.5 The requests (`central-calendar-data.js`, through the existing `eventWrite`: 90 s bound)

| Act | Route | Body |
|---|---|---|
| Link a training | `POST /api/calendar/events/:eventId/sessions` | `{ requestKey, expectedRevision: E.revision, logicalSessionIds: P.links.logicalSessionIds, alignSessions: false }` |
| Unlink trainings | `POST …/:eventId/sessions/detach` | `{ requestKey, expectedRevision, linkIds }` (a group's or the orphaned ones') |
| Align | `POST …/:eventId/sessions/align` | `{ requestKey, expectedRevision, confirmDisableWithResults: false }`; after `409 has_existing_results` and the coach's yes: a **new** key with `confirmDisableWithResults: true` |
| Link an activity | `POST …/:eventId/activities` | `{ requestKey, expectedRevision, activityId: A.links.activityIds[0] }` |
| Unlink an activity | `POST …/:eventId/activities/detach` | `{ requestKey, expectedRevision, activityId }` (the link's `activityId`) |

- `alignSessions: false` on a link: nothing changes silently. After the link the card's `alignment.pending` shows the
  Align row when the sessions do not follow the event.
- `expectedRevision` is the open event card's `revision` (the manager view's `event.revision` when it is newer).
- One `requestKey` (`newCentralCalendarRequestKey`) per act, made when it is sent. A refused act leaves nothing
  saved, and its key is not reused: pressing the button again makes a new key.
- **Lost answer** (`centralCalendarOutcomeUnknown`: no answer, the 90 s bound, `503 outcome_unknown`, an unwritten
  5xx): the section shows "The result is not confirmed." with **Check result**, which sends the **same** path, body
  and key (the server replays a saved command, never writes twice). While it waits, every other button of the section
  and *Edit* / *Cancel event* stay disabled. A check answered with a code the server gives only after reading its
  request record (`event_changed`, `event_cancelled`, `session_not_available`, `session_outside_event`,
  `athlete_not_targeted`, `session_already_attached`, `link_not_available`, `nothing_to_align`, `has_existing_results`,
  `activity_not_available`, `activity_superseded`, `activity_outside_event`, `activity_not_targeted`,
  `activity_already_attached`, `invalid_*`) settles it as "Nothing was saved" with the code's sentence; any other answer
  keeps it not confirmed with the existing `checkNoteText` lines.
- **Leaving** a link write in flight or not confirmed (another card, Close, a workspace switch, the page): the write
  joins the existing uncertain-writes memory (`rememberUncertainWrite`, a new mode `link`) and the calendar line
  "Check linking for “<event title>”" opens it again with its Check result; the leave questions of
  `centralCalendarMayBeLeft` and `beforeunload` count it as a save not confirmed. Same rules as the event saves.
- **Confirmed** (200, or 200 with `verifiedAfterCommitError`): the calendar cache is dropped and the calendar read
  again (`settleAndReload`), the manager view follows the new revision, and a notice line says what happened:
  "Linked “<training>”." / "Unlinked “<training>”." / "Linked “<activity>”." / "Unlinked the activity." /
  alignment: "RPE is now asked in N linked trainings." or "RPE is no longer asked in N linked trainings." plus, when
  the answer's `alignment.notAllowed > 0`, " N belong to another coach's plans and were left as they are." and, when
  `switchOff > 0`, " RPE requests are switched off in Training Load, so athletes will not be asked until they are
  switched on." A read that fails after it adds the existing `READ_FAILED_TAIL`.

#### 1.1.6 The sentences of the refusals (one sentence and one next step; no code or id is shown)

| Code | Sentence |
|---|---|
| `event_changed` | "This event was changed meanwhile. The calendar was read again: try again." (and the calendar is read again) |
| `event_cancelled` | "This event is cancelled, so nothing can be linked to it." (calendar read again) |
| `session_not_available` | "This training can't be linked to this event: it is not in this event's plans. Nothing was saved." |
| `session_outside_event` | "This training is not on the event's day. Nothing was saved." |
| `athlete_not_targeted` | "Some athletes of this training are not part of this event. Add them to the event first, or link another training." |
| `session_already_attached` | "This training is already linked to another event. Unlink it there first." |
| `link_not_available` | "This link was already removed. The calendar was read again." (calendar read again) |
| `nothing_to_align` | "No linked training needs to change. The calendar was read again." (calendar read again) |
| `has_existing_results` | a confirmation, not a refusal: "N RPE answers were already given in these trainings. Stop asking for RPE anyway? The answers are kept." — Yes sends the new request; No leaves everything as it is |
| `activity_not_available` | "This activity can't be linked to this event here. Nothing was saved." |
| `activity_superseded` | "This activity was merged into another one. The calendar was read again: link that one." (calendar read again) |
| `activity_outside_event` | "This activity is not on the event's day. Nothing was saved." |
| `activity_not_targeted` | "No athlete of this activity is part of this event. Nothing was saved." |
| `activity_already_attached` | "This activity is already linked to another event. Unlink it there first." |
| `try_again` | "The calendar is busy. Nothing was saved; try again in a moment." (the existing sentence) |
| `request_key_reused` | "This could not be sent. Nothing was saved; try again." (a new key next time) |
| 401 / 403 / 404 | the existing sentences: "Please sign in again. Nothing was saved." / "Events cannot be changed in this workspace. Nothing was saved." / "This event is not available any more." (calendar read again) |
| any `invalid_*`, other | "Nothing was saved. Try again." |

The sentence shows in the section (`role="alert"` for a refusal, `role="status"` for a notice), under the row whose
button sent the act.

#### 1.1.7 Confirmations (the Interaction principles)

None for Link, Unlink and Align: Unlink reverses Link, and Align is a visible button with one plain sentence that says
what it changes (it can be reversed by changing the event's RPE or the training's RPE toggle). The one confirmation is
`has_existing_results` (the server's own gate). Unlink of an orphaned link removes only the link.

#### 1.1.8 Mobile (360 / 375 / 390 px; the panel is the bottom sheet below 1024 px)

- Each row is a two-line block: the name (wrapping, `overflow-wrap: anywhere`) and the quiet line; the button on the
  right on ≥ 391 px and full width under the text at ≤ 390 px; every button `min-height: 44px` (the
  `cc-panel-button` rule, checked in the cascade with `!important` blocks); no horizontal scroll in the sheet.
- The Align row's button is full width on a phone.
- No input in the section (no 16 px rule to meet); the confirmation is the browser's `confirm()` (as the other
  calendar questions).

#### 1.1.9 Tests and mutations

New suite `frontend/tests/central-calendar-links.actions.test.mjs` (JSDOM, the real view / data / actions, a fake
`/api/calendar` and `/api/calendar/events/*` that keep the routes' contracts: the attach answers the card folded into
the event on the next read, the detach the reverse; a refusal changes nothing):

1. the suggestion rule: a planned card with all athletes in the event → offered; one athlete outside → not offered,
   counted in the line; another day → not offered; an activity with one targeted participant → offered, with none →
   not; a cancelled event, a reader, the athlete workspace → no section;
2. Link from the event: one POST with the exact body (keys, `alignSessions: false`, the card's revision); the calendar
   read again; the suggestion is gone and a linked row shows; the notice;
3. Link from a planned card: one event → the primary button; two → two rows; after the link the event's panel opens
   with the notice; no event covers → the quiet line;
4. Unlink a group (all its `linkIds`), an orphaned row, an activity;
5. Align: the button only with `alignment.pending > 0`, its words by `expects`; `has_existing_results` → the question,
   No sends nothing, Yes sends a new key with `confirmDisableWithResults: true`; the `notAllowed` / `switchOff`
   sentences;
6. every refusal code → its sentence, nothing else changed, a new key on the next press;
7. a lost answer → *Result not confirmed* · *Check result* sends the same path, body and key; a settling code ends it;
   `try_again` keeps it; other buttons disabled meanwhile; leaving keeps it in the uncertain line and the
   `beforeunload` guard;
8. one control at a time: a double click sends one request; *Edit* / *Cancel event* disabled in flight;
9. the manager view's loading and error states (Try again) with the suggestions still usable;
10. no id or code in the section's HTML (a scan of the rendered text for UUIDs and the codes).

Mutations (each must fail a test): drop the "every athlete" check (use "some"); drop `alignSessions: false`; reuse the
key on a new press after a refusal; send a new key on Check result; settle a check on `try_again`; show the section on
a cancelled event; leave *Edit* enabled in flight; send only the first `linkId` of a group.

Then the whole `--preset frontend-fast` on the head and on a clean `origin/main` worktree, the build,
`git diff --check`, and the browser check of the brief (Chromium at 360, 375, 390 and 1280 px through `npm run
e2e:demo`, invented data, a link and an unlink that really change the calendar).

#### 1.1.10 The manager's GO (2026-11-18)

GO on 1.1 at `faf8eab3`, everything in 1.1 standing, with:

- **(a)** the manager view (`GET /api/calendar/events/:id`) is read for every manageable planned event's **open panel
  only** (never per card in a list), once per open and again when the revision moves; a test pins one GET per open and
  none for a reader's or an athlete's panel.
- **(b)** `frontend/central-calendar-links.js` holds the pure rule and the sentences, exported for the tests; the view,
  actions and data keep the module pattern.
- **(c)** a link sends `alignSessions: false` and Align is its own visible button. After a confirmed link that leaves
  `alignment.pending > 0`, the notice says so in one sentence and points at the button: "Linked “<training>”. These
  trainings do not ask for RPE yet: use Ask RPE in the linked trainings." (or the "Stop asking" form).
- **The two unpredictable refusals** (`session_not_available`, a session linked to an event the coach cannot see —
  `session_already_attached`; and their activity twins `activity_not_available`, `activity_already_attached`) leave the
  suggestion list consistent after the re-read: the refused pair (the event and the planned card's sessions, or the
  activity) is remembered in memory for this calendar slice (dropped with it on a workspace switch) and shows as a quiet
  row "Can't be linked to this event." with no *Link*, so no stale *Link* refuses again. A test group pins it.

### 1.2 K2c-1 as built (2026-11-18)

Frontend only; no backend file, no migration, no new route. Built on 1.1 with the manager's GO (1.1.10).

- **`frontend/central-calendar-links.js`** (new, pure): the suggestion rule (`centralCalendarLinkSuggestions`,
  `centralCalendarEventsForPlanned`), the refused-pair key, the grouping of the manager view's session links
  (`centralCalendarSessionLinkGroups`: by day, slot and current name; the orphaned links apart, counted by training),
  the request bodies (`centralCalendarLinkRequest`) and every sentence (Align line, notices, refusals, the
  `has_existing_results` question), the codes that re-read, that are remembered, and that settle a Check result.
- **`central-calendar-view.js`**: the event panel's "Trainings and activities" section before *Edit* / *Cancel event*,
  and a planned card's "Link to an event" section before *Open in Training Load*. *Edit* / *Cancel event* are disabled
  while a link command is in flight or not confirmed. The uncertain-writes line names a link as "Check linking for
  “<event>”".
- **`central-calendar-actions.js`**: one action, `central-calendar-link` (`data-act`: `link-session`, `link-to-event`,
  `unlink-sessions`, `align`, `link-activity`, `unlink-activity`), and `central-calendar-link-check`. The command is
  built from the open panel and the calendar answer (ids are never read from the button's text). Every press makes a
  new key; a lost answer goes into the existing uncertain-writes memory (mode `link`) and Check result resends the same
  path, body and key; the Edit / Cancel handlers refuse while a link is locked; `beforeunload` and the final leave
  question count a link in flight. The panel's manager-view read (`syncPanelEvent`) now runs for every manageable
  planned event's open panel (`panelEventWanted`), the GO's (a).
- **`central-calendar-data.js`**: `sendCentralCalendarLinkWrite` (the 90 s bounded write), and `resultCount` kept on an
  error's info for the alignment's question. **`state.js`**: `linkWrite`, `linkMessage`, `linkRefused` on the
  calendar slice (dropped with it on a workspace switch). **`styles.css`**: the link rows; at ≤ 390 px the buttons go
  full width.

**Deviations from 1.1, both wording:**

- The Align line counts **sessions**, not trainings: `alignment.pending` counts the linked Builder sessions (one per
  athlete), and the browser check showed "4 linked trainings do not ask for RPE yet" for one training of four athletes.
  It now reads "4 linked sessions do not ask for RPE yet." and the align notice reads "RPE is now asked in 4 linked
  sessions."; the buttons keep "Ask RPE in the linked trainings" / "Stop asking RPE in the linked trainings".
- The orphaned row counts trainings (distinct slot and name at link), not links: "1 linked training was deleted in the
  Builder." for one batch of several athletes.

**Changed tests of earlier suites (the GO's (a), intended):** D10 and D27 of `central-calendar-event-details` and 4b
and 7a of `central-calendar-events` expected no manager-view read for a manager's event without details; they now
expect one read for a manageable planned event's open panel (7a: one for the panel, one fresh for the Edit form), and
D10 pins none for a cancelled one.

**Tests:** `frontend/tests/central-calendar-links.actions.test.mjs`, 15 tests in the 11 groups of 1.1.9 and 1.1.10
(including one GET per open and none for a reader's, a cancelled event's or a planned card's panel). Ten mutations,
all killed: the eight of 1.1.9, plus dropping the refused-pair memory and not locking while unconfirmed.

**Browser check** (Chromium through `npm run e2e:demo`, a disposable database with invented data: four club-owned
weekly plans with one Morning session, a manual activity with one participant, a club event created through the app's
API) at 360, 375, 390 and 1280 px. At each width:
- linked from the event, from the planned card (the event's panel opened with the notice), Align, an activity link and
  unlink;
- the planned and activity cards left and came back on the calendar;
- no horizontal scroll, every button of the sections at least 44 px, no JS error.

The one console line is a 403 of `/api/tests/athlete/timezone` on load for a club admin, which this change does not
touch.

**Not done here:** the reviews of section 1 (`code-reviewer`, `ux-design-reviewer`, `mobile-qa`, the independent
review) wait for the manager's order; no physical-device check.

#### 1.2.1 The review round on `ec9011f7` (2026-11-18)

`code-reviewer`, `ux-design-reviewer`, `mobile-qa` and the independent review all gave READY WITH NON-BLOCKING NOTES,
with no BLOCKER or HIGH. The manager ordered one fix round. As built:

| Finding | Fix | Test (mutation killed) |
|---|---|---|
| M1 a link in flight lost on a workspace switch | a non-final leave asks "A link is still being saved. Leave anyway? You can check it later under the event." and on a yes keeps it (mode `link`, the same key) before the slice is replaced; an answer on a replaced slice that is confirmed or settles ends the wait; the final leave and `beforeunload` count it | 7c, 8 (MK, ML, ML2, MF, MS) |
| M2 a refused Link offered again (`targeted: false` athletes) | the rule counts only `targeted !== false` where the card carries its athletes; `athlete_not_targeted` / `activity_not_targeted` re-read and are remembered | 1a, 11 (MT, MN) |
| M3 Align disappears during other writes | always drawn, off while another write is busy or waits | 5c (MA) |
| M4 the done text behind the sheet | in the panel's `role="status"` line while the links section is shown; the screen's line only when it is not (the panel closed, `event_cancelled`, a 404) | 2, M4 (MM) |
| M5 a check from the calendar line ends silently | "Check linking for …" opens that write's panel (its own, else the event's) and then sends | 7d (MO) |
| M6 Align: no number, an inline step | the line and buttons of the manager's words; the first press shows the step with [Ask for RPE] / [Stop asking] and [Not now]; only the second sends; `has_existing_results` asks in the same row with [Stop asking] / [Not now] (no `confirm()`); `changed: 0` and `notAllowed > 0` say "Some linked trainings can't be changed from here." and hide Align until the event's revision moves; the notices have no count | 5a, 5b, 5c (MP, MB) |
| M7 the refusal sentences | the manager's three sentences | 6 |
| LOW: a planned card's Link to “X” while a link of X waits; its own unconfirmed link | off; the panel's own lock covers every event it offers | 7d, 7e, 8b (MW, MR) |
| LOW F5: two trainings of different owners in one slot | **deviation:** the manager view names no plan owner, and `planId` is per athlete (one plan per athlete), so a key with it would split every Builder batch into one row per athlete. The key now adds the slot's `order`, which separates two trainings in one slot with different orders; two same-named trainings of two owners in the same slot and order stay one row. Separating them needs the owner on `sessionLinks` (a small backend addition, not in K2c-1) | F5 (MG) |
| LOW the hint, the planned line, the refused reason, the load error, the orphaned meta | as worded; the refused reason ("Already linked to another event." / "Can't be linked here.") sits under the row's meta at every width (the simplest form of "stacks under the meta at ≤ 430 px") | 2, 3b, 4, 9, 11 |
| LOW CSS | `white-space: normal; text-align: left` on the Align and Check result buttons | browser |
| LOW the surviving mutations | MC (only the panel's day), ME (the manager view's newer revision), MX (one activity refused, the other keeps Link) | MC/MD/ME, 11b |
| Found in the browser: the "primary" Link to “X” and the step's button looked plain | the app has no base `.primary-button` rule; both now use the calendar's own `plain-button cc-primary` | 3a |

The section order is unchanged: the links, then *Edit* / *Cancel event*.

**Known limit, accepted by the manager for K2c-1 (F5):** two same-named trainings of two different owners in the same
slot and order on one event share one row of *Linked trainings*, and its *Unlink* sends the links of both. The proper
fix, the plan owner on the manager view's `sessionLinks`, is a small backend follow-up and not part of K2c-1.

**Tests after the round:** `central-calendar-links` 24/24; the other four calendar suites 33, 52, 5 and 41, all passing.
28 mutations (the first round's 10 and 18 new), all killed. `--preset frontend-fast` failed in the same files with the
same counts as a clean `origin/main` (`8288b38f`). The build passes and `git diff --check` is clean. Browser check
(Chromium, `npm run e2e:demo`, invented data plus a private coach's plan of a club athlete as the refused pair) at 360,
390 and 1280 px:
- the refused pair's reason and sentence in the panel, with no Link after it;
- the link's text in the panel (the screen's line empty) with the hint;
- the Align step, *Not now* and the confirm;
- no horizontal scroll, no target under 44 px, no JS error.

The console showed a 403 of `/api/tests/athlete/timezone` on load (not this change) and the deliberate 400 of the
refused link.

#### 1.2.2 The last round on `fbb8e170` (2026-11-18)

The narrow re-reviews: `code-reviewer` and `mobile-qa` READY WITH NON-BLOCKING NOTES, `ux-design-reviewer` READY; every
earlier finding closed. Two new MEDIUMs and four LOWs, fixed as follows. The manager checks this delta; no further
review round.

| Finding | Fix | Test (mutation killed) |
|---|---|---|
| N1 a "not targeted" refusal remembered forever | `linkRefused` keeps `{ code, revision }` (the revision the command was sent with). For `athlete_not_targeted` / `activity_not_targeted` the pair counts as refused only while the event's revision is that one. Their row reads "Some athletes are not in this event." | 11, 11c (N1, N1b) |
| N2 a partial Align contradicts itself | `alignBlocked` whenever `notAllowed > 0`, keyed to the re-read revision. With `changed > 0` too, the notice reads "The linked trainings you manage now ask for RPE." (or "…no longer ask for RPE."). The blocked row and the `changed: 0` notice read "Some linked trainings can't be changed from here. Their plan's coach can change them in the Builder." | 5c, 5c' (N2, N2b) |
| LOW the link question on a mere form close | the question runs only when the slice is left (`calendarMayBeLeft({ leavingSlice })`; the form's close passes false). *New event* and the uncertain line's checks are off while a link is in flight, in the markup and in the handlers | 8c (L, L2, L3, L4) |
| LOW `alignStep` survives a re-read | the step keeps the event's revision and `expects`, and is dropped when they no longer match the card | 5d (S) |
| LOW focus in the Align step | the step opens with focus on its primary button; *Not now* returns it to the Align button; after `has_existing_results` focus goes to *Stop asking* | browser |
| LOW the done text out of view on a phone | after a settled command, focus goes to the section's status line (`tabindex="-1"`), else to the "Trainings and activities" heading (`tabindex="-1"`) | browser |

The optional "Open “X”" button was not done (as the manager said).

**Tests:**
- The five calendar suites pass: links 28/28, event-details 33/33, events 52/52, platform-teams 5/5, central-calendar
  41/41.
- `--preset frontend-fast` on the head gave 258 files (pass 252, known-fail 3, fail 3) and 3593 passed, 21 failed of
  3614. A clean `origin/main` (`8288b38f`) gave 257 files (pass 251, known-fail 3, fail 3) and 3566 passed, 21 failed
  of 3587. The failing files are the same with the same counts.
- The build passes and `git diff --check` is clean.
- Mutations: the 9 new ones, plus the three earlier ones whose text moved (ML, MX, M9), are all killed.

**Browser check** (Chromium, `npm run e2e:demo`, invented data: an event whose targets are two athletes; the club's and
the team's "Morning session" of one athlete each; an "Evening session" of the second athlete), at 360 and 1280 px:
- Both Morning trainings share one Linked row, the F5 known limit, as recorded.
- After the link, focus is on the panel's status line, which is in view, also at 360 px with 12 lines of notes.
- The Align step's focus goes to *Ask for RPE*, and *Not now* returns it to the Align button.
- Align over the club's and the team's plan was partial: "The linked trainings you manage now ask for RPE.", the blocked
  row's sentence, and no Align button after it.
- With the second athlete removed from the targets while still linked, the Evening training was offered, refused once
  ("Some athletes are not in this event.", no Link). With the athlete added back (the revision moved), it was offered
  again.
- No horizontal scroll, no target under 44 px, no JS error. The console showed the existing 403 of
  `/api/tests/athlete/timezone` and the deliberate 409.

## 2. K2c-2 — "Make an event" from the Builder (planned)

A button in the Builder's session editor creates the calendar event of that session (its type, day, time and targets
from the session) and links the session in one request (the create route with `sessions`, K2a plan 2.1 (b')). A plan
first, after K2c-1 is in use.

## 3. K3 — "New training" from an event (named only)

It opens the Builder for the event's athletes and week (K2a plan 2.1 (c)). It needs the Builder's week model and a
return context, so it gets its own plan with the Builder.

## 4. The manager's GO for K2c-1 (2026-11-18)

GO as section 1 says, two phases. The UI contract (1.1) gets a GO before any code.
