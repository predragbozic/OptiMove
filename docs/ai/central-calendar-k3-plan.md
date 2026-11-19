# Central calendar — K3 and K2c-3 plan: the Builder and the event, both ways

Status: **Proposed** (2026-11-19, written against `main` `f406ee2d`; K2c-3 and section 7 added on the K4 plan at
`ae82e2fb`, O14 (7.1) on `5231db4d`, O15 (7.2) on `dc360d09`; Q1, Q2, Q4–Q11 decided by the stream manager). Discovery and UI contract only: no code, no migration. It needs the manager's GO, and the owner's
answer to Q3 and the stream manager's to Q12–Q14, before any code.

The owner's goal (O9 of `docs/ai/central-calendar-k4-plan.md`, 2026-11-19): „iz glavnog kalendara je lako kada
ulazimo iz dogadjaja u builder pa kreiramo aktivnosti unutar tog dogadjaja". The coach opens an event, presses
**Plan the training**, and the Builder opens on that day for the event's athletes, with a band naming the event and
**Back to calendar**. The sessions added on that day (Before / Training / After) belong to the event. Saving saves
the plan and links the sessions. Back returns to the event.

The second direction (K2c-3, section 6) is the owner's O10–O13 of 2026-11-19: from the Builder, *Create event →*
opens the calendar's **own** event form, prefilled, with a band and *Back to the Builder*; afterwards each session,
or the whole day, chooses its event in an `Event: [▾]` selector; only the same day (O11); a linked session keeps its
Before / Training / After slot and takes its time from the event (O12); no big change and no migration (O13). The two
directions share one pattern: a band naming where the coach came from, and one way back. Section 7 answers where the
Weekly plan and the athlete's calendar read a linked session's time.

Read with: the K4 plan at `ae82e2fb`, sections 0 (O1–O13), 5.1, 5.2 and 6 (branch `claude/central-calendar-k4-plan`);
the K2c plan, sections 1 (K2c-1), 2 (K2c-2) and 3 (K3, named only).

## 1. Discovery (facts, file:line on `f406ee2d`)

### 1.1 The Builder's week model

- **A weekly plan is one athlete's plan of one week.** `POST /api/builder/plans` with `planType: "weekly"`,
  `weekStart` and `athleteIds` (`backend/src/routes/builder.js:423-500`) inserts **one plan per athlete**, all
  `status = 'draft'`, sharing one `builder_batch_id` when there is more than one athlete (`:437`, `:474-477`). The
  plans are stamped with the creating coach's **active workspace** as owner (`resolveWeeklyPlanOwnerScope`,
  `:128-135`); an athlete outside that workspace refuses the whole request (`findAthleteOutsideScope`, `:145-152`,
  `:457-458`).
