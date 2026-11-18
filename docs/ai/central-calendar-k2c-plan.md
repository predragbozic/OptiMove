# Central calendar — K2c plan: the calendar and the Builder, one click apart

Status: **K2c-1 built, its review rounds fixed (sections 1.2.1 and 1.2.2)**; K2c-2's UI contract has the manager's GO (sections 2.1, 2.2), its backend contract K2c-2-B (2.3) has the manager's GO (2.4) and is built (2.5); K3 is named only. The owner: „Radi redosledom koji
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

### 2.1 The UI contract (K2c-2, written 2026-11-18 against `main` `4a2b07ec`; waits for the manager's GO)

Phase 1 only: no code until the GO. Written against the code as it is on `4a2b07ec` (K2c-1 merged as PR #613).

#### 2.1.1 What exists, and the two gaps found

**The Builder (`frontend/builder-*.js`, `backend/src/routes/builder.js`).**

- A weekly plan is one athlete's plan for one week (`plans.plans`, `plan_type = 'weekly'`, `week_start`). Its days
  are the Builder's blocks (`draft.blocks[]`, each with `date`), and a day's sessions are `block.sessions[]`, each
  with `id`, `amPm` (`AM` / `PM` / ""), `bta` (`B` / `T` / `A` / ""), `time` ("HH:MM" or ""), `name`,
  `rpeEnabled`, `trackingEnabled` (`buildDraft`, `builder.js:1785-1845`). The draft names no `logical_session_id`
  and no `session_order`.
- A batch (one plan per athlete, `builder_batch_id`) is `draft.batch.plans[]` (`id`, `athleteId`, `athleteName`).
- **The Builder never edits a live plan directly.** A new plan is `status: 'draft'` until *Save*
  (`builder-submit-plan`); opening a saved plan makes an **edit draft** (`POST /api/builder/plans/:id/edit`,
  `builder-actions.js:225`): a copy (`isEditDraft: true`, `editSourcePlanId` = the live plan) with its own session
  ids, applied to the live plan only by *Apply changes*. The edit-draft copy keeps the live session's
  `logical_session_id` (`builder.js:2329-2362`).
- Only a live, active, non-draft weekly plan is on the calendar (`WEEKLY_PLAN_SESSION_FILTER_SQL`,
  `trainingLoadAccess.js:239-244`). So **only a saved session can be linked**; an attach of anything else is
  `400 session_not_available`.

**What the calendar calls a planned group.** A planned card (`kind: "planned"`, `calendarQuery.js:930-975`; D16b)
is one card per plan owner + day + slot (AM / PM, B / T / A) + trimmed, case-insensitive session name. It carries
`date`, `title` (the most common spelling), `startTime` (only when every session shares it), `slot { amPm, bta,
order }`, `athleteIds`, `athletes[] { athleteId, planId, sessionId, logicalSessionId, rpe }`, `links { planIds,
logicalSessionIds }` and `expects` / `rpe`. A session linked to an event is folded under the event card (its
`links.planIds` / `logicalSessionIds`) and is not a planned card any more.

**Gap 1 — the create route ignores `sessions`.** K2a plan 4.2 names `sessions?` on `POST /api/calendar/events`
(option (b′), "links in the same transaction"), but it was never built: `validateCreateBody`
(`calendarEventService.js:211-241`) reads no `sessions` field and does not refuse unknown keys, so a body with
`sessions` today creates the event and **silently links nothing**. "Make an event" in one request needs a small
backend change (2.1.10, Q1).

**Gap 2 — the Builder cannot name a calendar session.** The draft has neither the logical id nor the slot order, and
an edit draft's session ids are not the live ones. The contract closes this **without a backend change** by reading
the calendar's own day (2.1.3); Q2 records the alternative.

#### 2.1.2 The entry point

- **Where:** on a weekly plan's session row in the Builder, in `.builder-session-actions`
  (`builder-structure.js:388-395`), after the Training Load controls (`renderSessionTrainingLoadControls`): one
  button **Make an event** (`plain-button cc-builder-event-button`, a calendar glyph plus the words; the words stay
  at every width, so it is never an icon alone).
- **Who sees it** (the client's view; the server decides on every request):
  - the active workspace is `club`, `team` or `private_coach` (the writer bases `club_admin` / `platform_admin` in
    a club, `team_coach`, `private_coach` of v49 `calendar.lock_event_writer`). The platform workspace never gets it
    (the create answers `403 workspace_required`); the athlete workspace and an athlete never do;
  - the plan is weekly (`draft.plan.planType === "weekly"`), not a template, not a program;
  - the session's day has a date (`block.date`).
- **Disabled, with one line under it** (`.cc-builder-event-note`, `role="status"`):
  - a never-saved plan (`status === "draft"` and not `isEditDraft`): "Save the plan first, then make the event.";
  - while any Builder save is pending (`queuedBuilderApi` busy): off, no line;
  - while another "Make an event" of this Builder is in flight or not confirmed (2.1.6): off.
- **Pressing it** opens a small inline panel under the session row (2.1.4) and first reads the session's day
  (2.1.3). Nothing is written by the press.

#### 2.1.3 Finding the session on the calendar (one existing read, no backend change)

On the press, the panel reads `GET /api/calendar?from=D&to=D` (`centralCalendarUrl(D, D, today)`, the calendar's
own read of the active workspace; D = `block.date`) and looks for this session:

- **The live plan id** `L` = `draft.plan.editSourcePlanId` for an edit draft, else `draft.plan.id` (a saved plan
  opened without an edit draft).
- **The planned card** `P` of day D with `P.kind === "planned"`, some `P.athletes[i].planId === L`,
  `P.slot.amPm === (session.amPm || null)`, `P.slot.bta === (session.bta || null)`, and
  `lower(trim(P.title)) === lower(trim(session.name))` (the D16b key; an empty name matches an empty title). Pure
  rule `builderCalendarMatch(draft, block, session, answer)` in the new module (2.1.11).
- **Outcomes of the match:**
  - **exactly one `P`** → the form (2.1.4) over that group: `P.links.logicalSessionIds`, `P.athleteIds`,
    `P.title`, `P.startTime`, `P.rpe`;
  - **an event card** `E` of day D with `E.links.planIds` holding `L` and the same slot and name
    (`E.links.logicalSessionIds` ∩ the folded athletes' sessions) → already linked (2.1.8): "This training is in the
    calendar as “<E.title>”." with **Open in calendar**;
  - **none** → one sentence by cause, no form:
    - an edit draft: "Apply your changes first, then make the event." (the live session differs in name or slot, or
      does not exist yet);
    - a saved plan: "This training is not on the calendar of this workspace." (another workspace's plan, or outside
      the read scope);
  - **more than one `P`** (two cards fit: should not happen under D16b): the same "not on the calendar" sentence;
    never a guess.
- **The read failed:** "The calendar could not be read." with **Try again** (the read again; nothing written).
- **A stale read:** a generation counter (the `training-load-*-data.js` pattern) so a slower answer of an earlier
  press never replaces a newer one.

The match uses the **live** session. An edit draft whose session is unchanged links the live session, which is what
the calendar shows; its unsaved exercise edits do not matter to the link (the link is by slot key, K2a 2.2).

#### 2.1.4 The form (small, pre-filled)

Shown in the inline panel (`<section class="cc-builder-event" aria-labelledby=…>`, heading "Make an event"):

| Field | Pre-filled from | Coach can change |
|---|---|---|
| **Title** | `P.title`, else the session name, else "Training" | yes (text, 1–120, `input` 16 px) |
| **Type** | the workspace's types (`readCentralCalendarCatalog`, `GET /api/calendar/events/types`, already cached per workspace) of `kind === "training"`: the first by the catalog's order | only when the workspace has more than one training-kind type (a `select`); otherwise a quiet line "Type: Training" |
| **Day** | `block.date` | **no** (fixed; the attach needs the session on the event's day). Shown as "Wed 18.11.2026" |
| **Start time** | `P.startTime` (the time every athlete's session shares), else empty | yes (`input type="time"`) |
| **End time** | empty | yes (optional; must be after the start, the server's `checkDaysAndTimes`) |
| **Time zone** | `Intl.DateTimeFormat().resolvedOptions().timeZone` (as the calendar's form) | no, not shown |
| **Who** | `P.athleteIds` as athlete targets (`{ kind: "athlete", id }` each) | **no**. Shown as "12 athletes" with the names folded (the card's `athletes`, names the read already gave) |
| **Ask for RPE** | ticked when the group asks (`P.rpe` not null, i.e. any session asks) | yes (a checkbox). The line under it says what else changes (2.1.5) |

Not in the form (the calendar's own *Edit* covers them later): end day, place, details, notes, expects other than
RPE (`device_data` / `test_result` keep the type's defaults). The coach can *Open in calendar* after the create and
edit there.

- **No training-kind type** in the workspace: no form; "This workspace has no Training event type. A club admin can
  add one in Settings → Calendar." (no button for a coach; a club admin gets **Open Settings → Calendar**).
- Buttons: **Make the event** (`plain-button cc-primary`, the panel's one primary) and **Cancel** (closes the panel,
  writes nothing). Escape closes it too when nothing is in flight.

#### 2.1.5 The one request

`POST /api/calendar/events` through `createCentralCalendarEvent` (the existing 90 s bounded `eventWrite`):

```
{ requestKey,                       // newCentralCalendarRequestKey(), made when sent
  eventTypeId, title, day: D, startTime?, endTime?, timezone,
  expects,                          // the type's defaultExpects with "rpe" added or removed by the checkbox
  targets: [{ kind: "athlete", id }, …],     // P.athleteIds
  sessions: { logicalSessionIds: P.links.logicalSessionIds, alignSessions } }   // needs Q1
```

- **`alignSessions`** (K2a 3.2, D20 option A; K2c-1 sends `false` and keeps Align a visible button):
  - the checkbox **equals** the group's current state → `alignSessions: false` (nothing to change);
  - the coach **changed** it → `alignSessions: true`, and the form said so before sending: "This training will ask
    for RPE too." / "This training will stop asking for RPE." That line is the visible confirmation; nothing changes
    silently. Only plans the workspace manages change (the server's `notAllowed`); the workspace switch is never
    flipped (`switchOff`).
- **RPE off with results:** `409 has_existing_results { resultCount }` (the event is not made, nothing saved) → in the
  panel: "N RPE answers were already given in this training. Stop asking for RPE anyway? The answers are kept." with
  **Stop asking** (a **new** key, `sessions.confirmDisableWithResults: true`) and **Keep asking** (unticks nothing:
  re-ticks the checkbox and sends nothing). The K2c-1 inline step, not `confirm()`.
- One `requestKey` per press of **Make the event**; a refusal leaves nothing saved and its key is not reused.

#### 2.1.6 The outcomes

- **Success** (`201`, or `200` with `verifiedAfterCommitError`): the panel shows "Event made: “<title>”, Wed
  18.11.2026." with **Open in calendar** (`role="status"`, focus on it), plus, from the answer's `alignment`:
  - `notAllowed > 0`: "Some of these trainings belong to another coach's plan and were left as they are.";
  - `switchOff > 0`: "RPE requests are switched off in Training Load, so athletes will not be asked until they are
    switched on.";
  - the calendar cache is dropped (`invalidateCentralCalendarCache`), so the calendar reads fresh when opened.
- **Lost answer** (`centralCalendarOutcomeUnknown`: no answer, the 90 s bound, `503 outcome_unknown`, an unwritten
  5xx): "The result is not confirmed." with **Check result**, which sends the **same** path, body and key (the
  server replays a saved command or answers its refusal; never a second create with a new key). While it waits the
  form is read-only and **Make the event** is gone. A check that answers a code the server gives only after reading
  its request record settles it as "Nothing was saved" with the code's sentence; `try_again` and any other answer
  keep it not confirmed.
- **Refusals** (one sentence, one next step; never a code or an id; `role="alert"` in the panel):

| Code | Sentence | Next step |
|---|---|---|
| `session_already_attached` | "This training is already in another event. Open the calendar to see it." | **Open in calendar** (the day) |
| `session_not_available` | "This training can't be added to an event from this workspace. Nothing was saved." | — (a plan of another workspace, unpublished, or deleted meanwhile) |
| `session_outside_event` | "This training is not on the event's day any more. Nothing was saved." | **Read the day again** |
| `athlete_not_targeted` | "Some athletes of this training can't be part of an event of this workspace. Nothing was saved." | — |
| `target_not_available` | "Some athletes of this training are not in this workspace on that day. Nothing was saved." | — |
| `type_not_available` (the type archived or gone meanwhile), `invalid_type` | "This event type is no longer available. Choose another one." | the catalog read again, the form kept |
| `has_existing_results` | the inline question of 2.1.5 | **Stop asking** / **Keep asking** |
| `workspace_required` (403) | "Open your club's or team's workspace to make events." | — |
| `try_again` | "The calendar is busy. Nothing was saved; try again in a moment." | the button stays |
| `request_key_reused` | "This could not be sent. Nothing was saved; try again." | a new key next press |
| 401 / 403 / 404 | "Please sign in again. Nothing was saved." / "Events cannot be made in this workspace. Nothing was saved." / "This training is not available any more." | — |
| `invalid_*`, other | "Nothing was saved. Try again." | — |

  Every refusal re-reads the day (2.1.3) so the panel shows the current truth (for `session_already_attached`, the
  already-linked line of 2.1.8). The exact codes of the create-with-sessions branch are fixed by Q1's backend PR; the
  sentences are written in `builder-calendar-event.js` with the K2c-1 sentences reused where the code is the same.

#### 2.1.7 Leaving the Builder

- **In flight** (the request sent, no answer yet): leaving the Builder (another tab, the rail, Back, opening another
  plan, a batch pill, closing the plan, a workspace switch) asks once: "An event is still being made. Leave anyway?
  You can check it later in the calendar." On a yes the write is handed to the calendar's uncertain-writes memory
  (`central-calendar-actions.js:259-299`, mode `create`, its `sentBody` and `requestKey`): the calendar line then
  offers **Check result** with the same body and key (the calendar already replays mode `create`). The request's own
  answer, if it lands after the leave, settles that entry (success or a settled refusal removes it).
- **Not confirmed:** the same hand-over without a question on a non-final leave (the line in the calendar is the
  way back); on a final leave (sign-out, a reload, a switch into or out of the athlete workspace) the existing
  `centralCalendarMayBeLeft({ final })` question counts it, because it is in the calendar's memory.
- **`beforeunload`:** a new `handleBuilderCalendarEventBeforeUnload` (registered beside the calendar's in `app.js`)
  returns the browser's dialog while a create is in flight; an unconfirmed one is already counted by
  `handleCentralCalendarBeforeUnload`.
- One new exported function in `central-calendar-actions.js`, `rememberCentralCalendarCreate({ sentBody,
  requestKey })`, wraps the existing `rememberUncertainWrite` for a create not made through the calendar's form; no
  other change to the calendar's memory.

#### 2.1.8 The way back (is this session already in the calendar?)

- **No new read is invented.** The Builder learns it from the day read of 2.1.3, which runs on the press: an event
  card holding the session → "This training is in the calendar as “<title>”." with **Open in calendar**, and no form.
- **After a success in this Builder,** the session row shows a quiet badge "In calendar" (memory only: the Builder's
  slice, keyed by live plan id + date + slot + name; dropped when the Builder closes or the workspace changes). It
  is not shown on a later open of the plan.
- A **persistent** badge on every session row of a week would need one read of the plan's week
  (`GET /api/calendar?from=weekStart&to=+6`) per Builder open, or a field on the Builder's draft — Q3.
- **Open in calendar:** opens the calendar tab on day D with the event's panel (`event:<id>:<D>`) through a new
  small exported function `openCentralCalendarAt({ date, key })` (sets `anchor`, `selectedDate`, `panel`, then the
  existing tab open, `openCentralCalendarFromRail`'s path in `app.js`). It leaves the Builder; the edit draft stays
  in the drafts list as it does on any other leave.

#### 2.1.9 Mobile (360 / 375 / 390 px)

- The button in `.builder-session-actions` keeps `min-height: 44px` at every width (checked against the cascade: the
  ≤ 760 px blocks set `.builder-session-actions .text-action { min-height: 32px }`, `styles.css:8938`, and the
  icon-action rules at `:24754`; the new class gets its own rule under `body:not(.athlete-mode)` so none of them
  shrinks it).
- The panel is a full-width block under the session row; fields stack one per line; **Make the event** and **Cancel**
  are full width at ≤ 390 px, side by side above.
- Every `input` / `select` 16 px (the title, the type, both times); the checkbox has a 44 px label row.
- Names wrap (`overflow-wrap: anywhere`); no horizontal scroll in the Builder at 360 px.
- Selectors: `.cc-builder-event*` (the calendar's prefix), added in the calendar's part of `styles.css`.

#### 2.1.10 Backend: what is needed (Q1)

The smallest change that makes "one request" true, in `calendarEventService.js` only:

- `validateCreateBody` accepts an optional `sessions { logicalSessionIds (1–200 uuids), alignSessions (boolean),
  confirmDisableWithResults? }` with the attach's own validators (`uuidListField`, `booleanField`), added to the
  canonical body **only when sent**, so the request hash of a body without it is unchanged (the K2b-1b rule).
- `createEvent`, after the event and its targets are inserted and before the result: the attach's existing steps on
  the new event — `readLinkableSessions` unlocked, `allLinkable` / the owner's tree, the plans `FOR SHARE` ascending,
  read again, `inEventDays`, `targeted`, not linked elsewhere, the link rows, `alignLinkedSessions` when asked. A
  refusal rolls the whole create back (nothing saved). The lock order is the attach's after the writer lock (no event
  row lock is needed: the row is new in this transaction). One change row (kind `create`, `details.sessions`,
  `details.aligned`) and one request row, as today; the answer adds `attached` and `alignment`.
- Tests on disposable databases: create with sessions (one request row, links, the fold on the next read), every
  refusal leaves no event, the replay, `request_key_reused` with and without sessions, the alignment and its results
  gate, the owner's tree, a concurrent attach of the same slot.
- It touches a transaction, its lock order and idempotency: **external-review trigger 4**, so ★★ (`code-reviewer`,
  `security-reviewer`, the independent review). No migration (v49's operation `create` and its change kinds hold it).

**Fallback if Q1 is no:** the frontend sends two commands: the create (its key), then `POST /:id/sessions` (a second
key). Between them the event exists without the link; a refused or lost second step shows "The event was made, but
the training is not linked yet." with **Link it** (the K2c-1 attach) and **Open in calendar**. More states, more
copy, and a half-done result visible to the coach; not recommended.

#### 2.1.11 Files the code will touch

Frontend (no backend in this list; Q1's backend is its own pull request first):

- **new** `frontend/builder-calendar-event.js` — pure: `builderCalendarMatch`, the form's pre-fill, the request body,
  every sentence (exported for the tests);
- **new** `frontend/builder-calendar-event-actions.js` — the press, the day read with its generation, the send, Check
  result, the leave and `beforeunload` handlers; the view part as `renderBuilderCalendarEventHtml` in the same
  module's view twin **new** `frontend/builder-calendar-event-view.js` (the module pattern);
- `frontend/builder-structure.js` — the button in the session row and the panel's slot under it;
- `frontend/builder-actions.js` — dispatch of `builder-calendar-event` (`data-act`: `open`, `send`, `check`, `close`,
  `retry-read`, `stop-asking`, `keep-asking`, `open-calendar`);
- `frontend/central-calendar-actions.js` — `rememberCentralCalendarCreate`, `openCentralCalendarAt` (two small
  exports; nothing else changes);
- `frontend/app.js` — the leave chain (`builderCalendarEventMayBeLeft` beside `centralCalendarMayBeLeft`), the
  `beforeunload` registration, `openCentralCalendarAt` wiring;
- `frontend/state.js` — **shared**: one new key on the Builder slice, `emptyBuilderState().calendarEvent: null`
  (`{ sessionId, phase: "reading" | "form" | "sending" | "unconfirmed" | "done" | "refused", read, form, requestKey,
  sentBody, message }`) and `calendarEventsMade: []` (the in-memory "In calendar" badges). No other slice changes;
- `frontend/styles.css` — **shared**: `.cc-builder-event*` rules only;
- **new** `frontend/tests/builder-calendar-event.actions.test.mjs`.

#### 2.1.12 Tests

**Suite** `frontend/tests/builder-calendar-event.actions.test.mjs` (JSDOM, the real Builder view / actions and the
new modules, a fake `fetch` that keeps the routes' contracts: `GET /api/calendar` answers planned and event cards of
the K2a-1b shape and, after a create with sessions, the session folded under the new event; `POST
/api/calendar/events` validates the body, replays the same key and body, answers `request_key_reused` for the same key
with another body, and changes nothing on a refusal; `GET /events/types` the catalog):

1. visibility: a weekly saved plan / an edit draft in a club, team and private-coach workspace → the button; a
   template, a program, the platform and athlete workspaces → none; a never-saved plan → disabled with its line;
2. the match: one card → the form with the group's title, time, athletes and RPE; another plan's card, another slot,
   another name → no form and the right sentence; an edit draft with a renamed session → "Apply your changes first";
   an event card holding the session → the linked line with Open in calendar; two fitting cards → no guess;
3. the read: failure → Try again; a slower earlier answer never replaces a newer one;
4. the request: one POST with the exact body (targets = the group's athletes, `logicalSessionIds` = the group's,
   `alignSessions: false` when the checkbox is unchanged, `true` and the line when changed, `expects` follows the
   checkbox, the time zone);
5. success: the notice, Open in calendar opens `event:<id>:<D>`, the "In calendar" badge, the calendar cache dropped;
   `notAllowed` / `switchOff` sentences;
6. `has_existing_results` → the step; Keep asking sends nothing; Stop asking sends a new key with
   `confirmDisableWithResults: true`;
7. every refusal code → its sentence, nothing else changed, the day read again, a new key on the next press;
8. a lost answer → *Result not confirmed* · *Check result* sends the same path, body and key; a settling code ends it;
   `try_again` keeps it; the form read-only meanwhile;
9. one control at a time: a double click sends one POST; a second session's button off while one is in flight;
10. leaving: in flight → the question, on yes the entry is in the calendar's memory with the same key and body and the
    calendar's Check result resends it; unconfirmed → handed over without a question; `beforeunload` while in flight;
11. no id or code in the panel's text (a scan for UUIDs and the codes).

**Mutations** (each must fail a test): match on any athlete's plan id instead of the live plan id; drop the name in the
match; send the session's own id instead of the group's `logicalSessionIds`; target only the session's athlete; send
`alignSessions: true` when the checkbox is unchanged; a new key on Check result; reuse the key after a refusal; settle a
check on `try_again`; drop the generation check; offer the button in the platform workspace; not hand the write over on
leave.

**Then:** the targeted calendar suites (`central-calendar-links`, `-events`, `-event-details`, `central-calendar`)
because two exports are added to `central-calendar-actions.js`; the Builder suites that render the session row
(`builder-*`); the whole `--preset frontend-fast` on the head and on a clean `origin/main` worktree, compared file by
file (known failures on main, not this work: `builder-mobile-section-workflow` 16c (manifest),
`exercise-editor-thumbnail`, `exercise-media-thumbnail`, `training-load.actions`); the build; `git diff --check`.

**Browser check:** Chromium through `npm run e2e:demo` (a disposable database, invented data: a club with a team, a
saved weekly plan of four athletes from one Builder batch with a "Morning session"), at 360, 375, 390 and 1280 px:
open the plan (an edit draft), Make an event, the event appears on the calendar with the training folded under it,
pressing the button again shows the linked line, a refused case (a session already in an event), no horizontal
scroll, no target under 44 px, no input under 16 px, no JS error. Q1's backend must be merged first for this check
(or run on its branch).

**Reviews** (after the code, on a frozen head): `code-reviewer`, `ux-design-reviewer` (a new coach flow),
`mobile-qa`, then the independent review and the manager's gate. Q1's backend pull request has its own ★★ reviews.

#### 2.1.13 Open questions for the manager (each with a recommendation)

1. **The backend change for `sessions` on create (2.1.10).** Recommend **yes**, as its own small ★★ pull request
   before the frontend: `calendarEventService.js` and its suite only, no migration, no route added. Without it the
   "one request" of the brief is impossible; the fallback (two commands) shows a half-done event to the coach.
2. **Naming the session: the calendar read vs a Builder field.** Recommend **the calendar day read** (2.1.3): no
   backend, and it gives exactly the group K2c-1 links (D16b) and the "already linked" fact. The alternative is
   `logicalSessionId` on `buildDraft`'s sessions (a read-only field in `builder.js`), which still needs the calendar
   read for the group and the link state, so it adds nothing for K2c-2.
3. **A persistent "In calendar" badge on the Builder's session rows.** Recommend **not in K2c-2** (memory only after
   a success, and the press shows the truth). Later: one week read per Builder open, or a field on the draft.
4. **Targets: athletes or the team?** The form targets the group's athletes one by one (every one must be a target,
   `athlete_not_targeted`). In a team workspace, when the group is the whole team on that day, a team target would
   follow later roster changes. Recommend **athletes only in K2c-2** (simple, exact, the private coach's only form);
   a "the whole team" option later if coaches ask.
5. **RPE in the form.** Recommend the **one checkbox** of 2.1.4–2.1.5 (pre-set from the training, `alignSessions`
   only when the coach changes it, the change stated before sending). The alternative (the type's defaults,
   `alignSessions: false`, Align later in the calendar) leaves a fresh event that disagrees with its training.
6. **Which type when the workspace has several training-kind types?** Recommend the first by the catalog's order, a
   `select` only when there are several; no type of kind `training` → the sentence of 2.1.4.
7. **An edit draft with unsaved changes to the session's name or slot.** Recommend the sentence "Apply your changes
   first, then make the event." (no guess, no link to a session the coach is still changing).
8. **K2c-1's open LOW F5 (the plan owner on `sessionLinks`)** is not needed here and stays a follow-up.

### 2.2 The manager's GO (2026-11-18)

GO on 2.1 at `adb22ce4`, with these decisions. Where they differ from 2.1, they win.

1. **`sessions` on create: yes, as its own ★★ backend pull request, K2c-2-B, before the frontend.**
   - K2a plan 2.1 (b′) planned it; `validateCreateBody` never built it.
   - K2c-2-B is stacked on PR #614 (`claude/central-calendar-k2b2a-1`, K2b-2a-1, migration v81, not merged), which
     changes `createEvent` for `questions`; the two must agree on RPE's one channel. The branch
     `claude/central-calendar-k2c-2-backend` is made from #614's frozen head, and this docs branch is merged into it
     (`git merge --no-edit`, no rebase).
   - **Before any code**, its technical contract is written as section 2.3 and gets its own GO. It fixes:
     - the canonical body: `sessions: { logicalSessionIds, alignSessions, confirmDisableWithResults? }`, in the
       canonical body only when sent (today's hashes unchanged), validated by the attach route's own validators;
     - the lock order under `.claude/rules/migrations.md`: every lock before the first write, proven by a
       recorded-SQL-order test. So the attach's plan and session locks come **before** the event INSERT. The exact
       order: users-first rights → the writer lock → the type `FOR SHARE` → the attach's locks → #614's questions'
       locks (Training Load, Tests, the day key) → the first write, and how it merges with #614's create order;
     - atomicity: a refusal of any attach step rolls back the whole create, nothing written;
     - the codes: the attach's, unchanged;
     - idempotency: the same key replays the saved answer; the same key with other `sessions` is
       `request_key_reused`;
     - the interplay with #614's questions: `sessions` that carry RPE and no `questions` sent → the type's RPE default
       is skipped, named in `questionsSkipped`, and the create succeeds; `sessions` plus explicit `questions` with RPE
       → `rpe_from_sessions`, the whole create rolled back;
     - the tests: every basis and the identical 404; replay and a lost COMMIT; atomicity through a refusal on each
       attach step; the hash of a body without `sessions` unchanged; the interplay; races of the attach's locks
       against a concurrent attach or detach; the recorded SQL order; mutations on each guard;
     - the reviewers: `code-reviewer` and `db-reviewer`, then the independent review and the OptiMove manager's gate.
   - **Follow-up, not in K2c-2-B:** the create route does not refuse unknown keys.
2. **Naming the session through the calendar day read (2.1.3): yes, no backend change.** More than one matching card
   (the same plan, slot and name) → one sentence, nothing made, never a guess. The server's attach checks stay the
   guard.
3. **No persistent "In calendar" badge** (2.1.8): a follow-up.
4. **Targets: the group's athletes one by one** for K2c-2. **Follow-up:** target the team when the plan's assignment
   is a team.
5. **RPE: no checkbox.** This replaces the RPE row of 2.1.4, the `alignSessions` and `has_existing_results` parts of
   2.1.5, the `has_existing_results` row of 2.1.6, and test 6 of 2.1.12 (and the "`alignSessions: true` when the
   checkbox is unchanged" mutation):
   - the event's `expects` follows the training: `rpe` when the group asks for it (`P.rpe` not null), not otherwise;
     the type's other defaults stay as they are;
   - `alignSessions: false` always;
   - a coach changes RPE in the Builder session, where it lives. One question per screen, and `has_existing_results`
     never comes up from this button.
6. **The type:** the first `training`-kind type in catalog order, a select only when there are several; none → one
   sentence pointing to Settings → Calendar. As 2.1.4.
7. **An edit draft with unapplied changes to the session's name or slot:** "Apply your changes first, then make the
   event." As 2.1.3.
8. **K2c-1's LOW F5** stays a follow-up.

**The order of the stream's pull requests:** #614 → K2b-2a-2a (the Tests option) → **K2c-2-B** (backend) → K2b-2a-2b
(the coach screens; it also touches `central-calendar-actions.js`) → **K2c-2-F** (the Builder frontend, on
`claude/central-calendar-k2c-2`, merged with K2c-2-B's head). The frontend's two exports in
`central-calendar-actions.js` stay small, so the merge with K2b-2a-2b is trivial.

**Next:** section 2.3 on `claude/central-calendar-k2c-2-backend` once #614's frozen head is known; no code before its
GO.

### 2.3 K2c-2-B — the technical contract: `sessions` on create (written 2026-11-18; waits for the manager's GO)

★★: one transaction, its lock order and idempotency (external-review trigger 4). Backend only, **no migration, no new
route**. Branch `claude/central-calendar-k2c-2-backend`, made from PR #614's frozen head `e98a7378` (K2b-2a-1,
migration v81, with `main` `4a2b07ec` merged in), with this docs branch merged into it. Written against that head; the
line numbers below are of `backend/src/calendarEventService.js` there.

#### 2.3.1 What exists on `e98a7378`

- `createEvent` (`:822-882`), through `runEventCommand` (`:695-`) and the calendar's one runner
  (`calendarCommandRunner.js`): BEGIN, `lock_timeout` 15 s; `prepare` (the owner and basis from the active
  workspace, the request hash, `calendar.lock_event_writer`, which since v54 locks users first, then the role, then
  the owner team / club `FOR SHARE`); the requestKey replay after the locks, under a transaction-scoped advisory lock
  on (table, user, key); `apply`; the request and change rows; a bounded COMMIT (15 s, then the request looked for on
  a new connection for 5 s: `verifiedAfterCommitError` or `503 outcome_unknown`).
- In `apply`, before the first write (#614's order, its plan 9.1.4): the type `FOR SHARE` (`resolveType`) → the
  targets resolved (reads, no lock) → the place `FOR SHARE` → the details `FOR SHARE` → the club's question switch
  `FOR SHARE` (`lockQuestionState`; no event yet, so no event questions) → `planQuestions` (reads) → the day keys and
  a Day off's assignments (`lockDaysAndDayOff`: the club's day advisory keys ascending, then the open Tests
  assignments it cancels `FOR UPDATE`). Then the writes: the RPE question's schedule (`applyRpeBeforeEventWrite`),
  the event, its targets, its details, the WELLNESS questions, the Day off's cancellations, the view.
- The attach (`attachSessions`, `:1518-1582`): the event row `FOR NO KEY UPDATE` (prepare) → the question state →
  the sessions decided on an **unlocked** read (`readLinkableSessions`, `allLinkable`: in the caller's calendar scope
  on its day, a published weekly session, a plan inside the event owner's tree) → the plans `FOR SHARE` in ascending
  id (`lockPlansForShare`) → the sessions read again (`FOR UPDATE of ps` in ascending id when aligning) and judged
  again: the event's days, every athlete a target on that day, no live link of the slot to another event → the
  link rows → the alignment (`alignLinkedSessions` → `writePublishedSessionFlags`, which locks the edit-draft copies
  `FOR UPDATE` in ascending id, then writes) → the event's RPE question ended `replaced_by_sessions` when there was
  one → the revision.
- The attach's "targeted" is a SQL `exists` over `calendar.event_targets` of the stored event
  (`eventTargetsAthleteSql`, `:1366-1371`). A create has no stored targets before its INSERT, so it needs the same
  rule over the targets it resolved (2.3.4).
- `planQuestions` (`:1800-`) already skips the RPE default and refuses an explicit RPE ask with `rpe_from_sessions`
  when the event has a live session link (`Q.hasLiveSessionLinks`), which is always false for a create.
- The v49 link trigger (`event_session_links_before_write`) checks a new link's event is planned, its day inside the
  event's days and its slot a published session; the unique index `event_session_links_one_live_per_slot` is the
  backstop of "one live link per slot". v49's request operation and change kind `create` hold a create that also
  links: no migration.

#### 2.3.2 The request body (the canonical body and its hash)

```
POST /api/calendar/events
{ …the create body of K2a / K2b-1b / K2b-2a-1, unchanged…,
  sessions?: { logicalSessionIds: [uuid, …],     // 1–200, MAX_LINKED_SESSIONS
               alignSessions?: boolean,           // default false
               confirmDisableWithResults?: boolean } }   // default false
```

- Validated by the attach's own validators: `uuidListField(sessions, "logicalSessionIds", "invalid_sessions",
  { max: MAX_LINKED_SESSIONS })` (lower-cased, deduplicated, **sorted**), `booleanField(sessions, "alignSessions",
  "invalid_align")`, `booleanField(sessions, "confirmDisableWithResults", "invalid_confirm")`. `sessions` present but
  not a plain object → `400 invalid_sessions`. Unknown keys inside `sessions` are ignored, as everywhere in this
  route today (the follow-up of 2.2).
- `canonical.sessions = { logicalSessionIds, alignSessions, confirmDisableWithResults }` is added **only when
  `sessions` is sent** (the K2b-1b rule), so the hash of every body without it is byte for byte what it is today
  (`requestHash(canonical, { eventId: null, owner })`).
- **Idempotency** (the runner, unchanged): the same key and the same canonical body → the saved answer, read again
  now; the same key with another `sessions` (other ids, another flag, `sessions` added or dropped) → `409
  request_key_reused`; a refused request writes no row, so its key stays free. The ids being sorted, two orders of
  the same ids are the same request.

#### 2.3.3 The lock order of a create with `sessions` — every lock before the first write

```
prepare (unchanged)
 1. calendar.lock_event_writer(user, owner, basis)    users FOR SHARE → the role row → the owner team / club FOR SHARE (v54)
    the requestKey replay (after the locks, the runner's key lock)
apply — no write until step 9
 2. the type FOR SHARE                                 resolveType
 3. the targets resolved                               reads only (membership on the event's first day)
 4. the place FOR SHARE, the details FOR SHARE         K2b-1b
 5. the club's question switch FOR SHARE               lockQuestionState(eventId null)
 6. the sessions (new, the attach's steps):
    6a. decided on an unlocked read                    readLinkableSessions over the resolved targets (2.3.4); allLinkable
    6b. the plans FOR SHARE, ascending id              lockPlansForShare
    6c. read again; FOR UPDATE of ps, ascending id,     then judged: the event's days, every athlete targeted, no live link
        only when alignSessions                         to another event (2.3.5)
    6d. alignSessions only: the edit-draft copies       moved out of writePublishedSessionFlags's first statement into its
        FOR UPDATE, ascending id                        own lock step here (2.3.6)
 7. planQuestions                                      reads; the RPE ask skipped / refused because sessions are sent (2.3.7)
 8. the day keys and a Day off's assignments           lockDaysAndDayOff (#614's step 6)
--- the first write ---
 9. the alignment's flag writes (alignSessions only)    then #614's writes unchanged: the RPE question's schedule (never,
                                                         with sessions), the event, its targets, its details
10. the session links (one multi-row INSERT)            after the targets, so the read back sees them
11. #614's after-writes: the WELLNESS questions, the Day off's cancellations; the view; the request and change rows
```

- **How it merges with #614's create order:** #614's steps (writer lock → type → targets → place → details → question
  switch → questions' reads → day keys → writes) are kept, and the session steps 6a–6d go between the question switch
  (step 5) and `planQuestions` (step 7). This is **the attach's own order** (on `e98a7378` the attach takes the
  question state before the plans), so a create and an attach take calendar → plans → Day off in the same order.
  The order the manager listed (the attach's locks before "the questions' locks") is kept for every lock that can
  wait on a writer: the Training Load and Tests locks of the questions and the day keys all come after the plans.
  The one difference is the club's question switch: a `FOR SHARE` on one `calendar.club_question_settings` row,
  before the plans, as in the attach. Taking it after the plans would give the create and the attach two orders of
  the same two locks; both are shared, so neither order can deadlock against the other, but one order is simpler to
  prove (Q1 of 2.3.10).
- **Why no cycle with the Builder:** a Builder save, delete or batch sync takes its plan `FOR UPDATE` and never a
  calendar row; the create holds the plans `FOR SHARE` and waits only on rows the Builder never holds after it. A
  Builder *Apply changes* of an edit draft takes the draft's own plan, not the live one first; the alignment's
  draft-copy lock (6d) is the attach's existing order (the plan, then the copies) and is taken before the first write.
  The db-reviewer checks this against `applyEditDraft` (`routes/builder.js`); the race tests of 2.3.9 run it.
- **Foreign-key checks after the first write:** the link INSERT's foreign keys take `FOR KEY SHARE` on the plan and
  the event inside the server; the plans are already held `FOR SHARE` (stronger) and the event is this transaction's
  own row, so they never wait. They are not SQL the service sends, so the recorded-order test does not list them.
- `55P03` (the 15 s `lock_timeout`) and `40P01` anywhere → `409 try_again`, nothing written (the runner).

#### 2.3.4 "Targeted" before the event exists

- `readLinkableSessions` gets a second source of targets: instead of the stored event
  (`calendar.event_targets tg where tg.event_id = $2`), the resolved list `unnest($k::text[], $m::uuid[]) as
  tg(target_kind, target_id)`. The rule is the same SQL: an athlete target is the athlete; a team or club target is a
  membership on **the session's own day** (`membershipOnDaySql`), as the attach judges it.
- One builder, `targetsAthleteSql(source, athleteExpr, dayExpr)`, makes both forms, and the attach keeps its stored
  form. A test runs the attach and a create over the same targets and sessions and asserts the same `targeted`
  answer for every athlete (team, club and athlete targets; a member who left the day before).
- The event's days for the checks of 6c are the body's `day` / `endDay` (`inEventDays` over `{ day, end_day }`).

#### 2.3.5 Atomicity and the codes

- Every check of 6a–6c runs **before the first write**. A refusal throws and the runner rolls the transaction back:
  no event, no target, no detail, no question, no schedule, no link, no request row, no change row.
- The codes are **the attach's, unchanged** (K2a plan section 11):

| Step | Code |
|---|---|
| the body | `400 invalid_sessions`, `invalid_align`, `invalid_confirm` |
| 6a / 6c | `400 session_not_available` (missing, unpublished, outside the caller's calendar scope on its day, a plan outside the event owner's tree — one answer) |
| 6c | `409 session_outside_event` (a session not on one of the event's days) |
| 6c | `409 athlete_not_targeted { count }` |
| 6c, and the unique index under a race | `409 session_already_attached` |
| 9, the alignment | `409 has_existing_results { resultCount }` (RPE off over results, without `confirmDisableWithResults`) |
| 7, #614 | `409 rpe_from_sessions` (an explicit RPE question with sessions, 2.3.7) |

- The order of the checks (so a body with two faults gets one known answer): the body's validation; then the
  create's own (type, targets, place, details, schedules); then 6a's `session_not_available`; then 6c's in the
  attach's order (`session_not_available` again, `session_outside_event`, `athlete_not_targeted`,
  `session_already_attached`); then 7 (`rpe_from_sessions`); then 9's results gate.
- `rpe_already_answered` cannot happen on a create (no question exists yet).

#### 2.3.6 The alignment on create

- `alignSessions: true` aligns the named sessions to the new event's `expects`, as the attach does (D20 option A):
  RPE on with tracking, or RPE off; only on plans the workspace manages (`notAllowed`); the switch never touched
  (`switchOff`); RPE off over results needs `confirmDisableWithResults` (else `has_existing_results`, nothing saved).
  The Builder sends `false` (decision 5 of 2.2); `true` is for the API's completeness and for a later screen.
- To keep "every lock before the first write", `writePublishedSessionFlags` (`plannedSessionFlags.js`) is split into
  its two existing statements: `lockDraftCopiesForFlags(client, sessions)` (the `FOR UPDATE of ps2` select, ascending
  id) and the write that takes the locked copies' ids. The quick toggles and the attach call both, in the same order
  as today, so their SQL and order do not change; the create calls the lock in step 6d and the write in step 9. A
  test pins the quick toggles' and the attach's recorded SQL unchanged.
- The results gate (`session_feedback` count) is a read and stays where the alignment decides it, before its write.

#### 2.3.7 The interplay with #614's questions (one RPE channel)

- With `sessions` sent, the new event will hold a live session link, so it is **the RPE channel** (#614 plan 9.1.5:
  "an event with a live planned-session link answers `rpe_from_sessions` to an RPE ask"). `planQuestions` gets
  `sessionsLinked: true` from the create, and its RPE branch reads `sessionsLinked || Q.hasLiveSessionLinks(...)`:
  - **no `questions` sent** and the switch on: the type's RPE default is **skipped** and named in the answer's
    `questionsSkipped: ["rpe"]` (and the change row's `details.questionsSkipped`); WELLNESS defaults are asked as
    today; the create succeeds;
  - **`questions` sent with RPE:** `409 rpe_from_sessions`, the whole create rolled back;
  - `questions` sent without RPE: as today.
- "Sessions that carry RPE": the rule is the link, not the sessions' flags, as #614 decided for the attach. A link to
  sessions that do not ask for RPE still makes the sessions the event's RPE channel; the event's `expects` (the
  Builder sends `rpe` only when the training asks, decision 5) and the calendar's alignment note say the rest. Q2.
- `externalScheduleId` sent with `sessions`: as the attach allows today (a referenced schedule beside linked
  sessions; the read adds both). No new refusal.

#### 2.3.8 The answer, the record, the replay

- `201 { event, attached: N, alreadyAttached: 0, alignment | null, …#614's questionsAsked / questionsSkipped /
  dayOffCancelled when it has them }`. `alreadyAttached` is always 0 on a create (a slot linked to another event is
  refused; to this event is impossible); kept for the attach's answer shape.
- The stored result keeps the counts beside the ids (the K2a-1b rule), so a replay and a verified lost COMMIT answer
  the same counts. Never a name or a note in the request row.
- One change row, kind `create`; its `details` add `sessions: N`, `planIds` (sorted), and with an alignment `align`,
  `aligned`, `notAllowed`, `switchOff` (the attach's detail keys). One request row, operation `create`. The event's
  revision stays the create's (no bump: the links are written in the create).
- The realtime / notification step of #614 after the COMMIT is unchanged.

#### 2.3.9 Tests (disposable databases, the real routes, `backend/tests/central-calendar-k2c-2-create-sessions.test.mjs`)

1. **Bases and the identical 404 / 403:** a club admin, a platform admin in the club's workspace, a team coach, a
   private coach each create with sessions; the platform workspace → `403 workspace_required`; an athlete → 403; a
   session of a plan outside the owner's tree (a sibling team's, a private coach's of a club athlete, another club's)
   → `session_not_available`, identical to a missing id.
2. **The fold:** after the create the next `GET /api/calendar` shows the group folded under the new event, no planned
   card; `GET /events/:id` lists the session links.
3. **Atomicity, one refusal per step,** each asserting no event, target, detail, question, schedule, link, request or
   change row: `invalid_sessions` (not an object, empty, 201 ids, not uuids), `invalid_align`, `invalid_confirm`,
   `session_not_available` (each cause), `session_outside_event`, `athlete_not_targeted` (team, club and athlete
   targets; a member on another day), `session_already_attached`, `has_existing_results`, `rpe_from_sessions`; and a
   fault injected after the first write (a seam) rolls everything back.
4. **Idempotency:** replay → the same answer and counts, one event, one request; the same key with other ids, another
   flag, `sessions` dropped or added → `request_key_reused`; the ids in another order → the replay; a double submit
   (two concurrent requests, one key) → one event.
5. **The hash:** a body without `sessions` hashes exactly as before (a pinned hash of a fixed body, computed on
   `e98a7378` and asserted after the change); a create without `sessions` behaves byte for byte as before (#614's
   suite green unchanged).
6. **A lost COMMIT:** the commit seam times out → `verifiedAfterCommitError` with the counts when the request is
   found; `503 outcome_unknown` when it is not; never "nothing saved" after a sent COMMIT.
7. **The interplay:** switch on, a type with RPE and WELLNESS defaults, no `questions` → RPE skipped and named,
   WELLNESS asked, no RPE schedule; explicit RPE → `rpe_from_sessions`, nothing saved; explicit WELLNESS only → as
   today; switch off / not installed → as today.
8. **"Targeted" equals the attach's** (2.3.4) for the same targets and sessions.
9. **The alignment:** RPE on over unaligned sessions, RPE off with and without results and the confirmation, a plan
   the workspace does not manage (`notAllowed`), the switch off (`switchOff`), an edit-draft copy updated in the same
   transaction; the quick toggles' and the attach's recorded SQL unchanged by the split.
10. **Races:**
    - a create and an attach of the same slot to another event, both directions (each held at the seam after its
      locks): one wins, the other `session_already_attached`, never two live links (also through the unique index,
      the mapped `23505`);
    - a create while a detach of the same slot from another event commits: the create waits and then links;
    - a create while a Builder delete or batch sync of the plan holds it `FOR UPDATE`: the create waits, then
      `session_not_available` (or links, when the sync kept the slot);
    - a create with `alignSessions` against an *Apply changes* of the plan's edit draft;
    - a create against a Day off of the same club and day, and against a Tests materialization holding the day key;
    - none ends in a `40P01`; a `lock_timeout` ends in `try_again`.
11. **The recorded SQL order** (the rule of `.claude/rules/migrations.md`): the create's SQL recorded through the
    client seam; asserted: the order of steps 1–8 (writer lock, type, place, details, the switch, the plans
    ascending, the sessions, the draft copies, the day keys), no locking clause before the writer lock, and **no
    locking clause (`for share`, `for update`, `for no key update`, `pg_advisory_xact_lock`) between the first write
    and the COMMIT**; with and without `alignSessions`, with and without questions, with a Day off type.
12. **Mutations** (each must fail a test): drop `canonical.sessions` from the hash; add it when not sent; take the
    plans after the event INSERT; skip the unlocked decision (lock first); judge `targeted` on the stored event (none
    yet); drop the "days" check; drop the "linked elsewhere" check; drop the `23505` mapping; skip the RPE default
    without `sessions`; not refuse an explicit RPE with `sessions`; leave the draft-copy lock inside the write; write
    the links before the targets; not store the counts for the replay.

Then `--preset backend-fast` and the calendar suites (`central-calendar-k2a-1b`, `-k2b2-questions`, `-k2b-settings`,
`-k1a`), the T1 disposable kind for the touched families, `git diff --check`. `test:backend:shared` is not run (no
local OPTIMOVE database here; the same note as #614's).

**Reviewers:** `code-reviewer` and `db-reviewer` (the locks and the transaction) on the frozen head, then the
independent review and the OptiMove manager's gate.

#### 2.3.10 Open questions (each with a recommendation)

1. **The question switch before the plans** (2.3.3): recommend **yes**, the attach's own order, so a create and an
   attach take calendar → plans → Day off alike. Both are `FOR SHARE`, so the other order would not deadlock either;
   one order is the simpler proof.
2. **The RPE channel is the link, not the sessions' flags** (2.3.7): recommend **yes**, #614's rule. With the
   Builder's decision 5 the event expects RPE exactly when its training asks, so the two agree in practice.
3. **Splitting `writePublishedSessionFlags`'s lock from its write** (2.3.6): recommend **yes**, the smallest change that
   keeps the rule for an aligning create, with the existing callers' SQL pinned unchanged. The alternative is to
   refuse `alignSessions: true` on a create (`400 invalid_align`) and keep the shared function as it is: smaller, and
   the Builder never sends it; but the API then differs from the attach.
4. **Unknown keys on create** stay a follow-up (2.2); this PR adds none and refuses none.

### 2.4 The manager's GO on 2.3 (2026-11-18)

GO on 2.3 at `2554860d`, with these decisions. Where they differ from 2.3, they win.

1. **Q1: yes.** The club's question switch `FOR SHARE` comes before the plans, the attach's own order.
2. **Q2: yes.** The RPE channel is the session link, not the sessions' flags.
3. **Q3: the smaller option.** On create, `sessions.alignSessions` is absent or `false`; `true` is `400 invalid_align`
   ("Create the event first, then align its trainings."), nothing written. `sessions.confirmDisableWithResults` is not
   accepted on create (it only matters when aligning): the same 400. `writePublishedSessionFlags` is **not** split; the
   attach and the quick toggles stay byte for byte the same. The Builder sends `alignSessions: false` (decision 5 of
   2.2); a coach aligns afterwards from the event's panel (K2c-1). So:
   - the canonical `sessions` is `{ logicalSessionIds }`, sorted and deduplicated, pinned in the hash test;
   - 2.3.6 does not apply, step 6d of 2.3.3 and the alignment of step 9 go, `has_existing_results` cannot happen on a
     create, and the answer's `alignment` is always `null`;
   - the alignment tests (2.3.9 group 9, the draft-copy race of group 10) and the mutation "leave the draft-copy lock
     inside the write" are replaced by: `alignSessions: true` and `confirmDisableWithResults` (either value) → 400,
     nothing written.
4. **Q4: yes.** Unknown keys on create stay a follow-up.
5. **The "targeted" builder with two sources: yes**, with two guards: a test that the attach's SQL and answers are
   unchanged for stored targets, and the equality test between the attach and the create. The builder decides who
   counts as a member on a day, so it is part of the audience contract: a narrow `security-reviewer` pass on it.

**Reviews** after the code, on a frozen head, with the full packet of `CLAUDE.md` (the Agent input contract):
`code-reviewer`, `db-reviewer` (the locks and the transaction) and `security-reviewer` (narrow: the targeted builder
and the create rights); then the independent review and the OptiMove manager's gate. ★★ trigger 4, no migration.

**Before the report, with real counts on the head:** the new suite and its mutations; `--kind disposable --filter
central-calendar`; `--filter tests-`; `--filter training-load-external`; `--preset backend-fast`; `git diff --check`.
The manager opens the pull request after its check. Base: this branch on #614's head `e98a7378`; `main` is merged in
when #614 merges.

### 2.5 K2c-2-B as built (2026-11-18)

Built on 2.3 with the GO of 2.4; backend only, no migration, no new route. One file of code,
`backend/src/calendarEventService.js`, and one new suite.

- **The body:** `createSessionsField` reads `sessions` only when sent: an object, `logicalSessionIds` through the
  attach's `uuidListField` (sorted, deduplicated, 1–200), `alignSessions` absent or `false`, no
  `confirmDisableWithResults` (either is `400 invalid_align`, "Create the event first, then align its trainings.").
  `canonical.sessions = { logicalSessionIds }` only when sent.
- **The create:** after the club's question switch (`lockQuestionState`) and before `planQuestions`: the unlocked
  read over the resolved targets, `allLinkable`, `lockPlansForShare`, the read again, `judgeSessionsForLink`; a test
  seam `testHooks.afterSessionLocks`. `planQuestions` takes `sessionsLinked`. The links are written after the event,
  its targets and its details (`insertSessionLinks`), before #614's after-writes. The answer and the stored result
  carry `attached`, `alreadyAttached: 0`, `alignment: null` beside #614's question counts; the change row's details
  add `sessions` and `planIds`.
- **Shared with the attach, its SQL unchanged:** `judgeSessionsForLink` (the attach's checks in its order, `eventId`
  null meaning any live link is another event's) and `insertSessionLinks` (the attach's INSERT, moved);
  `eventTargetsAthleteSql` now returns `targetsAthleteSql` over the stored targets with the same text; the create's
  source is `unnest($2::text[], …) as tg(target_kind, target_athlete_id, target_team_id, target_club_id) where true`.

**Deviations from 2.3, both found by the tests:**
- **A detach racing a create (2.3.9, group 10):** the contract said the create "waits and then links". Under READ
  COMMITTED the create's read sees the link still live until the detach commits, so it answers
  `session_already_attached` at once; once the detach has committed, the create links. Test 6b pins that behaviour.
- **An external schedule with sessions** (the db-reviewer's LOW-2): a create with `externalScheduleId` and `sessions`,
  with the question switch off or not installed, makes an event with both, as the attach allows today. "The RPE
  channel is the session link" (2.4 Q2) governs the event's own RPE question; it adds no refusal of a referenced
  schedule.

**Tests:** `backend/tests/central-calendar-k2c-2-create-sessions.test.mjs`, 17 tests in the groups of 2.3.9 as
amended by 2.4 (bases and the identical answers, the body, a refusal at each attach step with nothing written, a
fault after the first write, replay and `request_key_reused`, the hash pin against `e98a7378`, a lost COMMIT, the
interplay with the questions, the attach's targeted SQL pinned and the attach equal to the create in seven
target scenarios, the races against an attach in both orders, a detach, a Builder lock and a foreign plan held, a Day
off, and the recorded SQL order for a training and a Day off). 17 mutations, all killed (the first form of M12 was
equivalent on v81 and was replaced by one that drops the link counts).

**The review round on `7050b1cb`** (`code-reviewer`, `db-reviewer`, narrow `security-reviewer`; all READY WITH
NON-BLOCKING NOTES on the code, no BLOCKER or HIGH):

| Finding | Fix | Test (mutation killed) |
|---|---|---|
| db MEDIUM-1: a create against the Training Load quick toggle of the same session not shown free of a cycle | a route-against-route test in both orders, the create held at its session locks | 8 |
| db MEDIUM-2: empty targets | already refused by the body (`invalid_targets`) before the transaction; pinned | 8b |
| code LOW: 6(b) proved the unique-index wait with a 300 ms sleep | the wait is proven in `pg_stat_activity` (`wait_event_type = 'Lock'` on the link INSERT) before the gate opens | 6 (M8) |
| code LOW: 6c's "the create waited" was vacuous | the wait on the plan lock is proven in `pg_stat_activity` before the delete | 6c (M3, M4) |
| code LOW: 6d and 8 claimed "no 40P01" from unforced concurrency; 8 could hang | 6d holds each command at a seam while the other runs, in both orders; 8's toggle is bounded at 5 s | 6d, 8 |
| code LOW: a `lock_timeout` not staged | the plan held `FOR UPDATE`, `lock_timeout` 200 ms → `409 try_again`, nothing written | 6e |
| code LOW: no multi-day test | a session on the second day links; one after the span is `session_outside_event` | 2d (M18) |
| db LOW-2: an external schedule with sessions | one sentence above | — |
| security LOW-1: `targetsAthleteSql`'s source must end in `where` | recorded; the comment says so | — |
| security LOW-2: a 409 tells a caller that a session it sees is linked elsewhere | as the attach; recorded for the later info-hiding pass | — |
| security LOW-4: a replay after a revoked right | the runner takes the writer lock before the replay (unchanged); covered by the K2a suites' right-lost test | — |

21 tests; 18 mutations, all killed (M18: a multi-day event judged on its first day only).

## 3. K3 — "New training" from an event (named only)

It opens the Builder for the event's athletes and week (K2a plan 2.1 (c)). It needs the Builder's week model and a
return context, so it gets its own plan with the Builder.

## 4. The manager's GO for K2c-1 (2026-11-18)

GO as section 1 says, two phases. The UI contract (1.1) gets a GO before any code.
