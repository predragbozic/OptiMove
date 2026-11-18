# Central calendar — K2c plan: the calendar and the Builder, one click apart

Status: **K2c-1 has the manager's GO (2026-11-18)**; K2c-2 is planned; K3 is named only. The owner: „Radi redosledom koji
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

## 2. K2c-2 — "Make an event" from the Builder (planned)

A button in the Builder's session editor creates the calendar event of that session (its type, day, time and targets
from the session) and links the session in one request (the create route with `sessions`, K2a plan 2.1 (b')). A plan
first, after K2c-1 is in use.

## 3. K3 — "New training" from an event (named only)

It opens the Builder for the event's athletes and week (K2a plan 2.1 (c)). It needs the Builder's week model and a
return context, so it gets its own plan with the Builder.

## 4. The manager's GO for K2c-1 (2026-11-18)

GO as section 1 says, two phases. The UI contract (1.1) gets a GO before any code.