- **One weekly plan per athlete and week.** `ensureWeeklySlot` (`:3045-3071`) refuses the create (`409`, "Athlete X
  already has a weekly plan for that week.") when **any** active, non-edit-draft weekly plan of that athlete and week
  exists, whoever made it. The only exception: an **empty** Builder plan of the same coach is deleted first. So a
  batch create for N athletes fails as a whole if one of them already has a plan.
- **The Builder's athlete ids are not the calendar's.** The Builder takes `public.athletes.athlete_id` or
  `source_external_id` (`findAthlete`, `:3018-3024`); the calendar answers `public.athletes.id`, the UUID
  (`calendarQuery.js:206`, `:437`). The coach's roster (`state.athletes`, `routes/athletes.js:41`) carries both
  (`athlete_uuid` and `athlete_id`), so the frontend can map them for every athlete on the coach's roster.
- **Draft vs live.** A new plan is a draft until **Save and finish** (`builder-submit-plan`,
  `frontend/builder-actions.js:1387-1440`, `POST /plans/:id/submit`, `builder.js:502-605`). For a batch, the submit
  with `syncBatch` copies the open plan's content to its siblings and activates all of them in **one transaction**
  (`syncAndActivateBatchWithClient`, `:2074-2115`). An empty draft is deleted instead (`"Empty draft was not saved."`).
- **Edit drafts.** Opening a saved plan makes an edit draft (`POST /plans/:id/edit`, `:850-928`;
  `builder-actions.js:236`): a copy with `is_edit_draft = true` and the **same `logical_session_id`s**
  (`preserveLogicalId`, `:906`). Save applies it to the live plan in one transaction and keeps the logical ids
  (`applyEditDraft`, `:2117-2190`).
- **Apply changes to all athletes.** The checkbox (`builder-view.js:139-146`) adds `syncBatch` to every Builder write
  (`builder-actions.js:70-73`, `:97-99`, `:141-143`). **The server ignores it for an edit draft**:
  `wantsBatchSync` is false when `is_edit_draft` (`builder.js:1846-1851`), and `syncBatchFromPlan` returns at once
  for one (`:2041`). So **a published batch is edited one athlete at a time**: the switcher and the checkbox are drawn
  for an edit draft (the edit draft keeps `builder_batch_id`, `:894`; `loadBuilderBatch`, `:3073-3099`), but a change
  reaches only the athlete on screen.

  **Confirmed by a real run** (2026-11-19, investigation only, not committed: the e2e world on a disposable PostgreSQL
  16 database migrated to v81, the seeded team coach, the real routes over HTTP). Steps and statuses:
  `POST /api/builder/plans` (weekly, 3 athletes) 201 → `POST /blocks/:id/sessions` "Main" (syncBatch) 201 →
  `POST /sessions/:id/nodes` (syncBatch) 201 → `POST /plans/:id/submit` (syncBatch) 200 → `POST /plans/:id/edit` 200
  (an edit draft, `isEditDraft: true`, the switcher showing the 3 plans) → `POST /blocks/:id/sessions` "Added in edit"
  (syncBatch) 201 → `POST /sessions/:id/nodes` (syncBatch) 201 → `POST /plans/:draftId/submit` (syncBatch) 200. Then
  the three plans read from the database: athlete 1 (edited) active, sessions [Main, Added in edit]; athletes 2 and 3
  active, sessions [Main] only. **Athletes 2 and 3 did not get the session.** The open decision is Q3.
- **Logical session ids.** A batch's siblings get **their own** logical ids (a batch sync is "a genuinely different
  logical session", `:2175-2181`). So linking a batch's training means one logical id **per athlete**.

### 1.2 When a session can be linked

- Only a **live** session links: an active, non-edit-draft weekly plan (`WEEKLY_PLAN_SESSION_FILTER_SQL`,
  `trainingLoadAccess.js:239-244`, used by `readLinkableSessions`, `calendarEventService.js:1473-1511`). A draft or an
  edit draft answers `400 session_not_available`.
- A link is stored by **slot key** — plan, day, AM/PM, B/T/A, session order (`insertSessionLinks`, `:1535-1545`) —
  so it survives an edit draft's Save (same slot) and is reported as renamed or orphaned when the slot changes
  (`calendarQuery.js:1266-1272`).
- `judgeSessionsForLink` (`:1522-1533`) requires, under the plans' `FOR SHARE` locks (`:1460-1463`): every id
  available in the caller's calendar scope and of a plan **inside the event owner's tree** (`withinEventOwner`,
  `:1441-1455`); every session on one of the event's days; **every** session's athlete a target of the event that day
  (`athlete_not_targeted`, all-or-nothing); no live link of the slot to another event (`session_already_attached`).
  A slot already linked to this event is kept (idempotent, `:1654`).
- The attach (`attachSessions`, `:1620-1672`) also refuses `rpe_already_answered` (the event's own RPE question has
  answers) and `rpe_already_linked` (a manual RPE schedule is the event's channel, `:1894`), `event_cancelled` and `event_changed`
  (`requireOpenAndCurrent`, `:943-946`), takes `expectedRevision`
  (required, `revisionField`, `:195-199`) and at most 200 logical ids (`MAX_LINKED_SESSIONS`, `:1355`).
- Replay: every event command runs under `requestKey` (`runEventCommand`, `:719-…`): the same key and body replays
  the stored answer, so *Check result* never writes twice; a new key on the same sessions answers `alreadyAttached`
  (no second link).

### 1.3 Opening the Builder for N athletes and one week

For the event's athletes on its day (the card's `athleteIds`, `calendarQuery.js:1336-1340`) and the week of its day:

- **(a) They share one published weekly plan (one batch).** The live plans exist; opening one makes **one athlete's**
  edit draft, and edits do not reach the others (1.1). The Builder has no "edit the whole batch" today.
- **(b) None has a plan of that week.** `POST /plans` with all of them makes one draft batch; Save and finish
  publishes all, in one transaction. This is the clean case.
- **(c) Mixed.** Some have a plan (theirs alone, another batch, another coach's, a draft not yet saved), some none.
  A create naming all of them is refused by `ensureWeeklySlot`; only the athletes without a plan can be created as a
  new batch.
- **No read tells the frontend which case it is.** The calendar's planned cards name only live plans that have a
  session on that day (`calendarQuery.js:930-975`); a draft, an edit draft, or a live plan with no session that day
  is invisible to it. `GET /api/builder/drafts` (`builder.js:218`) lists only the caller's own drafts. Section 3
  proposes one small read.

### 1.4 Who may link

`runEventCommand` → `eventWriteBasis` (`calendarEventAccess.js:76-101`) and `calendar.lock_event_writer` (v49):

- **Club workspace:** the club's admin (or a platform admin) manages the club's events and its teams' events. Plans of
  the club or of its teams may be linked.
- **Team workspace:** the team's coach manages the **team's** events only; a club event (for example the club's
  match) is not theirs — the attach answers the identical `404`, and the panel already shows no link controls
  (`canManage` false, `central-calendar-view.js:900-901`). Plans of the team, or of its club, may be linked.
- **Private coach:** only their own (`user`) events and their own plans.
- **Platform workspace:** no event is created there (`403 workspace_required`).

K3 adds no right: the button is offered only where the panel is a manager's (`item.canManage === true`), and every
write is decided again by the server. A plan the coach makes in the Builder is owned by the **active workspace**
(1.1), which is exactly a scope `withinEventOwner` accepts for an event the same workspace manages. One trap: a club
admin in the **club** workspace planning a **team** event makes **club-owned** plans — accepted
(`withinEventOwner`, team owner ↔ club plan), but the team's coach then reads them only as the club's plan. Q5.

### 1.5 The draft ↔ event in memory and over a reload

- The Builder already holds K2c-2's panel state in `state.builder.calendarEvent` / `calendarEventsMade`
  (`state.js`, K2c-2 plan 2.6), reset by `resetBuilderCalendarEventForWorkspaceChange()` on a workspace switch, and
  `exitBuilderToPlanContext` resets `state.builder` entirely (`builder-actions.js:155-…`).
- Nothing of the Builder survives a reload except the server's drafts. A K3 context therefore needs its own small
  memory (3.2).
- Writes that may be lost already have a home: the calendar's memory of unconfirmed writes
  (`rememberCentralCalendarCreate`, `central-calendar-actions.js:335-338`) with its `beforeunload` and sign-out guards
  (K2c-2-F, "Leaving"). K3's attach joins the same memory.

### 1.6 Back and the return context

- Today a tab change pushes one app-history step (`pushAppHistory`, `app.js:2155-2159`); `handleAppBack`
  (`:2213-2306`) closes layers, then falls back to the root tab (`coach-home`). Back from the Builder therefore does
  not return to the calendar today.
- Another executor is fixing Back app-wide (K4-0). **This plan assumes its history stack:** entering the Builder from
  the calendar pushes one step, and Back (the browser's and the app's) returns to the calendar on the same day with
  the event's panel open (`openCentralCalendarAt({ date, key })`, `central-calendar-actions.js:342-354`).
- *Open in calendar* from the Builder already exists (`openCentralCalendarFromBuilder`, `app.js:4210-4216`); it
  restores the calendar's own panel state when the tab change is refused by a leave guard.

## 2. The UI contract

### 2.1 The calendar's button

In the event's panel (`renderEventActionsHtml` / `renderEventLinksHtml`, `central-calendar-view.js:900-1010`), for a
manager (`canManage`), a planned (not cancelled) event whose type is a training (`eventKind === "training"`, Q2):

- **No linked training** → primary button **Plan the training**, at the top of the "Linked trainings" section.
- **Linked trainings exist** → **Open the training** (secondary), beside the linked list. It opens the Builder the same
  way, with the linked sessions already in the event.
- Off (with the panel's other buttons) while any link, question or event write is in flight or not confirmed (one
  control at a time, the K2c-1 rule).
- The press reads what 1.3 needs (3.1), never writes, and shows "Opening the Builder…" in the button.

### 2.2 What opens (cases a / b / c)

The press reads the event's athletes of that day (the card's `athleteIds`) and their weekly plans of the week (3.1).

| Case | What the coach sees | Buttons |
|---|---|---|
| **(b) none has a plan** | Nothing first: the Builder opens a new weekly plan for all of them (one batch), named after the event ("Training · Mon 12.10"). | — |
| **(a) all share one batch (live)** | A short sheet: "18 athletes already have this week's plan. Changes you make go to the athlete on screen only; use *Next athlete* to change the others." | **Open the plan** · Cancel |
| **(a′) all share one draft batch (not saved)** | Nothing first: that draft opens. | — |
| **(c) mixed** | A sheet: "12 athletes have no plan for this week. 6 already have one: Ana K., Ben D., … (and 2 more)." | **Plan for the 12** (primary) · **Open an existing plan** (a list of the 6, one opens) · Cancel |
| **an athlete you can't plan for** (not on your roster, or outside this workspace) | One line under the counts: "2 athletes of this event aren't in your workspace; plan their training in their own workspace." | — |
| **nobody can be planned** | "None of this event's athletes can be planned from this workspace." | Close |

The counts and names are the read's; nothing is created by the sheet. *Plan for the 12* sends one create (the
Builder's own `POST /plans`); its `409` (someone made a plan meanwhile) reads the plans again and redraws the sheet.

### 2.3 The band

```
┌──────────────────────────────────────────────────────────────────────┐
│ ● Training · Mon 12.10 · 10:00 · Stadium · 18 athletes                │
│ Sessions on this day go into this event.        [Back to calendar]    │
└──────────────────────────────────────────────────────────────────────┘
```

- At the top of the Builder, above the plan header; the event type's colour as a left bar and a dot, with its icon,
  so the state is never colour alone. `role="region"`, `aria-label="Planning for event <title>"`.
- The event's day is scrolled into view and its label carries "In this event".
- **Back to calendar** = the app's Back (2.6). On a phone it is a 44 px button on its own row under the title line.
- The band lives as long as the Builder shows a plan of this K3 context (3.2). Opening another plan, *New plan*, or a
  workspace switch ends it.

### 2.4 Sessions in and out of the event

- Every session on the event's day (each of its days for a multi-day event) **that fits the event's half of the day**
  (O15, 7.2) is **in the event** by default and shows a small chip "● In this event" in the event's colour on its
  row. A session of the other half shows "Outside the event (PM)" and is not linked.
- New sessions added on that day in K3 take the event's half (`amPm`): AM for an event starting before 12:00, PM from
  12:00; an event running across 12:00, or without a time, leaves the Builder's default.
- The chip is a toggle: **Not in this event** takes the session out (the chip turns to a grey "Not in this event"
  with *Put back*). One tap, no question (nothing is written until Save).
- Sessions on other days of the week show nothing.
- The choice is kept per session by its slot and name (AM/PM, B/T/A, trimmed lower-case name: the D16b key), not by
  the draft's row id, because an edit draft's ids change on Save (1.1).
- **Time (O12, amended by O14).** A session in the event needs no time: with none it shows "10:00 · from the event".
  It may have its own time, but only inside the event's start–end (section 7.1).

### 2.5 Save and link

**Save and link** replaces the Builder's check button while the band is shown (label words, not an icon only:
"Save and link"). One press runs, in order:

