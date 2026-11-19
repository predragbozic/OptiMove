# Central calendar — K3 plan: plan the training from an event

Status: **Proposed** (2026-11-19, written against `main` `f406ee2d`). Discovery and UI contract only: no code, no
migration. It needs the manager's GO, and the owner's answers to section 4, before any code.

The owner's goal (O9 of `docs/ai/central-calendar-k4-plan.md`, 2026-11-19): „iz glavnog kalendara je lako kada
ulazimo iz dogadjaja u builder pa kreiramo aktivnosti unutar tog dogadjaja". The coach opens an event, presses
**Plan the training**, and the Builder opens on that day for the event's athletes, with a band naming the event and
**Back to calendar**. The sessions added on that day (Before / Training / After) belong to the event. Saving saves
the plan and links the sessions. Back returns to the event.

Read with: the K4 plan, sections 0, 5.1, 5.2 and 6 (branch `claude/central-calendar-k4-plan`); the K2c plan,
sections 1 (K2c-1), 2 (K2c-2) and 3 (K3, named only).

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
  reaches only the athlete on screen. This is read from the code, not run; the first K3 test pins it (or the owner
  decides it is a bug to fix first, Q3).
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

- Every session on the event's day (each of its days for a multi-day event) is **in the event** by default and shows
  a small chip "● In this event" in the event's colour on its row.
- The chip is a toggle: **Not in this event** takes the session out (the chip turns to a grey "Not in this event"
  with *Put back*). One tap, no question (nothing is written until Save).
- Sessions on other days of the week show nothing.
- The choice is kept per session by its slot and name (AM/PM, B/T/A, trimmed lower-case name: the D16b key), not by
  the draft's row id, because an edit draft's ids change on Save (1.1).

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

## 4. Open questions (each with a recommendation)

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

## 5. Reviews and order

UI contract GO first. Then: the read route (★, `code-reviewer` + `security-reviewer`, disposable-database tests of
scope, info-hiding and the 200 cap); the frontend (`code-reviewer`, `ux-design-reviewer`, `mobile-qa`; the Frontend PR
gate; browser checks at 1280 / 390 / 375 / 360 px through the e2e world). K3 waits for K4-0's Back to merge, since
2.6 relies on its history stack.