1. The Builder's own Save and finish (the queued saves flushed first, `builderSavesSettled()`). A failure is the
   Builder's own error, and **nothing is linked**: "The plan wasn't saved, so nothing was linked to the event."
2. A fresh read of the event's day(s) (`GET /api/calendar?from=D&to=E&include=athletes`), and the match: the planned
   cards whose `athletes[].planId` are this batch's live plans and whose slot and name are a session marked **in this
   event** (the K2c-2 rule `builderCalendarMatch`, extended to the batch). Their `logicalSessionIds` together.
3. One attach `POST /api/calendar/events/:eventId/sessions` with those ids, the event's `expectedRevision` from the
   same read, a new `requestKey`, `alignSessions: true` when the event expects RPE (Q4). More than 200 ids → several
   attaches of up to 200 in order, each its own key (an event of 70+ athletes with three sessions).

The outcomes (one sentence, one next step; never an id or a code for a coach):

| Outcome | Sentence | Next |
|---|---|---|
| Saved and linked | "Saved. 3 sessions for 18 athletes are in Training · Mon 12.10." | **Back to calendar** (primary) · Keep editing |
| Saved, nothing to link (every session taken out) | "Saved. No session was put in the event." | Back to calendar |
| Saved, the session not found on the calendar | "Saved, but the training isn't on the calendar yet, so it wasn't linked." | **Try linking again** · Back to calendar |
| Saved, link refused | The K2c-1 sentence of the code (`central-calendar-links.js:244-270`), e.g. "Some athletes of this training are not part of this event. Add them to the event first, or link another training." `event_changed` reads the event again and retries once by itself (the revision is not the coach's choice). | **Try linking again** · Back to calendar |
| Saved, link not confirmed (lost answer, 5xx, timeout) | "Saved. We couldn't confirm the link." · "Checking never links twice." | **Check result** (same body and key) |
| Not saved | "The plan wasn't saved, so nothing was linked to the event." | **Try again** |
| Save not confirmed | The Builder's own error today (the button comes back); K3 adds: "If the plan was saved, link it from the event in the calendar." | Try again · Back to calendar |

**Never a double link:** the attach is idempotent per slot and replays per key (1.2); *Try linking again* uses a new
key and answers `alreadyAttached` for anything already in.

The attach is remembered in the calendar's memory of unconfirmed writes from the moment it is sent (as K2c-2-F's
create), so its `beforeunload`, sign-out and app-update guards cover it, and a lost answer can be checked later from
the event's panel.

### 2.6 Leaving

- **Back to calendar / the app's Back**, with unsaved Builder changes: the Builder has no unsaved state of its own
  (every edit autosaves to the draft), so leaving needs no question; the draft stays in "Drafts" and the K3 context
  is kept (3.2), so reopening it from the event shows the band again.
- **While Save and link is running:** Back is held ("Saving and linking…"); the Builder is `inert` as for Save today
  (`app.js:4186-4190`).
- **An attach not confirmed:** leaving the Builder is allowed; the calendar's memory keeps it, and the event's panel
  shows *Check result* (K2c-1's existing row).
- Back always lands on the calendar, the event's day, its panel open (`openCentralCalendarAt({ date, key })`), and
  the calendar re-read (`invalidateCentralCalendarCache`).

### 2.7 Phones (360 / 375 / 390 px)

- The band: two lines (title line wraps; *Back to calendar* full width under it), sticky at the top under the app
  bar, never covering the session row being edited (the page scrolls under it, 12 px gap).
- The sheets of 2.2 are bottom sheets (the calendar panel's own sheet pattern), the page behind does not scroll.
- The "In this event" chip is a 44 px target, words always shown.
- Save and link stays in the Builder's bottom bar where the check button is today.
- Inputs 16 px; no horizontal scroll; checked in Chromium at 1280, 390, 375 and 360 px.

### 2.8 English copy (the full list for the code)

- Calendar: "Plan the training" · "Open the training" · "Opening the Builder…"
- Band: "Sessions on this day go into this event." · "Back to calendar" · "In this event" · "Not in this event" ·
  "Put back"
- Sheets: "N athletes already have this week's plan. Changes you make go to the athlete on screen only; use *Next
  athlete* to change the others." · "N athletes have no plan for this week. M already have one: …" · "Plan for the N"
  · "Open an existing plan" · "N athletes of this event aren't in your workspace; plan their training in their own
  workspace." · "None of this event's athletes can be planned from this workspace."
- Save: the sentences of 2.5.

## 3. Backend need

### 3.1 One small read (no migration)

`GET /api/builder/weekly-plans?weekStart=YYYY-MM-DD&athleteIds=<uuid,…>` (at most 200), for a coach in a club, team
or private-coach workspace. Per athlete: `{ athleteId, plannable, plan: null | { planId, status: "draft" | "active",
batchId, mine, editable, openDraftId } }`.

- `plannable` = the athlete is in the active workspace's scope (`isAthleteInWorkspaceScope`, the create's own rule) and
  active.
- `plan` only for a plannable athlete; `editable` by `getEditablePlan`'s predicate (`builder.js:2763-2785`);
  `openDraftId` the caller's own edit draft of it, if any.
- **Info-hiding (flag for `security-reviewer`):** an athlete outside the scope answers `plannable: false` and nothing
  else — never whether they have a plan. For a plannable athlete, `ensureWeeklySlot`'s `409` already tells the coach
  that a plan exists whoever made it; the read says no more than that for a plan the coach cannot edit
  (`{ editable: false }`, no id, no name, no creator).
- Without it, the frontend would guess cases a/b/c from the calendar's planned cards, which never show a draft, an
  edit draft or a live plan without a session that day (1.3). Q1.

### 3.2 Nothing else on the server

- The link is the existing attach; the plan is the existing create / submit. **No migration.**
- The two steps (save, then attach) are **not one transaction**. Making them one (a `calendarEventId` on the submit)
  would take the plans `FOR UPDATE` and then the event writer's locks, the reverse of the attach's order (event, then
  plans `FOR SHARE`, `calendarEventService.js:1640-1645`): a lock-order inversion and an external-review trigger 4.
  Not proposed. The contract makes the gap visible instead (2.5: "Saved, … wasn't linked" with *Try linking again*).
- The K3 context in the frontend: `state.builder.k3 = { eventId, eventKey, date, endDate, title, typeColor, typeIcon,
  athleteIds, batchPlanIds, outKeys }`, and a copy in `sessionStorage` (`optimove.k3.<userId>.<planId>`, wrapped in
  try/catch, ids and slot keys only, no names) so a reload into the same draft shows the band again after the event is
  read back (`GET /api/calendar/events/:id`); a 404 there drops it silently.

## 4. Questions: decided by the stream manager (2026-11-19), and Q3 open for the owner

The stream manager decided Q1, Q2 and Q4–Q7 as recommended; the owner decides Q3 only. The text below keeps each
question with its options for the record.

- **Decided:** Q1 the read route is added; Q2 training-kind events only; Q4 RPE is aligned on link; Q5 accepted, with
  the band line "This plan belongs to the club."; Q6 sessions are in the event by default; Q7 one button, *Save and
  link*.
- **Open (the owner): Q3.** The fact is now proven by a run (1.1): an edit of a published batch reaches only the
  athlete on screen, although the Builder shows the batch switcher and *Apply changes to all athletes*.

- **Q1 — The read of 3.1.** Add the small read route (recommended), or open the Builder for case (b) only and send
  every other case to the existing Builder with a sentence. Recommend the route: cases (a) and (c) are the coach's
  ordinary week (a plan already made, a match added later).
- **Q2 — Which events get the button.** Training-kind types only (recommended), or every type (a match day's warm-up,
  a camp). Recommend training only for K3; a match's MD-1 / MD+1 is K4 plan P4.
- **Q3 — A published batch (case a).** Today a change reaches one athlete at a time (1.1). Options: (i) K3 says so in
  the sheet and lets the coach step through athletes (recommended for K3: no server change); (ii) a later Builder task
  "edit the whole batch" (syncing edit drafts across a batch), which is its own contract with migration-free but
  transaction-heavy backend work. Recommend (i) now and (ii) as a named follow-up if the pilot asks.
- **Q4 — RPE on link.** When the event expects RPE, align the linked sessions (`alignSessions: true`, recommended;
  the event is the coach's statement of what is collected), or link without aligning and leave K2c-1's *Ask RPE in the
  linked trainings* row. Recommend align; a session with results is never turned off without the existing question.
- **Q5 — A club admin planning a team's event.** The plans are the club's (the active workspace owns them). Accept
  (recommended: the link is allowed and the team's coach still sees the training), or ask the admin to switch to the
  team's workspace first. Recommend accept, with one line in the band: "This plan belongs to the club."
- **Q6 — Default in or out.** Every session of the event's day is in by default (recommended: the owner's "sessions you
  add on this day go into this event"), with *Not in this event* per session.
- **Q7 — Save and link as one button.** Recommended; the alternative (Save, then a separate *Link to event*) is two
  presses for the main path.

## 5. (K3) Reviews

See section 8: K3 and K2c-3 are reviewed and ordered together.

## 6. K2c-3: from the Builder to the calendar's own form, and the Event selector (O8, O10–O13)

It replaces K2c-2's inline *Make an event* panel (`frontend/builder-calendar-event*.js`, K2c plan 2.6). The app keeps
**one** event form, the calendar's (`frontend/central-calendar-event-form.js`).

### 6.1 Discovery (what K2c-3 reuses)

- **The calendar's create form** is `newCentralCalendarCreateForm({ day, owner, types, targets, catalog })`
  (`central-calendar-event-form.js:113-124`), opened by the calendar's own *New event* handler
  (`central-calendar-actions.js:715-737`). It already takes **prefilled targets**, any of `athlete` / `team` / `club`
  (`setCentralCalendarFormTarget`, `:397-404`); the request is built by `buildCentralCalendarEventRequest`
  (`:240-310`) and sent by the form's one write path with its `requestKey`, its *Result not confirmed* and the
  calendar's memory of unconfirmed creates (`:960-1000`). It has no `sessions` field today; K2c-2-F built its own body
  for that (K2c plan 2.6).
- **The create can link in the same transaction** (K2c-2-B, `createSessionsField`, `calendarEventService.js:259-271`,
  judged by the same `judgeSessionsForLink`, `:871`). So "create from this session" can be one request when the
  session is live.
- **The week's events for the plan's athletes:** `GET /api/calendar?from=&to=&kinds=event,planned&athleteIds=…`
  (`routes/calendar.js:69-95`). An event card carries `canManage`, the type's colour and icon, time and place, and —
  for a manager only — `links.planIds` / `links.logicalSessionIds` (`calendarQuery.js:1319-1384`). A reader gets no
  links.
- **Which session is in which event:** the manager's event view (`GET /api/calendar/events/:id`) lists every live link
  with `planId`, `day`, `amPm`, `bta`, `order`, `sessionName`, `logicalSessionId`, `athleteId` and the link `id`
  (`linkFacts`, `calendarEventService.js:463-490`). That is enough to place each Builder session (slot + name, the
  D16b key) and to unlink it (`POST …/sessions/detach` with `linkIds`, `:1682-…`).
- **A session linked to an event the coach does not manage** (a team coach and the club's match) is folded under that
  event and is not a planned card any more, while the coach's read gets no links of it. It is recognised by
  elimination: a live session of this plan on that day that is neither a planned card nor in a managed event's links
  is "in an event you don't manage".
- **Athlete ids:** the Builder's batch names athletes by `athlete_id` / `source_external_id`
  (`loadBuilderBatch`, `builder.js:3073-3099`); the calendar wants UUIDs. `state.athletes` maps them
  (`athlete_uuid`, `routes/athletes.js:41`), as in 1.1.

### 6.2 The day's events row

```
Builder · MONDAY 12.10.2026                                   MD-1
Events:  [● Training 10:00 · Stadium]  [🔒 Match 18:00]   [Create event →]
Whole day: [ Training 10:00 ▾ ]
──────────────────────────────────────────────────────────────
Before training · Mobility & stability   Event: [Training 10:00 ▾]
Training · Main session                  Event: [Training 10:00 ▾]
After training · Recovery                Event: [ No event     ▾]
```

- Shown only on a **weekly** plan in a club, team or private-coach workspace (K2c-2's own rule, `builder-calendar-event.js`).
- One read per opened week (6.1), plus one manager-view read per managed event that holds a session of this plan;
  a generation counter drops a slower, older answer. A failed read: "Events could not be loaded." with *Try again*;
  the Builder works as today.
- Chips: the type's colour **and** icon, the time, the place; a lock and "Managed by the club" for an event the coach
  cannot manage. Pressing a chip opens the event in the calendar (`openCentralCalendarAt({ date, key })`), and Back
  returns to the Builder (K4-0).

### 6.3 Create event →

- Opens the calendar tab with the calendar's form, prefilled: the day; the first `training`-kind type; the title (the
  session's name when started from a session, else "Training"); the start time (the session's time, if it has one);
  the targets = the plan's athletes (`kind: "athlete"`, mapped to UUIDs), or the team when every athlete of the batch
  is the team's (one chip instead of 18; Q8).
- A band over the form: "Creating an event for the Builder · Monday 12.10 · [Back to the Builder]".
- **Save** is the form's own write. When started from a session that is **live** (a saved plan, the session not
  changed since: K2c-2's match, `builderCalendarMatch`), the body also carries `sessions.logicalSessionIds` of that
  session for all the batch's athletes, so the event is made and the session linked in **one** request. Otherwise
  the event is made alone and the session chooses it on return.
- **After Save** (confirmed): back to the Builder, the new event in the day's row, chosen for the starting session.
  **Back / Back to the Builder** with nothing sent: back to the Builder, nothing made.
- **Not confirmed:** the form's own *Result not confirmed* · *Check result* stays in the calendar; *Back to the
  Builder* is allowed and the create stays in the calendar's memory (as K2c-2-F does today).
- The one frontend change to the form: an optional `form.returnTo = { tab: "builder", planId, sessionKey }` and an
  optional `form.linkSessions` (logical ids) added to the create body. Nothing of the form changes for a coach who
  opens it from the calendar.

### 6.4 The Event selector

- On each session's top line (O7), right of its name: **Event: [ … ▾ ]** — the day's managed events of the
  session's half of the day (O15, 7.2), and *No event*. A non-managed event is listed with its lock and is not choosable ("Linked by the club's admin from the
  calendar.").
- **Choosing an event** sends one attach (`POST /api/calendar/events/:id/sessions`) with the session's logical ids for
  every athlete of the batch (from the day's planned card) and the event's `expectedRevision`; `alignSessions` as Q4.
- **Choosing No event** sends one detach with the link ids of that session's slot (from the manager view, 6.1).
- **Changing from event A to event B** is a detach from A, then an attach to B — two writes, not one transaction. If
  the second fails: "Taken out of A, but not put in B." with *Try again* (attach only). Q9 offers the alternative.
- **Whole day** (O10, „ili taj dan"): one attach with every live session of that day; a session can still choose
  differently afterwards. It never moves a session out of another event silently: a session already in another event
  is left there and named ("After training stays in Recovery 17:00.").
- Every write: a `requestKey`, one control at a time (the whole events row is off while one is in flight or not
  confirmed), *Result not confirmed* · *Check result* with the same body and key, the day read again after a confirmed
  write; the refusals read as K2c-1's sentences (`central-calendar-links.js:244-270`).
- **Only a live session can be chosen** (1.2). On a never-saved draft or an edit draft with changes, the selector and
  *Create event →* ask once: "This plan isn't saved yet. Save it (the athletes will see it) and continue?" with
  **Save and continue** / Cancel. The save is the Builder's own Save and finish, waited for; a failed or unconfirmed
  save goes nowhere. Save and finish leaves the Builder today (`exitBuilderToPlanContext`,
  `builder-actions.js:155-…`); here it must **stay** in the Builder on the saved plan (Q10).
- **An edit draft that moves a linked session's slot** (B → T, AM → PM) or renames it would leave the link pointing at
  the old slot (orphaned or renamed, 1.2). The selector shows "Saving moves this session out of Training 10:00." on
  such a session before Save; after Save it is shown as *No event* with *Put back* (one attach).

### 6.5 Day and time (O11, O12)

- Only that day's events are listed (the server refuses another day anyway: `session_outside_event`). A multi-day
  event (a camp) is listed on each of its days.
- The time follows section 7.1 (O14): no time = the event's time ("10:00 · from the event"); an own time only inside
  the event's start–end. Changing the event's time is done on the event: the chip opens it in the calendar.
- Before / Training / After stay the order inside the event.

### 6.6 Phones (360 / 375 / 390 px)

- The events row wraps; chips 44 px; *Create event →* full width under the chips.
- The selector is a native `select` (16 px), on its own line under the session name.
- The calendar form with its band is the calendar's existing sheet below 1024 px.

### 6.7 English copy

"Events:" · "Create event →" · "Whole day:" · "Event:" · "No event" · "Managed by the club" · "Linked by the club's
admin from the calendar." · "Creating an event for the Builder · <day> · Back to the Builder" · "This plan isn't saved
yet. Save it (the athletes will see it) and continue?" · "Save and continue" · "Taken out of <A>, but not put in
<B>." · "<session> stays in <event>." · "Saving moves this session out of <event>." · "10:00 · from the event" · "The
event's time 10:00 is used." · "Events could not be loaded."

### 6.8 Backend need

None. The create (with `sessions`), attach, detach and the two reads exist. **No migration.**

### 6.9 Questions: Q8–Q11 decided by the stream manager (2026-11-19); Q12, Q13 open

- **Decided:** **Q8** prefill a team target when the batch's athletes are exactly the team's current members,
  otherwise athlete targets; the coach can edit it in the form. **Q9** a move is two writes (detach, then attach),
  with the partial outcome shown. **Q10** yes, a Save that stays in the Builder. **Q11** K2c-2's per-session panel is
  retired (O10: one event form).
- The time rule of section 7 (read the event's time, the `linkedSessionTimes` helper, no copy) is accepted by the
  stream manager, with O14 (7.1) and O15 (7.2).
- The record of each question with its options follows.

- **Q8 — Targets of a created event.** The team when every athlete of the batch is the team's, else the athletes one
  by one (recommended: a team target follows the roster as it changes); or always the athletes. Note: a team target
  also reaches team members who are not in this plan; the attach still requires every linked session's athlete to be
  a target, which holds either way.
- **Q9 — Moving a session from one event to another.** Two writes, shown honestly (recommended, no backend), or a new
  "move" route in one transaction (backend, lock-order review). Recommend two writes; moves are rare.
- **Q10 — Save and continue stays in the Builder.** Recommended: a flag on the Builder's own submit so it reloads the
  saved plan (`POST /plans/:id/edit` on the live id) instead of exiting. The alternative (exit, then the coach reopens
  the plan) breaks the flow the owner asked for.
- **Q12 — O14 with an event that has no end.** "Inside the start" read as: the session's time is not before the
  event's start (recommended; a session after the start, e.g. the recovery at 11:30, is allowed), or the session's
  time must equal the start. The owner's words name only the start; the stream manager decides.
- **Q13 — The calendar's panel mark.** The manager event view (`linkFacts`) would carry each link's session time so the
  panel can show "Outside the event's time" there too (a small backend read change, no migration), or the mark is in
  the Builder only (recommended for the first step: nothing on the server).
- **Q11 — K2c-2's per-session panel.** Removed when K2c-3 lands (recommended: one form in the app, O10). Its pure
  match (`builderCalendarMatch`) and its tests are reused.

## 7. Where a linked session's time is read

**Today.** Every reader takes the session's own `session_time`:
- the Weekly plan and Athlete Home, through `plans.v_weekly_plan_items` (`migrations_v2/202608231700_…sql:87`, `:172`)
  and `buildWeeks` (`backend/src/utils/grouping.js:26`, `sessionTime`), in four routes: `routes/athletes.js:276-…`
  (`loadWeeklyData`), `routes/plans.js:11-…` (`/:planId/weekly`), `routes/athleteHome.js` and `routes/trainingLoad.js`;
- the calendar's planned card (`calendarQuery.js:946`, `:963`); the coach's calendar already shows a linked session
  under its event, so it already shows the event's time;
- the athlete's calendar folds nothing today (`coachView`, `calendarQuery.js:875-888`); K4a folds it, and then the
  event's time is shown.

**The rule (O14, the owner, amending O12): a linked session shows its own time when it has one, otherwise the event's
start time (and end time, when set). Never a copy.**
- **How:** one shared helper in the backend, `linkedSessionTimes(queryable, rows)`: one query of the live
  `calendar.event_session_links` of the rows' plans and days, joined to `calendar.events` (planned, not cancelled),
  matched by the slot key (plan, day, AM/PM, B/T/A, order), returning the event's time per row; the four routes call
  it after their `select` and before `buildWeeks`, which uses it only for a row without its own `session_time`.
  **No migration** (the view is not changed).
- **Rights:** the time of an event is shown only on a session the reader may already see, and only while the
  session's athlete is still a target of the event that day (the same `targetsAthleteSql` rule as the link,
  `calendarEventService.js:1426-1431`); otherwise the session's own time is shown. A cancelled event's time is never
  used. Flag for `security-reviewer`: an athlete must not learn a time of an event they are no longer part of.
- **Cost:** one indexed query per weekly read (`event_session_links_plan_idx` and the live slot unique index, v49 `:517-522`), four call sites, one helper
  with its tests on a disposable database (linked / unlinked / cancelled / not targeted any more / two athletes in one
  slot / an edit draft, which has no links). About a day's work; backend ★ with `code-reviewer` + `security-reviewer`.
- **The alternative, a copy** (writing the event's time into `session_time` on link and on every event time change):
  no reader change, but two sources that drift (an event edited while a link is being made, an edit draft that still
  holds the old time and writes it back on Save, `applyEditDraft`). Not recommended.
- **What the Builder shows:** 2.4 / 6.5 / 7.1, from the week's read it already has.

### 7.1 O14: a session's own time inside the event (the owner, 2026-11-19, K4 plan `5231db4d`, 5.2 point 9)

The window is the event's `startTime`–`endTime` on that day. When the event has no end, only its start bounds it: the
session's time is not before the start (Q12 records the reading). An event without a start time (a whole-day event)
sets no window.

- **The Builder refuses a time outside the event.** The session's time input, while the session is in an event (or
  chosen for one), checks the window on change: "The training is 10:00–11:30, so this session's time must be in it."
  The field keeps the old value; nothing is sent.
- **A session with an outside time can't join.** The selector (6.4), *Whole day* and K3's *Save and link* refuse it
  before any request: "Main session is at 08:00, outside the event (10:00–11:30). Change its time first." with
  **Use the event's time** (clears the session's own time, one Builder PATCH) and Cancel. *Whole day* links the others
  and names the one left out.
- **The event moves later.** When the day's read shows a linked session whose own time is outside the event's
  window, its line shows "Outside the event's time" (a glyph and the words, never colour alone) with **Use the
  event's time**. Nothing is changed by itself. The calendar's event panel shows the same mark on that linked session
  (from the manager view, which then needs the session's time: Q13).
- **Use the event's time** clears the session's own time (`PATCH /api/builder/sessions/:id` with an empty time), so it
  follows the event from then on; it does not copy the start into the session.
- **Readers:** the session's own time when set, else the event's (section 7). The Weekly plan and the athlete's
  calendar therefore never show a time the coach did not see in the Builder.

**Cost.**
- **Frontend (Builder):** one pure check `sessionTimeFitsEvent(time, event)` with its sentence, wired into the time
  input, the selector, *Whole day* and K3's *Save and link*; the "Outside the event's time" mark and *Use the event's
  time* (one PATCH through the existing queued Builder write). The event windows come from the week's read K2c-3
  already makes. About half a day with tests (in / out / no end / no start / exactly the start or end / an edit draft
  of a live session).
- **Backend:** none beyond section 7's helper, which becomes simpler (only rows without their own time ask for the
  event's).
- **Not enforced by the server.** The attach and the session PATCH do not check the window; another device, an old
  tab or a direct API call can store an outside time. That is the case the "Outside the event's time" mark shows, so
  nothing wrong is hidden; a server check would be a change of the attach and of the Builder's session PATCH (their
  locks and refusals), not recommended for now (O13).
- **Time zones:** a session time is a wall-clock time without a zone; the event carries its own zone (K2b-1d3). The
  check compares wall-clock times on the event's day; an event whose zone differs from the coach's is rare and is
  shown with the event's zone in the sentence. Recorded, not solved.

### 7.2 O15: AM / PM fits the event's half of the day (the owner, 2026-11-19, K4 plan `dc360d09`, 5.2 point 9)

A session keeps Before / Training / After and AM / PM as today. Its AM / PM must fit the event's half:

- **The event's half:** a start before 12:00 is AM; a start from 12:00 is PM; an event whose start is before 12:00 and
  whose end is after 12:00 covers both. An event with no time sets no limit. A multi-day event is judged per day by
  the same times (its start on its first day; whole days in between and its last day's end are read as covering
  both — recorded with Q14).
- **A session without AM / PM** (the Builder's empty choice) fits any half.
- **The selector and *Whole day*** list only the events of the session's half; *Whole day* links the sessions that
  fit and names the others ("After training (PM) stays out: the event is in the morning.").
- **K3** adds new sessions in the event's half (2.4) and leaves a session of the other half out of *Save and link*,
  naming it in the outcome.
- **The "Outside the event" note** covers both checks: "Outside the event's time" (O14) and "Outside the event's half
  of the day" — with **Use the event's time** for the first, and **Move to AM** / **Move to PM** for the second (one
  Builder PATCH of `amPm`; on a live plan that is an edit draft and its Save, 1.1). Nothing is changed by itself.
- **A linked session whose half changes** (an edit draft that moves AM → PM) also moves its slot, so the link would be
  left on the old slot (1.2, 6.4): the same warning as there, "Saving moves this session out of <event>."

**Cost.** Frontend only: a second pure check `sessionHalfFitsEvent(amPm, event)` beside `sessionTimeFitsEvent`, used by
the same four places (the selector's list, *Whole day*, K3's default and *Save and link*, the note), and the
*Move to AM / PM* action. A few hours with tests (before 12:00, exactly 12:00, across 12:00, no time, no half, a
multi-day event). The server does not check the half; the note shows a session stored otherwise. No migration.

- **Q14 — A multi-day event's half.** The first day by its start, the middle days and the last day as both halves
  (recommended), or every day by the start time only. The stream manager decides.

## 8. Reviews and order

UI contract GO first. Then, as separate pull requests:
1. **K3's read route** (3.1; ★, `code-reviewer` + `security-reviewer`, disposable-database tests of scope,
   info-hiding and the 200 cap).
2. **The linked-session time** (section 7; ★, `code-reviewer` + `security-reviewer`). Independent of the screens; it
   can go first.
3. **K3's screens** (sections 2.x) and **K2c-3's screens** (section 6), together or K3 first. Both reuse the band,
   the return context and the calendar's memory of unconfirmed writes. Reviews: `code-reviewer`,
   `ux-design-reviewer`, `mobile-qa`; the Frontend PR gate; browser checks at 1280 / 390 / 375 / 360 px through the
   e2e world.

K3 and K2c-3 wait for K4-0's Back to merge, since 2.6 and 6.2–6.3 rely on its history stack.
